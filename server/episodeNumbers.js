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
let memo = { videos: null, byId: new Map(), seasonal: new Map() };

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
  // Un "S01E274" en una serie con temporadas (más episodios de los que
  // tiene la temporada 1) es un número absoluto al que se le puso S01 por
  // defecto (visto de verdad: 36 episodios de Bleach renombrados así antes
  // de existir seasonEpisodeFor). No invalida el reparto: su número
  // absoluto es el suyo (la temporada 1 empieza en 0), y normalize.js lo
  // renombra a su temporada real.
  const fits = ({ season, episode }) =>
    (counts[season] != null && episode >= 1 && episode <= counts[season]) || (season === 1 && episode > counts[1]);
  if (!episodes.every(fits)) return null;
  if (!episodes.some(({ season }) => season > 1)) return null;
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
  const seasonal = new Map();
  for (const [key, episodes] of bySeries) {
    // Solo la temporada 1: el número absoluto es el mismo del archivo.
    if (!episodes.some(({ season }) => season > 1)) continue;
    seasonal.set(key, null);
    const saved = store.get()[key];
    if (!saved) {
      refresh(key);
      continue;
    }
    let starts = null;
    let counts = null;
    for (const ordering of saved.orderings || []) {
      starts = startsIfFits(ordering, episodes);
      if (starts) {
        counts = ordering.seasons;
        break;
      }
    }
    if (!starts) {
      if (!(Date.now() - Date.parse(saved.fetchedAt) < REFRESH_UNFIT_MS)) refresh(key);
      continue;
    }
    seasonal.set(key, { starts, counts });
    for (const { video, season, episode } of episodes) byId.set(video.id, starts[season] + episode);
  }
  return { byId, seasonal };
}

function current() {
  const videos = catalog.getCatalog();
  if (memo.videos !== videos) memo = { videos, ...compute(videos) };
  return memo;
}

// null si no se conoce (no es "SxxEyy", la serie no está en TMDB, ningún
// reparto encaja, o todavía se está consultando).
function absoluteEpisodeFor(video) {
  return current().byId.get(video.id) ?? null;
}

// Lo contrario, para normalize.js: un archivo que solo trae el número
// absoluto ("Bleach - 274") pasa a su temporada y episodio ({ season: 14,
// episode: 9 }) con el mismo reparto que usa absoluteEpisodeFor, elegido
// porque encaja con los episodios "SxxEyy" que ya tiene la serie.
// - null: la serie no usa temporadas (todo es S01, como Naruto), así que el
//   número absoluto ya es el episodio.
// - false: la serie usa temporadas, pero no se puede convertir (su reparto
//   aún se está consultando, ninguno encaja, o el número se sale de él).
//   Mejor no renombrar que ponerle "S01E274" entre los "S14E08".
function seasonEpisodeFor(video, absolute) {
  const key = catalog.getShowKeyFor(video);
  const { seasonal } = current();
  if (!key || !seasonal.has(key)) return null;
  const ordering = seasonal.get(key);
  if (!ordering) return false;
  for (const [season, before] of Object.entries(ordering.starts)) {
    const episode = absolute - before;
    if (episode >= 1 && episode <= ordering.counts[season]) return { season: Number(season), episode };
  }
  return false;
}

function reloadRegistry() {
  store.reload();
  memo.videos = null;
}

module.exports = { absoluteEpisodeFor, seasonEpisodeFor, reloadRegistry };
