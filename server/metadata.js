const fs = require('fs');
const path = require('path');
const { DATA_PATH, getTmdbApiKey } = require('./config');

const METADATA_FILE = path.join(DATA_PATH, 'metadata.json');
// Claves corregidas a mano con overrideFromTmdb (id de TMDB conocido, a
// veces con temporada concreta porque su carátula difiere de la del show
// en general - el caso de ".hack//Sign"): se recuerdan aparte y para
// siempre, para que una búsqueda automática posterior (refreshMetadata,
// forceTmdbRefreshAll...) no las vuelva a pisar con un resultado
// "parecido" pero equivocado.
const OVERRIDES_FILE = path.join(DATA_PATH, 'metadata-overrides.json');

let cache = loadCache();
const pending = new Map();
// Cuándo falló por última vez cada clave (p.ej. Jikan caído/504), para no
// reintentarla en cada pasada de warmAll: sin esto, un reescaneo automático
// (dispara uno cada vídeo que termina de convertirse y sustituye al
// original) reiniciaba warmAll desde el principio de la lista una y otra
// vez, y como las primeras claves seguían fallando, nunca se llegaba a
// comprobar el resto de la biblioteca.
const failedAt = new Map();
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(METADATA_FILE, JSON.stringify(cache, null, 2));
}

function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveOverrides() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
}

let overrides = loadOverrides();

// Para POST /api/admin/reload (ver adminReload.js): recarga metadata.json
// desde disco por si algo lo editó por fuera de este proceso (migración,
// restauración de backup - el bug real que motivó esta función: una
// carátula se sirvió como null tras editar metadata.json a mano sin
// reiniciar). Si una clave que antes fallaba ahora ya tiene metadata en el
// archivo recargado, se olvida su cooldown de fallo - si no, seguiría
// ignorada hasta que expirase solo.
function reloadCache() {
  cache = loadCache();
  for (const key of failedAt.keys()) {
    if (cache[key]) failedAt.delete(key);
  }
}

