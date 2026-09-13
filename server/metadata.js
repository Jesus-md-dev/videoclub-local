const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

const METADATA_FILE = path.join(DATA_PATH, 'metadata.json');
const BASE_URL = 'https://api.themoviedb.org/3';

function apiKey() {
  return process.env.TMDB_API_KEY || null;
}

let cache = loadCache();
let genreMapPromise = null;
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

async function loadGenreMap() {
  if (genreMapPromise) return genreMapPromise;
  genreMapPromise = (async () => {
    const [movieRes, tvRes] = await Promise.all([
      fetch(`${BASE_URL}/genre/movie/list?api_key=${apiKey()}&language=es-ES`),
      fetch(`${BASE_URL}/genre/tv/list?api_key=${apiKey()}&language=es-ES`),
    ]);
    if (!movieRes.ok || !tvRes.ok) {
      throw new Error('No se pudo obtener la lista de géneros de TMDb');
    }
    const [movieData, tvData] = await Promise.all([movieRes.json(), tvRes.json()]);
    const map = new Map();
    for (const g of [...(movieData.genres || []), ...(tvData.genres || [])]) {
      map.set(g.id, g.name);
    }
    return map;
  })();
  return genreMapPromise;
}

async function fetchFromTmdb(key) {
  const query = cleanQuery(key);
  if (!query) return { genres: [], tmdbId: null, year: null };

  const url = `${BASE_URL}/search/multi?api_key=${apiKey()}&language=es-ES&query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDb respondió ${res.status}`);
  }
  const data = await res.json();
  const match = (data.results || []).find((r) => r.media_type === 'movie' || r.media_type === 'tv');
  if (!match) return { genres: [], tmdbId: null, year: null };

  const genreMap = await loadGenreMap();
  const genres = (match.genre_ids || []).map((id) => genreMap.get(id)).filter(Boolean);
  const year = (match.release_date || match.first_air_date || '').slice(0, 4) || null;

  return { genres, tmdbId: match.id, year };
}

// Devuelve los metadatos (géneros, año) para una clave (nombre de serie o
// de película). Sin TMDB_API_KEY configurada, no hace nada y no falla.
async function getMetadata(key) {
  if (!apiKey()) return { genres: [] };
  if (cache[key]) return cache[key];
  if (pending.has(key)) return pending.get(key);

  const promise = fetchFromTmdb(key)
    .catch((err) => {
      console.warn(`No se pudo obtener metadatos de TMDb para "${key}": ${err.message}`);
      return { genres: [], tmdbId: null, year: null };
    })
    .then((result) => {
      cache[key] = result;
      saveCache();
      pending.delete(key);
      return result;
    });

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
