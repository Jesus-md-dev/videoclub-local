const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

const METADATA_FILE = path.join(DATA_PATH, 'metadata.json');

let cache = loadCache();
const pending = new Map();

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
// carátulas siempre en buena calidad); necesita una clave gratuita propia
// (TMDB_API_KEY en .env). Si no está configurada, se salta sin más y se
// sigue con Wikidata como respaldo.
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const tmdbGenreMaps = {}; // 'movie' | 'tv' -> Map<id, nombre en español>

async function tmdbGenreMap(mediaType, priority) {
  if (tmdbGenreMaps[mediaType]) return tmdbGenreMaps[mediaType];
  const res = await throttledFetch(
    `https://api.themoviedb.org/3/genre/${mediaType}/list?api_key=${TMDB_API_KEY}&language=es-ES`,
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

async function fetchTmdbMovie(query, priority, year) {
  if (!TMDB_API_KEY) return null;
  // Sin el año, un título corto/genérico ("Nadie") puede confundirse con
  // otra película homónima distinta; cleanQuery ya lo ha quitado de la
  // consulta en sí, así que se pasa aparte como filtro cuando se conoce.
  const yearParam = year ? `&primary_release_year=${year}` : '';
  const res = await throttledFetch(
    `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=es-ES&query=${encodeURIComponent(query)}${yearParam}`,
    undefined,
    350,
    priority
  );
  if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
  const data = await res.json();
  let match = data.results?.[0];
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
  if (!TMDB_API_KEY) return null;
  const yearParam = year ? `&first_air_date_year=${year}` : '';
  const res = await throttledFetch(
    `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&language=es-ES&query=${encodeURIComponent(query)}${yearParam}`,
    undefined,
    350,
    priority
  );
  if (!res.ok) throw new Error(`TMDB respondió ${res.status}`);
  const data = await res.json();
  const match = data.results?.[0];
  if (!match && year) return fetchTmdbTv(query, priority, null);
  if (!match) return null;
  const genreMap = await tmdbGenreMap('tv', priority);
  const genres = normalizeGenres((match.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean));
  // TMDB no tiene una etiqueta "anime" propia: se usa animación + origen en
  // Japón como señal (evita depender de Jikan, que ha estado caído con
  // frecuencia, para esta clasificación).
  const isAnime = (match.genre_ids || []).includes(TMDB_ANIME_GENRE_ID) && (match.origin_country || []).includes('JP');
  if (isAnime && !genres.includes('Anime')) genres.push('Anime');
  return {
    genres: normalizeGenres(genres),
    year: match.first_air_date ? match.first_air_date.slice(0, 4) : null,
    type: isAnime ? 'anime' : 'tv',
    cleanName: match.name || null,
    poster: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : null,
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

  const promise = (async () => {
    const query = cleanQuery(key);
    if (!query) return { genres: [], year: null, type: null, cleanName: null, poster: null };
    const year = extractYear(key);

    try {
      const result = await fetchBest(query, priority, year);
      const entry = result || { genres: [], year: null, type: null, cleanName: null, poster: null };
      cache[key] = entry;
      saveCache();
      return entry;
    } catch (err) {
      // Fallo de red/rate-limit: no se cachea, para reintentar más tarde.
      console.warn(`No se pudieron obtener metadatos para "${key}": ${err.message}`);
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

async function warmAll(keys) {
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    await getMetadata(key);
  }
}

function allGenres() {
  const set = new Set();
  for (const entry of Object.values(cache)) {
    for (const g of entry.genres || []) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

module.exports = { getMetadata, getCached, warmAll, allGenres };
