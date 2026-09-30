const catalog = require('./catalog');
const metadata = require('./metadata');
const { createJsonRegistry } = require('./jsonRegistry');

// Número absoluto de cada episodio "SxxEyy", contado desde el principio de
// la serie sin tener en cuenta las temporadas (p.ej. "Bleach - S06E15" es
// el 124). Muchas descargas lo traían en el nombre ("Bleach S06E12 Episode
// 121"), pero el normalizador de nombres lo quita, así que se calcula a
// partir de cuántos episodios tiene cada temporada según TMDB (ver
// metadata.fetchEpisodeOrderings). Se consulta una vez por serie y se
// guarda aquí: { <clave de la serie>: { orderings, fetchedAt } }.
const store = createJsonRegistry('episode-numbering.json');

// Mismo patrón que extractGroup en CatalogPage.jsx.
const SEASON_EPISODE_PATTERN = /S(\d{1,2})E(\d{1,3})/i;
const RETRY_AFTER_FAIL_MS = 10 * 60 * 1000;
// Si ningún reparto guardado encaja con los archivos (p.ej. ha llegado una
// temporada que TMDB aún no tenía), se vuelve a consultar como mucho una
// vez por semana.
const REFRESH_UNFIT_MS = 7 * 24 * 60 * 60 * 1000;

const pending = new Set();
const failedAt = new Map();
let memo = { videos: null, byId: new Map() };

function parseSeasonEpisode(title) {
  const match = title.match(SEASON_EPISODE_PATTERN);
  return match ? { season: Number(match[1]), episode: Number(match[2]) } : null;
}

// Episodios anteriores a cada temporada en este reparto, o null si no
// encaja con los archivos de la serie: todos tienen que caber (su
// temporada existe y el episodio no pasa de los que tiene). Con una sola
// temporada tampoco sirve: el número absoluto sería el mismo del archivo.
function startsIfFits(ordering, episodes) {
  const counts = ordering.seasons || {};
  const numbers = Object.keys(counts)
    .map(Number)
    .sort((a, b) => a - b);
  if (numbers.length < 2) return null;
  if (!episodes.every(({ season, episode }) => counts[season] != null && episode >= 1 && episode <= counts[season])) {
    return null;
  }
  const starts = {};
  let before = 0;
  for (const n of numbers) {
    starts[n] = before;
    before += counts[n];
  }
  return starts;
}

// En segundo plano, como metadata.getCached: la web no espera a TMDB, el
// número aparece en la siguiente carga.
function refresh(key) {
  if (pending.has(key)) return;
  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < RETRY_AFTER_FAIL_MS) return;
  pending.add(key);
  metadata
    .fetchEpisodeOrderings(key)
    .then((orderings) => {
      store.get()[key] = { orderings, fetchedAt: new Date().toISOString() };
      store.save();
      failedAt.delete(key);
      memo.videos = null;
    })
    .catch((err) => {
      failedAt.set(key, Date.now());
      console.warn(`No se pudo consultar la numeración de episodios de "${key}": ${err.message}`);
    })
    .finally(() => pending.delete(key));
}

function compute(videos) {
  const bySeries = new Map();
  for (const video of videos) {
    const parsed = parseSeasonEpisode(video.title);
    const key = parsed && catalog.getShowKeyFor(video);
    if (!key) continue;
    if (!bySeries.has(key)) bySeries.set(key, []);
    bySeries.get(key).push({ video, ...parsed });
  }

  const byId = new Map();
  for (const [key, episodes] of bySeries) {
    // Solo la temporada 1: el número absoluto es el mismo del archivo.
    if (!episodes.some(({ season }) => season > 1)) continue;
    const saved = store.get()[key];
    if (!saved) {
      refresh(key);
      continue;
    }
    let starts = null;
    for (const ordering of saved.orderings || []) {
      starts = startsIfFits(ordering, episodes);
      if (starts) break;
    }
    if (!starts) {
      if (!(Date.now() - Date.parse(saved.fetchedAt) < REFRESH_UNFIT_MS)) refresh(key);
      continue;
    }
    for (const { video, season, episode } of episodes) byId.set(video.id, starts[season] + episode);
  }
  return byId;
}

// null si no se conoce (no es "SxxEyy", la serie no está en TMDB, ningún
// reparto encaja, o todavía se está consultando).
function absoluteEpisodeFor(video) {
  const videos = catalog.getCatalog();
  if (memo.videos !== videos) memo = { videos, byId: compute(videos) };
  return memo.byId.get(video.id) ?? null;
}

function reloadRegistry() {
  store.reload();
  memo.videos = null;
}

module.exports = { absoluteEpisodeFor, reloadRegistry };