// Separado de reloadCache a propósito: metadata.json y metadata-overrides.json
// tienen dueños y frecuencias de cambio distintas.
function reloadOverrides() {
  overrides = loadOverrides();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Todas las peticiones a fuentes externas pasan por esta cola, para no
// disparar ráfagas en paralelo y evitar 429 (rate limit). Tiene dos carriles:
// las peticiones "high" (lo que el usuario está viendo ahora) se atienden
// antes que las "low" (el precalentamiento en segundo plano de toda la
// biblioteca), para que navegar por el catálogo no se quede esperando
// detrás de cientos de series que nadie ha pedido todavía.
const highQueue = [];
const lowQueue = [];
let draining = false;

async function drainQueue() {
  if (draining) return;
  draining = true;
  while (highQueue.length || lowQueue.length) {
    const task = highQueue.length ? highQueue.shift() : lowQueue.shift();
    // eslint-disable-next-line no-await-in-loop
    await task();
  }
  draining = false;
}

const FETCH_TIMEOUT_MS = 8000;

// Una petición colgada (sin responder nunca) bloquearía la cola entera para
// siempre, ya que nada más se procesa hasta que termina la actual. Por eso
// todas las peticiones llevan un límite de tiempo.
function fetchWithTimeout(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function throttledFetch(url, options, minIntervalMs = 350, priority = 'low') {
  return new Promise((resolve, reject) => {
    const task = async () => {
      try {
        let res = await fetchWithTimeout(url, options);
        if (res.status === 429) {
          const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 2, 10);
          await wait(retryAfter * 1000);
          res = await fetchWithTimeout(url, options);
        }
        resolve(res);
      } catch (err) {
        reject(err);
      }
      await wait(minIntervalMs);
    };
    (priority === 'high' ? highQueue : lowQueue).push(task);
    drainQueue();
  });
}

// TVmaze/Jikan devuelven géneros en inglés; Wikidata en español con el
// prefijo "cine de ...". Se normaliza todo a un mismo vocabulario en español.
const GENRE_ES = {
  action: 'Acción',
  'action & adventure': 'Acción y aventura',
  adventure: 'Aventura',
  animation: 'Animación',
  anime: 'Anime',
  comedy: 'Comedia',
  crime: 'Crimen',
  documentary: 'Documental',
  drama: 'Drama',
  ecchi: 'Ecchi',
  family: 'Familiar',
  children: 'Infantil',
  kids: 'Infantil',
  fantasy: 'Fantasía',
  history: 'Historia',
  horror: 'Terror',
  music: 'Música',
  musical: 'Musical',
  mystery: 'Misterio',
  romance: 'Romance',
  'sci-fi': 'Ciencia ficción',
  'sci-fi & fantasy': 'Ciencia ficción',
  'science fiction': 'Ciencia ficción',
  'slice of life': 'Recuentos de la vida',
  school: 'Escolar',
  supernatural: 'Sobrenatural',
  sport: 'Deporte',
  sports: 'Deporte',
  thriller: 'Suspense',
  war: 'Bélico',
  'war & politics': 'Bélico',
  western: 'Western',
  reality: 'Telerrealidad',
  soap: 'Telenovela',
};

function toSpanish(name) {
  const cleaned = (name || '').trim();
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  if (GENRE_ES[lower]) return GENRE_ES[lower];

  // Términos de Wikidata tipo "cine de terror" -> "Terror".
  const withoutPrefix = lower.startsWith('cine de ') ? lower.slice(8) : lower;
  if (GENRE_ES[withoutPrefix]) return GENRE_ES[withoutPrefix];

  const base = withoutPrefix === lower ? cleaned : cleaned.slice(cleaned.toLowerCase().indexOf(withoutPrefix));
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function normalizeGenres(list) {
  const seen = new Set();
  const result = [];
  for (const raw of list || []) {
    const es = toSpanish(raw);
    if (es && !seen.has(es)) {
      seen.add(es);
      result.push(es);
    }
  }
  return result;
}

// Quita años, paréntesis/corchetes y separadores típicos de nombres de
// release para dejar un título de búsqueda razonable.
function cleanQuery(name) {
  return name
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// El año del propio nombre de archivo/carpeta ayuda a desambiguar títulos
// cortos o genéricos (p.ej. "Nadie") frente a otra obra homónima distinta;
// cleanQuery lo quita de la consulta en sí, pero se guarda aparte.
function extractYear(name) {
  const match = name.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

// Nombre alternativo en español de un show de TVmaze, si existe entre sus
// "akas" (títulos usados en otros países/idiomas). TVmaze no da el nombre
// en español directamente en la ficha principal.
async function fetchTvMazeSpanishName(showId, priority) {
  try {
    const res = await throttledFetch(
      `https://api.tvmaze.com/shows/${showId}/akas`,
      undefined,
      350,
      priority
    );
    if (!res.ok) return null;
    const akas = await res.json();
    const spanish = akas.find((a) => (a.country?.code || '').match(/^(ES|MX|AR|CO|CL|PE)$/i));
    return spanish ? spanish.name : null;
  } catch {
    return null;
  }
}

// TVmaze: series de TV en general (sin API key). https://www.tvmaze.com/api
async function fetchTvMaze(query, priority) {
  const res = await throttledFetch(
    `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`,
    undefined,
    350,
    priority
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TVmaze respondió ${res.status}`);
  const data = await res.json();
  const spanishName = await fetchTvMazeSpanishName(data.id, priority);
  return {
    genres: normalizeGenres(data.genres),
    year: data.premiered ? data.premiered.slice(0, 4) : null,
    type: 'tv',
    cleanName: spanishName || data.name || null,
    poster: data.image?.original || data.image?.medium || null,
  };
}

// Jikan (MyAnimeList no oficial): buen respaldo para anime (sin API key). https://jikan.moe
// La API pública de Jikan devuelve 504 (Gateway Timeout) con bastante
// frecuencia cuando está saturada por el uso global, no solo por nuestras
// propias peticiones: se reintenta unas pocas veces con espera antes de
// darse por vencido, en vez de fallar a la primera.
async function fetchJikanOnce(query, priority) {
  const res = await throttledFetch(
    `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`,
    undefined,
    800,
    priority
  );
  if (!res.ok) throw new Error(`Jikan respondió ${res.status}`);
  const data = await res.json();
  const match = data.data && data.data[0];
  if (!match) return null;
  return {
    genres: normalizeGenres((match.genres || []).map((g) => g.name)),
    year: match.year || null,
    type: 'anime',
    cleanName: match.title || null,
    poster: match.images?.jpg?.large_image_url || match.images?.jpg?.image_url || null,
  };
}

async function fetchJikan(query, priority, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetchJikanOnce(query, priority);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // eslint-disable-next-line no-await-in-loop
        await wait(2000 * (i + 1));
      }
    }
  }
  throw lastErr;
}

// TMDB: mejor que Wikidata para películas (búsqueda mucho más precisa,
// carátulas siempre en buena calidad); necesita una clave gratuita propia,
// configurable desde /config (se guarda en settings.json, en DATA_PATH -
// así viaja con la biblioteca al cambiar de PC/servidor) o en TMDB_API_KEY
// del .env como alternativa. Si no está configurada, se salta sin más y se
// sigue con Wikidata como respaldo. Es una función (no una constante fija)
// porque puede cambiar en caliente desde /config, sin reiniciar.
const TMDB_API_KEY = getTmdbApiKey;
const tmdbGenreMaps = {}; // 'movie' | 'tv' -> Map<id, nombre en español>

async function tmdbGenreMap(mediaType, priority) {
  if (tmdbGenreMaps[mediaType]) return tmdbGenreMaps[mediaType];
  const res = await throttledFetch(
    `https://api.themoviedb.org/3/genre/${mediaType}/list?api_key=${TMDB_API_KEY()}&language=es-ES`,
    undefined,
    350,
    priority
  );
  if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
  const data = await res.json();
  const map = new Map((data.genres || []).map((g) => [g.id, g.name]));
  tmdbGenreMaps[mediaType] = map;
  return map;
}

// TMDB ordena por popularidad, no por coincidencia de título: para una obra
// vieja o poco popular con secuelas/spin-offs más conocidos (p.ej. "Dragon
// Ball" -> "Dragon Ball Z" sale primero, mucho más popular), el resultado
// correcto puede no ser el primero aunque su título coincida exactamente
// con lo buscado. Se prefiere esa coincidencia exacta (título traducido u
// original) entre los primeros resultados antes que fiarse solo del orden
// de popularidad de TMDB.
function exactTitleMatch(results, query, titleKeys) {
  const target = query.trim().toLowerCase();
  return results.slice(0, 8).find((r) => titleKeys.some((k) => (r[k] || '').trim().toLowerCase() === target));
}

async function fetchTmdbMovie(query, priority, year) {
  if (!TMDB_API_KEY()) return null;
  // Sin el año, un título corto/genérico ("Nadie") puede confundirse con
  // otra película homónima distinta; cleanQuery ya lo ha quitado de la
  // consulta en sí, así que se pasa aparte como filtro cuando se conoce.
  const yearParam = year ? `&primary_release_year=${year}` : '';
  const res = await throttledFetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY()}&language=es-ES&query=${encodeURIComponent(query)}${yearParam}`,
    undefined,
    350,
    priority
  );
  if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
  const data = await res.json();
  const results = data.results || [];
  let match = exactTitleMatch(results, query, ['title', 'original_title']) || results[0];
  // El año del nombre de archivo puede no ser exactamente el de estreno
  // (fecha de festival vs. estreno general, por ejemplo): si el filtro por
  // año no encuentra nada, se reintenta sin él en vez de darse por vencido.
  if (!match && year) return fetchTmdbMovie(query, priority, null);
  if (!match) return null;
  const genreMap = await tmdbGenreMap('movie', priority);
  const genres = normalizeGenres((match.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean));
  return {
    genres,
    year: match.release_date ? match.release_date.slice(0, 4) : null,
    type: 'movie',
    cleanName: match.title || null,
    poster: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : null,
  };
}

const TMDB_ANIME_GENRE_ID = 16; // "Animación" en la lista de géneros de TMDB

async function fetchTmdbTv(query, priority, year) {
  if (!TMDB_API_KEY()) return null;
  const yearParam = year ? `&first_air_date_year=${year}` : '';
  const res = await throttledFetch(
    `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY()}&language=es-ES&query=${encodeURIComponent(query)}${yearParam}`,
    undefined,
    350,
    priority
  );
  if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
  const data = await res.json();
  const results = data.results || [];
  const isAnimeCandidate = (r) =>
    (r.genre_ids || []).includes(TMDB_ANIME_GENRE_ID) && (r.origin_country || []).includes('JP');

  // El primer resultado no siempre es el correcto: p.ej. "Blood +" devolvía
  // "True Blood" primero y el anime real "Blood+" segundo. Entre los
  // primeros resultados, se prefiere uno con origen Japón + género
  // Animación (probablemente el anime real) antes que quedarse sin más con
  // el primero a ciegas.
  const animeMatch = results.slice(0, 5).find(isAnimeCandidate);
  // Una coincidencia EXACTA de título (p.ej. "Dragon Ball" contra "Dragon
  // Ball Z") gana normalmente a esa heurística: si lo que hay escrito es
  // el título exacto de una obra, es esa y no su secuela más popular. PERO
  // cuando hay varias coincidencias exactas a la vez (mismo título, remake
  // occidental en imagen real de un anime real: "Devil May Cry", "One
  // Piece" de Netflix) se prefiere entre ELLAS la de origen Japón +
  // Animación, no la primera por popularidad.
  const exactMatches = results
    .slice(0, 8)
    .filter((r) => ['name', 'original_name'].some((k) => (r[k] || '').trim().toLowerCase() === query.trim().toLowerCase()));
  const exactAnimeMatch = exactMatches.find(isAnimeCandidate);
  const match = exactAnimeMatch || exactMatches[0] || animeMatch || results[0];
  if (!match && year) return fetchTmdbTv(query, priority, null);
  if (!match) return null;
  const genreMap = await tmdbGenreMap('tv', priority);
  const genres = normalizeGenres((match.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean));
  // TMDB no tiene una etiqueta "anime" propia: se usa animación + origen en
  // Japón como señal (evita depender de Jikan, que ha estado caído con
  // frecuencia, para esta clasificación).
  const isAnime = (match.genre_ids || []).includes(TMDB_ANIME_GENRE_ID) && (match.origin_country || []).includes('JP');
  if (isAnime && !genres.includes('Anime')) genres.push('Anime');

  // La carátula del show en TMDB a veces es la del arco/temporada más
  // reciente, no la de la obra en general (p.ej. "Bleach": el show entero
  // en TMDB junta las dos tandas, 2004 y "Guerra sangrienta de los mil
  // años" 2022, y su carátula por defecto es la de la tanda nueva). Se
  // prefiere la carátula de la temporada 1 cuando exista, más fiel a "la
  // obra" que alguien busca por su nombre sin más.
  let poster = match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : null;
  try {
    const seasonRes = await throttledFetch(
      `https://api.themoviedb.org/3/tv/${match.id}/season/1?api_key=${TMDB_API_KEY()}&language=es-ES`,
      undefined,
      350,
      priority
    );
    if (seasonRes.ok) {
      const s = await seasonRes.json();
      if (s.poster_path) poster = `https://image.tmdb.org/t/p/w500${s.poster_path}`;
    }
  } catch {
    // No es crítico: se queda con la carátula del show si esto falla.
  }

  return {
    genres: normalizeGenres(genres),
    year: match.first_air_date ? match.first_air_date.slice(0, 4) : null,
    type: isAnime ? 'anime' : 'tv',
    cleanName: match.name || null,
    poster,
  };
}

