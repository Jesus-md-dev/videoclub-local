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
  return {
    genres: normalizeGenres(data.genres),
    year: data.premiered ? data.premiered.slice(0, 4) : null,
    type: 'tv',
    cleanName: data.name || null,
    poster: data.image?.original || data.image?.medium || null,
  };
}

// Jikan (MyAnimeList no oficial): buen respaldo para anime (sin API key). https://jikan.moe
async function fetchJikan(query, priority) {
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
  const claims = entityData.entities?.[best.id]?.claims || {};

  const genreIds = (claims.P136 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

  const dateValue = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time;
  const year = dateValue ? dateValue.replace('+', '').slice(0, 4) : null;
  const cleanName = best.label || null;
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

// Prueba las fuentes en un orden fijo y se queda con la primera que
// encuentre géneros reales; no asume de antemano si es serie o película
// (eso lo decide el propio resultado de la búsqueda, no la estructura de
// carpetas/archivos en disco).
async function fetchBest(query, priority) {
  const tv = await fetchTvMaze(query, priority);
  if (tv && tv.genres.length) return tv;

  const movie = await fetchWikidataFilm(query, priority);
  if (movie && movie.genres.length) return movie;

  const anime = await fetchJikan(query, priority);
  if (anime && anime.genres.length) return anime;

  return tv || movie || anime || null;
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

    try {
      const result = await fetchBest(query, priority);
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
