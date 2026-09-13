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
// disparar ráfagas de peticiones en paralelo y evitar 429 (rate limit).
let queue = Promise.resolve();
function throttledFetch(url, options, minIntervalMs = 350) {
  const run = queue.then(async () => {
    let res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 2;
      await wait(retryAfter * 1000);
      res = await fetch(url, options);
    }
    await wait(minIntervalMs);
    return res;
  });
  queue = run.catch(() => {});
  return run;
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
async function fetchTvMaze(query) {
  const res = await throttledFetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TVmaze respondió ${res.status}`);
  const data = await res.json();
  return {
    genres: normalizeGenres(data.genres),
    year: data.premiered ? data.premiered.slice(0, 4) : null,
  };
}

// Jikan (MyAnimeList no oficial): buen respaldo para anime (sin API key). https://jikan.moe
async function fetchJikan(query) {
  const res = await throttledFetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`, undefined, 800);
  if (!res.ok) throw new Error(`Jikan respondió ${res.status}`);
  const data = await res.json();
  const match = data.data && data.data[0];
  if (!match) return null;
  return {
    genres: normalizeGenres((match.genres || []).map((g) => g.name)),
    year: match.year || null,
  };
}

const WIKIDATA_HEADERS = { 'User-Agent': 'videoclub-local/1.0 (uso personal, sin fines comerciales)' };
const FILM_DESCRIPTION_HINTS = ['film', 'movie'];

// Wikidata: películas en general (totalmente pública, sin API key ni registro).
async function fetchWikidataFilm(query) {
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&format=json&limit=10`;
  const searchRes = await throttledFetch(searchUrl, { headers: WIKIDATA_HEADERS });
  if (!searchRes.ok) throw new Error(`Wikidata respondió ${searchRes.status}`);
  const searchData = await searchRes.json();
  const results = searchData.search || [];
  if (results.length === 0) return null;

  const best =
    results.find((r) => FILM_DESCRIPTION_HINTS.some((hint) => (r.description || '').toLowerCase().includes(hint))) ||
    results[0];

  const entityRes = await throttledFetch(`https://www.wikidata.org/wiki/Special:EntityData/${best.id}.json`, {
    headers: WIKIDATA_HEADERS,
  });
  if (!entityRes.ok) throw new Error(`Wikidata respondió ${entityRes.status}`);
  const entityData = await entityRes.json();
  const claims = entityData.entities?.[best.id]?.claims || {};

  const genreIds = (claims.P136 || [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);

  const dateValue = claims.P577?.[0]?.mainsnak?.datavalue?.value?.time;
  const year = dateValue ? dateValue.replace('+', '').slice(0, 4) : null;

  if (genreIds.length === 0) return { genres: [], year };

  const labelsRes = await throttledFetch(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${genreIds.join('|')}&props=labels&languages=es|en&format=json`,
    { headers: WIKIDATA_HEADERS }
  );
  if (!labelsRes.ok) throw new Error(`Wikidata respondió ${labelsRes.status}`);
  const labelsData = await labelsRes.json();
  const rawGenres = genreIds
    .map((id) => {
      const labels = labelsData.entities?.[id]?.labels;
      return labels?.es?.value || labels?.en?.value || null;
    })
    .filter(Boolean);

  return { genres: normalizeGenres(rawGenres), year };
}

async function fetchBest(query, isSeries) {
  if (isSeries) {
    const tv = await fetchTvMaze(query);
    if (tv && tv.genres.length) return tv;
    const anime = await fetchJikan(query);
    if (anime && anime.genres.length) return anime;
    return tv || anime || null;
  }

  const movie = await fetchWikidataFilm(query);
  if (movie && movie.genres.length) return movie;
  const anime = await fetchJikan(query);
  return anime || movie || null;
}

// Devuelve los metadatos (géneros, año) para una clave (nombre de serie o
// de película), consultando fuentes públicas sin API key.
async function getMetadata(key, isSeries = false) {
  if (cache[key]) return cache[key];
  if (pending.has(key)) return pending.get(key);

  const promise = (async () => {
    const query = cleanQuery(key);
    if (!query) return { genres: [], year: null };

    try {
      const result = await fetchBest(query, isSeries);
      const entry = result || { genres: [], year: null };
      cache[key] = entry;
      saveCache();
      return entry;
    } catch (err) {
      // Fallo de red/rate-limit: no se cachea, para reintentar más tarde.
      console.warn(`No se pudieron obtener metadatos para "${key}": ${err.message}`);
      return { genres: [], year: null };
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, promise);
  return promise;
}

function allGenres() {
  const set = new Set();
  for (const entry of Object.values(cache)) {
    for (const g of entry.genres || []) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

module.exports = { getMetadata, allGenres };