const WIKIDATA_HEADERS = { 'User-Agent': 'videoclub-local/1.0 (uso personal, sin fines comerciales)' };
const FILM_DESCRIPTION_HINTS = ['film', 'movie'];

function commonsFileUrl(filename) {
  if (!filename) return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=500`;
}

// P3383 = carátula/póster; P18 = imagen genérica, como respaldo si no hay póster.
function posterFromClaims(claims) {
  const filename = claims.P3383?.[0]?.mainsnak?.datavalue?.value || claims.P18?.[0]?.mainsnak?.datavalue?.value;
  return commonsFileUrl(filename);
}

// Wikidata: películas en general (totalmente pública, sin API key ni registro).
async function fetchWikidataFilm(query, priority) {
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&format=json&limit=10`;
  const searchRes = await throttledFetch(searchUrl, { headers: WIKIDATA_HEADERS }, 350, priority);
  if (!searchRes.ok) throw new Error(`Wikidata respondió ${searchRes.status}`);
  const searchData = await searchRes.json();
  const results = searchData.search || [];
  if (results.length === 0) return null;

  const best =
    results.find((r) => FILM_DESCRIPTION_HINTS.some((hint) => (r.description || '').toLowerCase().includes(hint))) ||
    results[0];

  const entityRes = await throttledFetch(
    `https://www.wikidata.org/wiki/Special:EntityData/${best.id}.json`,
    { headers: WIKIDATA_HEADERS },
    350,
    priority
  );
  if (!entityRes.ok) throw new Error(`Wikidata respondió ${entityRes.status}`);
  const entityData = await entityRes.json();
  const entity = entityData.entities?.[best.id] || {};
  const claims = entity.claims || {};

  const genreIds = (claims.P136 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

  const dateValue = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time;
  const year = dateValue ? dateValue.replace('+', '').slice(0, 4) : null;
  // La búsqueda se hace en inglés, pero la propia entidad trae también el
  // título en español (más fiable que traducir el resultado de la búsqueda).
  // Si ni la entidad ni el resultado de búsqueda traen una etiqueta real (o
  // esta es literalmente el texto buscado, señal de una respuesta degradada
  // de la API), se descarta en vez de guardar basura.
  const nameCandidate = entity.labels?.es?.value || entity.labels?.en?.value || best.label || null;
  const cleanName =
    nameCandidate && nameCandidate.trim().toLowerCase() !== query.trim().toLowerCase() ? nameCandidate : null;
  const poster = posterFromClaims(claims);

  if (genreIds.length === 0) return { genres: [], year, type: 'movie', cleanName, poster };

  const labelsRes = await throttledFetch(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${genreIds.join('|')}&props=labels&languages=es|en&format=json`,
    { headers: WIKIDATA_HEADERS },
    350,
    priority
  );
  if (!labelsRes.ok) throw new Error(`Wikidata respondió ${labelsRes.status}`);
  const labelsData = await labelsRes.json();
  const rawGenres = genreIds
    .map((id) => {
      const labels = labelsData.entities?.[id]?.labels;
      return labels?.es?.value || labels?.en?.value || null;
    })
    .filter(Boolean);

  return { genres: normalizeGenres(rawGenres), year, type: 'movie', cleanName, poster };
}

// TMDB siempre primero (tanto TV/anime como película): su búsqueda es
// mucho más precisa que la de TVmaze, que varias veces ha encontrado un
// título homónimo sin relación (p.ej. "Nadie" -> "Tú o nadie", o "Monster"
// -> otra serie de 2017 en vez del anime de 2004). Si no hay clave TMDB
// configurada, o TMDB no encuentra nada, se cae al respaldo antiguo
// (TVmaze + Jikan para anime, Wikidata para película).
async function fetchBest(query, priority, year) {
  // Un fallo puntual de TMDB (rate-limit, caída momentánea) no debe
  // bloquear todo lo demás: se cae al respaldo antiguo igual que si no
  // hubiera encontrado nada, en vez de propagar el error.
  //
  // El orden entre TV y película de TMDB depende de si el nombre trae año:
  // eso es lo que distingue una película (p.ej. "Nadie (2021)") de una
  // carpeta de serie/anime (casi nunca lleva año, p.ej. "One Piece") en
  // esta biblioteca. Probarlas en el orden equivocado es justo lo que hizo
  // que "Nadie" encontrase antes una serie sin relación ("Tierra de
  // nadie") que la película real.
  let tmdbTv = null;
  let tmdbMovie = null;
  try {
    if (year) {
      tmdbMovie = await fetchTmdbMovie(query, priority, year);
      if (tmdbMovie && tmdbMovie.genres.length) return tmdbMovie;
      tmdbTv = await fetchTmdbTv(query, priority, year);
      if (tmdbTv && tmdbTv.genres.length) return tmdbTv;
    } else {
      tmdbTv = await fetchTmdbTv(query, priority, year);
      if (tmdbTv && tmdbTv.genres.length) return tmdbTv;
      tmdbMovie = await fetchTmdbMovie(query, priority, year);
      if (tmdbMovie && tmdbMovie.genres.length) return tmdbMovie;
    }
  } catch (err) {
    console.warn(`TMDB falló para "${query}", usando el respaldo: ${err.message}`);
  }

  // A partir de aquí, el respaldo de siempre: sin clave TMDB configurada,
  // TMDB falló, o no ha encontrado nada para esta consulta.
  const tv = await fetchTvMaze(query, priority);
  if (tv && tv.genres.includes('Anime')) return tv;

  // Si Jikan sigue fallando tras los reintentos y ya hay un resultado de
  // TVmaze sin confirmar todavía si es anime, no se puede cachear con
  // seguridad: se propaga el error (nada se cachea, ver getMetadata) para
  // reintentarlo más tarde en vez de arriesgarse a clasificar mal algo que
  // sí es anime solo porque Jikan estaba caído en ese momento. Pero si no
  // hay nada de TVmaze que arriesgar (típicamente una película: Jikan no
  // pinta nada ahí de todos modos), un fallo de Jikan no debe bloquear las
  // demás fuentes (Wikidata) — Jikan caído no puede tumbar también la
  // búsqueda de películas.
  let anime = null;
  try {
    anime = await fetchJikan(query, priority);
  } catch (err) {
    if (tv && tv.genres.length) throw err;
    console.warn(`No se pudo comprobar en Jikan si "${query}" es anime: ${err.message}`);
  }
  if (anime && anime.genres.length) {
    if (tv && tv.genres.length) {
      return {
        genres: normalizeGenres([...tv.genres, ...anime.genres, 'anime']),
        year: tv.year || anime.year,
        type: 'anime',
        cleanName: tv.cleanName || anime.cleanName,
        poster: tv.poster || anime.poster,
      };
    }
    return anime;
  }

  if (tv && tv.genres.length) return tv;

  const movie = await fetchWikidataFilm(query, priority);
  if (movie && movie.genres.length) return movie;

  return tv || tmdbMovie || tmdbTv || movie || anime || null;
}

// Devuelve los metadatos (géneros, año, tipo) para una clave (nombre de
// serie o de película), consultando fuentes públicas sin API key.
// `priority`: 'high' para lo que el usuario está viendo ahora (adelanta a
// la cola de precalentamiento en segundo plano), 'low' para el resto.
async function getMetadata(key, priority = 'low') {
  if (cache[key]) return cache[key];
  if (pending.has(key)) return pending.get(key);

  // 'high' (el usuario está viendo esto ahora) se salta el enfriamiento:
  // mejor un intento más contra una fuente caída que no comprobar nada.
  const lastFailed = failedAt.get(key);
  if (priority !== 'high' && lastFailed && Date.now() - lastFailed < FAIL_COOLDOWN_MS) {
    return { genres: [], year: null, type: null, cleanName: null, poster: null };
  }

  const promise = (async () => {
    const query = cleanQuery(key);
    if (!query) return { genres: [], year: null, type: null, cleanName: null, poster: null };
    const year = extractYear(key);

    try {
      const result = await fetchBest(query, priority, year);
      const entry = result || { genres: [], year: null, type: null, cleanName: null, poster: null };
      cache[key] = entry;
      failedAt.delete(key);
      saveCache();
      return entry;
    } catch (err) {
      // Fallo de red/rate-limit: no se cachea, para reintentar más tarde
      // (tras el enfriamiento de arriba, no en la próxima pasada inmediata).
      console.warn(`No se pudieron obtener metadatos para "${key}": ${err.message}`);
      failedAt.set(key, Date.now());
      return { genres: [], year: null, type: null, cleanName: null, poster: null };
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

// Versión no bloqueante: devuelve lo que ya haya en caché al instante (o
// vacío si aún no se ha consultado) y dispara la búsqueda en segundo plano
// para la próxima vez, sin hacer esperar al que la pide. Pensado para no
// bloquear el listado del catálogo mientras se consultan fuentes externas.
function getCached(key) {
  if (cache[key]) return cache[key];
  getMetadata(key, 'high');
  return { genres: [], year: null, type: null, cleanName: null, poster: null };
}

// Para normalize.js: una película suelta (sin carpeta propia) usa su propio
// título de archivo como clave de metadatos (ver catalog.js groupKeyFor),
// así que renombrarla cambia su clave - sin esto, cada renombrado
// "olvidaba" los géneros/carátula ya encontrados y tenía que volver a
// buscarlos desde cero bajo la clave nueva (a veces peor, si la fuente de
// repuesto acierta menos que la búsqueda original). Mueve la entrada ya
// cacheada de la clave vieja a la nueva en vez de perderla.
function migrateCacheKey(oldKey, newKey) {
  if (oldKey === newKey || !cache[oldKey]) return;
  if (!cache[newKey]) cache[newKey] = cache[oldKey];
  delete cache[oldKey];
  saveCache();
}

// Un reescaneo automático (uno por cada vídeo que termina de convertirse y
// sustituye al original, más los manuales) puede llamar a esto mientras la
// pasada anterior todavía sigue en marcha; sin este guard, se acumulaban
// pasadas paralelas todas reintentando las mismas claves fallidas desde el
// principio en vez de avanzar. Con el guard, una pasada en marcha sigue
// hasta el final (ya recorrerá las claves nuevas) y las llamadas de más se
// ignoran.
let warming = false;
async function warmAll(keys) {
  if (warming) return;
  warming = true;
  try {
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      await getMetadata(key);
    }
  } finally {
    warming = false;
  }
}

// Para purgar del todo una obra (ver purge.js): olvida su entrada de
// caché y cualquier override guardado, sin volver a buscar nada.
function forgetMetadata(key) {
  delete cache[key];
  pending.delete(key);
  failedAt.delete(key);
  saveCache();
  if (overrides[key]) {
    delete overrides[key];
    saveOverrides();
  }
}

function allGenres() {
  const set = new Set();
  for (const entry of Object.values(cache)) {
    for (const g of entry.genres || []) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

// Olvida lo que hubiera en caché para esta clave y lo vuelve a buscar ya
// mismo. Antes, corregir una carátula/género mal encontrado exigía parar el
// servidor, editar data/metadata.json a mano y reiniciar (el proceso en
// marcha nunca se enteraba de un cambio hecho solo en el archivo): con esto
// se puede corregir en caliente, sin reiniciar nada.
async function refreshMetadata(key) {
  const reapplied = await applyStoredOverrideIfAny(key);
  if (reapplied) return reapplied;
  delete cache[key];
  pending.delete(key);
  return getMetadata(key, 'high');
}

// Lógica compartida de overrideFromTmdb (pedir la ficha exacta a TMDB por
// id, sin pasar por la búsqueda) para poder reaplicarla sola cuando una
// búsqueda automática posterior encuentra que la clave tiene un override
// guardado (ver applyStoredOverrideIfAny).
async function fetchTmdbFixedEntry({ tmdbType, tmdbId, season }) {
  if (!TMDB_API_KEY()) throw new Error('TMDB_API_KEY no configurada en .env');
  if (!tmdbType || !tmdbId) throw new Error('Faltan "tmdbType" ("tv" o "movie") y "tmdbId"');

  let entry;
  if (tmdbType === 'movie') {
    const res = await throttledFetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY()}&language=es-ES`,
      undefined,
      350,
      'high'
    );
    if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
    const m = await res.json();
    entry = {
      genres: normalizeGenres((m.genres || []).map((g) => g.name)),
      year: m.release_date ? m.release_date.slice(0, 4) : null,
      type: 'movie',
      cleanName: m.title || null,
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    };
  } else if (tmdbType === 'tv') {
    const res = await throttledFetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY()}&language=es-ES`,
      undefined,
      350,
      'high'
    );
    if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
    const t = await res.json();
    const genreIds = (t.genres || []).map((g) => g.id);
    const isAnime = genreIds.includes(TMDB_ANIME_GENRE_ID) && (t.origin_country || []).includes('JP');
    let poster = t.poster_path ? `https://image.tmdb.org/t/p/w500${t.poster_path}` : null;

    // Una temporada concreta puede tener su propia carátula distinta a la
    // del show en general (justo el caso de ".hack//Sign" temporada 1).
    let seasonName = null;
    if (season != null) {
      const seasonRes = await throttledFetch(
        `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${TMDB_API_KEY()}&language=es-ES`,
        undefined,
        350,
        'high'
      );
      if (seasonRes.ok) {
        const s = await seasonRes.json();
        if (s.poster_path) poster = `https://image.tmdb.org/t/p/w500${s.poster_path}`;
        seasonName = s.name || null;
      }
    }

    // Algunos animes (Digimon Adventure/02, Dragon Ball/Z...) están en TMDB
    // como temporadas de un único show, con el mismo nombre para todas -
    // sin esto, dos carpetas locales distintas fijadas a temporadas
    // distintas del mismo show acaban mostrando el mismo título ("Digimon"
    // a secas para ambas). TMDB tampoco da un nombre útil por temporada en
    // español (siempre "Temporada N", genérico), así que se numera a mano
    // con el mismo criterio que ya usan las carpetas locales.
    const cleanName =
      season != null && season > 1 && seasonName && /^temporada \d+$/i.test(seasonName)
        ? `${t.name} ${season}`
        : seasonName && !/^temporada \d+$/i.test(seasonName)
          ? seasonName
          : t.name || null;

    entry = {
      genres: normalizeGenres([...(t.genres || []).map((g) => g.name), ...(isAnime ? ['anime'] : [])]),
      year: t.first_air_date ? t.first_air_date.slice(0, 4) : null,
      type: isAnime ? 'anime' : 'tv',
      cleanName,
      poster,
    };
  } else {
    throw new Error('"tmdbType" debe ser "tv" o "movie"');
  }

  return entry;
}

