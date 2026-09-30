// Orquestador de "recarga en caliente" (issue #89): generaliza el patrón
// get/reload/set que ya existía en config.js a todos los módulos con caché
// en memoria que hoy solo se cargaban una vez al arrancar. Pensado para
// cuando algo edita los archivos JSON de data/ por fuera de este proceso
// (migración entre PCs, restauración de backup, un script de limpieza
// suelto como el que se usó para quitar duplicados en la sesión que motivó
// esto) - sin esto, había que reiniciar el servidor entero para que el
// cambio se reflejara, cortando generaciones HLS en curso cada vez.
const config = require('./config');
const catalogOverrides = require('./catalogOverrides');
const archivedVideos = require('./archivedVideos');
const movedOriginals = require('./movedOriginals');
const lostVideos = require('./lostVideos');
const mediaInfo = require('./mediaInfo');
const metadata = require('./metadata');
const catalog = require('./catalog');
const episodeNumbers = require('./episodeNumbers');

// Cada reloader por separado y con su propio try/catch: uno corrupto (JSON
// mal formado tras una edición a medias, por ejemplo) no debe impedir que
// el resto se recargue igualmente.
const RELOADERS = {
  videosPath: () => config.reloadVideosPath(),
  tmdbApiKey: () => config.reloadTmdbApiKey(),
  subdlApiKey: () => config.reloadSubdlApiKey(),
  catalogUngrouped: () => catalogOverrides.reloadUngrouped(),
  archivedVideos: () => archivedVideos.reloadRegistry(),
  movedOriginals: () => movedOriginals.reloadRegistry(),
  lostVideos: () => lostVideos.reloadRegistry(),
  mediaInfoStore: () => mediaInfo.reloadStore(),
  metadataCache: () => metadata.reloadCache(),
  metadataOverrides: () => metadata.reloadOverrides(),
  knownShows: () => catalog.reloadKnownShows(),
  episodeNumbering: () => episodeNumbers.reloadRegistry(),
};

// pending (búsquedas TMDB en curso) y memo (caché efímera de mediaInfo.js)
// nunca se tocan aquí a propósito: son estado en vuelo, no cachés de disco.
async function reloadAll({ rescan = true } = {}) {
  const results = {};
  for (const [name, fn] of Object.entries(RELOADERS)) {
    try {
      fn();
      results[name] = 'ok';
    } catch (err) {
      results[name] = `error: ${err.message}`;
    }
  }

  let catalogCount = null;
  if (rescan) {
    // catalogOverrides/archivedVideos afectan directamente a cómo se
    // agrupa/muestra el catálogo - sin volver a escanear, seguiría
    // reflejando el estado de antes de la recarga.
    try {
      const videos = await catalog.scan();
      catalogCount = videos.length;
      results.catalogRescan = 'ok';
    } catch (err) {
      results.catalogRescan = `error: ${err.message}`;
    }
  }

  return { results, catalogCount, reloadedAt: new Date().toISOString() };
}

module.exports = { reloadAll };
