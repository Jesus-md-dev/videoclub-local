const fs = require('fs');
const catalog = require('./catalog');
const thumbnails = require('./thumbnails');
const metadata = require('./metadata');
const transcode = require('./transcode');
const { getVideosPath } = require('./config');

const DEBOUNCE_MS = 8000;

let watcher = null;
let debounceTimer = null;

function rescan() {
  try {
    const videos = catalog.scan();
    console.log(`Catálogo actualizado automáticamente: ${videos.length} vídeo(s)`);
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    transcode.warmAll(videos);
  } catch (err) {
    console.error(`Error al reescanear automáticamente: ${err.message}`);
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
