const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const archivedVideos = require('./archivedVideos');
const movedOriginals = require('./movedOriginals');
const lostVideos = require('./lostVideos');
const hls = require('./hls');
const thumbnails = require('./thumbnails');
const metadata = require('./metadata');
const subtitles = require('./subtitles');
const subdl = require('./subdl');
const localSubtitles = require('./localSubtitles');
const mediaInfo = require('./mediaInfo');
const { DATA_PATH, HLS_PATH, THUMBNAILS_PATH } = require('./config');
const { removeProgressIds } = require('./progressStore');
const { unlinkIfExists } = require('./fsUtils');

const TRICKPLAY_DIR = path.join(DATA_PATH, 'trickplay');

// Limpieza compartida por purgeKey y deleteContent (ver más abajo): todo lo
// que cuelga del id de un vídeo salvo el propio archivo de vídeo original.
function forgetVideo(video) {
  archivedVideos.forget(video.id);
  movedOriginals.forget(video.id);
  lostVideos.forget(video.id);
  hls.forget(video.id);
  thumbnails.forget(video.id);
  subdl.forget(video.id);
  localSubtitles.forget(video.id);
  subtitles.removeAllFor(video.id);
  fs.rmSync(path.join(HLS_PATH, video.id), { recursive: true, force: true });
  fs.rmSync(path.join(THUMBNAILS_PATH, `${video.id}.jpg`), { force: true });
  fs.rmSync(path.join(TRICKPLAY_DIR, `${video.id}.json`), { force: true });
  fs.rmSync(path.join(TRICKPLAY_DIR, `${video.id}.jpg`), { force: true });
}

// Quita del catálogo una obra completa cuya carpeta se ha borrado a mano
// (p.ej. porque quedaban demasiados episodios perdidos sin solución - ver
// hls.js:isLost / lostVideos.js). A diferencia de borrar un archivo
// suelto, esto hace falta de forma explícita: los vídeos "archivados"
// (HLS sin original, ver archivedVideos.js) sobreviven a propósito a que
// su carpeta desaparezca del escaneo, así que sin esto seguirían
// apareciendo en el catálogo para siempre por mucho que se borre en disco.
async function purgeKey(key) {
  const videos = catalog.videosForKey(key);
  if (!videos.length) return { removed: 0 };

  const ids = videos.map((v) => v.id);
  for (const video of videos) forgetVideo(video);
  removeProgressIds(ids);
  metadata.forgetMetadata(key);
  catalog.forgetShow(key);
  await catalog.scan();
  return { removed: ids.length };
}

// Borrado real y definitivo de una obra: a diferencia de purgeKey (solo
// para cuando el archivo original YA no existe en disco), esto además
// borra el propio archivo de vídeo de donde esté de verdad -su carpeta
// original, o el disco al que se haya trasladado para ahorrar espacio, ver
// moveOriginal.js/movedOriginals.js- antes de hacer la misma limpieza de
// metadatos/HLS/subtítulos/caché. Un vídeo ya "archivado" (su original se
// borró hace tiempo al generar su HLS, ver archivedVideos.js) no tiene
// ningún archivo que borrar aquí, solo la limpieza de metadatos de
// siempre.
//
// Pensado para llamarse solo tras confirmar de verdad la intención de
// borrar (ver routes/purge.js: exige repetir el título exacto tanto en el
// cliente como -otra vez- en el propio servidor), no como un botón de un
// solo clic: el archivo de vídeo original no tiene papelera ni deshacer.
async function deleteContent(key) {
  const videos = catalog.videosForKey(key);
  if (!videos.length) return { removed: 0, filesDeleted: 0 };

  const ids = videos.map((v) => v.id);
  let filesDeleted = 0;
  for (const video of videos) {
    if (!archivedVideos.isArchived(video.id)) {
      const realPath = mediaInfo.inputPathFor(video);
      if (realPath && fs.existsSync(realPath)) {
        unlinkIfExists(realPath);
        filesDeleted += 1;
      }
    }
    forgetVideo(video);
  }
  removeProgressIds(ids);
  metadata.forgetMetadata(key);
  catalog.forgetShow(key);
  await catalog.scan();
  return { removed: ids.length, filesDeleted };
}

// Igual que deleteContent pero para UN solo vídeo (un episodio suelto, no
// la serie entera) - pensado para el botón de borrar en la ficha rápida de
// un episodio/película (QuickInfoModal), donde pedir el título exacto
// sería demasiado para un borrado puntual. No toca el caché de metadatos
// de la serie (metadata.forgetMetadata): al quedar el resto de episodios,
// su carátula/género siguen siendo válidos.
async function deleteVideo(id) {
  const video = catalog.getVideoById(id);
  if (!video) return { removed: 0, fileDeleted: false };

  let fileDeleted = false;
  if (!archivedVideos.isArchived(video.id)) {
    const realPath = mediaInfo.inputPathFor(video);
    if (realPath && fs.existsSync(realPath)) {
      unlinkIfExists(realPath);
      fileDeleted = true;
    }
  }
  forgetVideo(video);
  removeProgressIds([video.id]);
  await catalog.scan();
  return { removed: 1, fileDeleted, title: video.title };
}

module.exports = { purgeKey, deleteContent, deleteVideo };
