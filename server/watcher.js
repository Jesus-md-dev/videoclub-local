const fs = require('fs');
const catalog = require('./catalog');
const thumbnails = require('./thumbnails');
const metadata = require('./metadata');
const hls = require('./hls');
const normalize = require('./normalize');
const { getVideosPath } = require('./config');

// Cada reescaneo es síncrono sobre toda la biblioteca (miles de vídeos) y
// bloquea el servidor entero mientras dura - con la carpeta de vídeos en
// un disco externo, y sobre todo durante rachas largas de archivado en
// segundo plano (que borra el original de cada vídeo compatible, un
// cambio detectado por este mismo vigilante), 8s de margen no bastaba:
// llegaban cambios sueltos más separados que eso, así que cada uno
// disparaba su propio reescaneo, y varios seguidos dejaban el servidor
// sin responder ratos largos. Con más margen, una racha de cambios se
// agrupa en muchos menos reescaneos.
const DEBOUNCE_MS = 30000;

let watcher = null;
let debounceTimer = null;
// Por si el temporizador de abajo dispara un reescaneo nuevo mientras el
// anterior todavía sigue esperando al disco (catalog.scan es asíncrono
// pero no instantáneo): evita dos reescaneos completos solapados a la vez.
let scanning = false;

async function rescan() {
  if (scanning) return;
  scanning = true;
  try {
    const previousIds = new Set(catalog.getCatalog().map((v) => v.id));
    let videos = await catalog.scan();

    // Solo archivos nuevos (no estaban antes de este reescaneo): si el
    // nombre tiene pinta de venir "en bruto" (release, sin limpiar), se
    // renombra ya mismo, antes de generar carátula/HLS para ellos - así no
    // hay nada que migrar ni doble trabajo. La biblioteca ya existente NO se
    // toca sola nunca: para eso está el botón "Normalizar nombres" en
    // /config, que sí se puede revisar/lanzar a mano.
    const renamedAny = await normalize.autoNormalizeNewFiles(videos, previousIds);
    if (renamedAny) videos = await catalog.scan();

    console.log(`Catálogo actualizado automáticamente: ${videos.length} vídeo(s)`);
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    hls.warmAll(videos);
  } catch (err) {
    console.error(`Error al reescanear automáticamente: ${err.message}`);
  } finally {
    scanning = false;
  }
}

function scheduleRescan() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rescan, DEBOUNCE_MS);
}

// Vigila la carpeta de vídeos configurada y reescanea sola cuando detecta
// cambios (copiar/borrar/mover archivos), con un margen de espera para no
// reescanear en bucle mientras se está copiando algo grande.
function start() {
  stop();

  const videosPath = getVideosPath();
  if (!videosPath) return;

  try {
    watcher = fs.watch(videosPath, { recursive: true }, () => {
      scheduleRescan();
    });
    watcher.on('error', (err) => {
      console.warn(`El vigilante de la carpeta de vídeos dejó de funcionar: ${err.message}`);
    });
  } catch (err) {
    console.warn(`No se pudo vigilar la carpeta de vídeos (el reescaneo manual sigue funcionando): ${err.message}`);
  }
}

function stop() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  clearTimeout(debounceTimer);
}

module.exports = { start, stop };