// Para elegir a mano entre varias posibles fichas de TMDB cuando la
// búsqueda automática no acierta con ninguna heurística: devuelve hasta 3
// candidatos (título, año, carátula, origen) de TV y película combinados,
// para que la persona elija cuál aplicar (con overrideFromTmdb) en vez de
// que el servidor siga adivinando solo.
async function getPosterCandidates(key) {
  if (!TMDB_API_KEY()) throw new Error('TMDB_API_KEY no configurada en .env');
  const query = cleanQuery(key);
  if (!query) return [];
  const year = extractYear(key);

  const [tvRes, movieRes] = await Promise.all([
    throttledFetch(
      `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY()}&language=es-ES&query=${encodeURIComponent(query)}${year ? `&first_air_date_year=${year}` : ''}`,
      undefined,
      350,
      'high'
    ),
    throttledFetch(
      `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY()}&language=es-ES&query=${encodeURIComponent(query)}${year ? `&primary_release_year=${year}` : ''}`,
      undefined,
      350,
      'high'
    ),
  ]);

  const tvData = tvRes.ok ? await tvRes.json() : { results: [] };
  const movieData = movieRes.ok ? await movieRes.json() : { results: [] };

  const isAnimeCandidate = (r) =>
    (r.genre_ids || []).includes(TMDB_ANIME_GENRE_ID) && (r.origin_country || []).includes('JP');

  const tvCandidates = (tvData.results || [])
    .filter((r) => r.poster_path)
    .map((r) => ({
      tmdbType: 'tv',
      tmdbId: r.id,
      name: r.name,
      year: r.first_air_date ? r.first_air_date.slice(0, 4) : null,
      poster: `https://image.tmdb.org/t/p/w500${r.poster_path}`,
      isAnime: isAnimeCandidate(r),
      popularity: r.popularity || 0,
    }));
  const movieCandidates = (movieData.results || [])
    .filter((r) => r.poster_path)
    .map((r) => ({
      tmdbType: 'movie',
      tmdbId: r.id,
      name: r.title,
      year: r.release_date ? r.release_date.slice(0, 4) : null,
      poster: `https://image.tmdb.org/t/p/w500${r.poster_path}`,
      isAnime: false,
      popularity: r.popularity || 0,
    }));

  const target = query.trim().toLowerCase();
  const all = [...tvCandidates, ...movieCandidates];
  // Mismo criterio que la búsqueda automática (coincidencia exacta de
  // título primero, y entre esas el anime japonés antes que un remake
  // occidental homónimo) pero mostrando varias opciones en vez de
  // quedarse con una sola a ciegas.
  all.sort((a, b) => {
    const aExact = a.name.trim().toLowerCase() === target;
    const bExact = b.name.trim().toLowerCase() === target;
    if (aExact !== bExact) return aExact ? -1 : 1;
    if (a.isAnime !== b.isAnime) return a.isAnime ? -1 : 1;
    return b.popularity - a.popularity;
  });

  const seen = new Set();
  const result = [];
  for (const c of all) {
    const dedupeKey = `${c.tmdbType}:${c.tmdbId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(c);
    if (result.length >= 3) break;
  }
  return result;
}

// Para cuando la búsqueda automática no encuentra la ficha correcta (título
// ambiguo, temporada con carátula distinta a la del show...): se fija a
// mano a partir de un id de TMDB conocido, sin pasar por la búsqueda. Se
// recuerda para siempre en OVERRIDES_FILE, así que una actualización
// masiva posterior (forceTmdbRefreshAll) o un refreshMetadata normal no lo
// vuelven a pisar con un resultado de búsqueda "parecido" pero distinto.
async function overrideFromTmdb(key, { tmdbType, tmdbId, season } = {}) {
  const entry = await fetchTmdbFixedEntry({ tmdbType, tmdbId, season });
  overrides[key] = { tmdbType, tmdbId, season: season ?? null };
  saveOverrides();
  cache[key] = entry;
  pending.delete(key);
  saveCache();
  return entry;
}

// Si esta clave tiene un override guardado, lo vuelve a aplicar y devuelve
// la entrada resultante; si no, devuelve null sin tocar nada. Se llama
// antes de dejar que una búsqueda automática (refreshMetadata,
// forceTmdbRefreshOne) toque una clave, para que nunca deshaga una
// corrección hecha a mano.
async function applyStoredOverrideIfAny(key) {
  const saved = overrides[key];
  if (!saved) return null;
  try {
    const entry = await fetchTmdbFixedEntry(saved);
    cache[key] = entry;
    pending.delete(key);
    saveCache();
    return entry;
  } catch (err) {
    console.warn(`No se pudo reaplicar el override guardado de "${key}": ${err.message}`);
    return null;
  }
}

// Fuerza una actualización de nombre y carátula SOLO desde TMDB (en
// español), ignorando el resto de fuentes (TVmaze/Jikan/Wikidata): para
// corregir de una vez toda la biblioteca con la fuente de mejor calidad.
// Si TMDB no encuentra nada para esta clave, no se toca lo que ya hubiera
// en caché - mejor conservar lo que hay que perderlo.
async function forceTmdbRefreshOne(key, priority = 'low') {
  if (!TMDB_API_KEY()) throw new Error('TMDB_API_KEY no configurada en .env');
  const reapplied = await applyStoredOverrideIfAny(key);
  if (reapplied) return { updated: true };
  const query = cleanQuery(key);
  if (!query) return { updated: false };
  const year = extractYear(key);

  let match = null;
  try {
    // Mismo orden película/serie que fetchBest: el año en el nombre es lo
    // que distingue una película de una carpeta de serie/anime aquí.
    if (year) {
      match = await fetchTmdbMovie(query, priority, year);
      if (!match) match = await fetchTmdbTv(query, priority, year);
    } else {
      match = await fetchTmdbTv(query, priority, year);
      if (!match) match = await fetchTmdbMovie(query, priority, year);
    }
  } catch (err) {
    console.warn(`TMDB falló forzando "${key}": ${err.message}`);
    return { updated: false, error: err.message };
  }

  if (!match || (!match.cleanName && !match.poster)) {
    return { updated: false };
  }

  const existing = cache[key] || { genres: [], year: null, type: null, cleanName: null, poster: null };
  cache[key] = {
    genres: match.genres && match.genres.length ? match.genres : existing.genres,
    year: match.year || existing.year,
    type: match.type || existing.type,
    cleanName: match.cleanName || existing.cleanName,
    poster: match.poster || existing.poster,
  };
  pending.delete(key);
  saveCache();
  return { updated: true };
}

// Progreso de la pasada completa (ver forceTmdbRefreshAll), consultable
// desde una ruta HTTP para pintar una barra de progreso sin bloquear la
// petición que la arranca.
const forceTmdbProgress = { running: false, total: 0, done: 0, updated: 0, startedAt: null };

async function forceTmdbRefreshAll(keys) {
  if (forceTmdbProgress.running) return forceTmdbProgress;
  forceTmdbProgress.running = true;
  forceTmdbProgress.total = keys.length;
  forceTmdbProgress.done = 0;
  forceTmdbProgress.updated = 0;
  forceTmdbProgress.startedAt = Date.now();
  try {
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      const result = await forceTmdbRefreshOne(key, 'low');
      if (result.updated) forceTmdbProgress.updated += 1;
      forceTmdbProgress.done += 1;
    }
  } finally {
    forceTmdbProgress.running = false;
  }
  return forceTmdbProgress;
}

function getForceTmdbProgress() {
  return forceTmdbProgress;
}

module.exports = {
  getMetadata,
  getCached,
  warmAll,
  allGenres,
  refreshMetadata,
  overrideFromTmdb,
  forceTmdbRefreshAll,
  getForceTmdbProgress,
  forgetMetadata,
  getPosterCandidates,
  migrateCacheKey,
  extractYear,
  reloadCache,
  reloadOverrides,
};
