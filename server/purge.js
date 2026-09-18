const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const archivedVideos = require('./archivedVideos');
const lostVideos = require('./lostVideos');
const hls = require('./hls');
const thumbnails = require('./thumbnails');
const metadata = require('./metadata');
const { DATA_PATH, HLS_PATH, THUMBNAILS_PATH } = require('./config');
const { removeProgressIds } = require('./progressStore');

const TRICKPLAY_DIR = path.join(DATA_PATH, 'trickplay');

// Quita del catálogo una obra completa cuya carpeta se ha borrado a mano
// (p.ej. porque quedaban demasiados episodios perdidos sin solución - ver
// hls.js:isLost / lostVideos.js). A diferencia de borrar un archivo
// suelto, esto hace falta de forma explícita: los vídeos "archivados"
// (HLS sin original, ver archivedVideos.js) sobreviven a propósito a que
// su carpeta desaparezca del escaneo, así que sin esto seguirían
// apareciendo en el catálogo para siempre por mucho que se borre en disco.
async function purgeKey(key) {
  const { videos } = catalog.listDir(key);
  if (!videos.length) return { removed: 0 };

  const ids = videos.map((v) => v.id);
  for (const video of videos) {
    archivedVideos.forget(video.id);
    lostVideos.forget(video.id);
    hls.forget(video.id);
    thumbnails.forget(video.id);
    fs.rmSync(path.join(HLS_PATH, video.id), { recursive: true, force: true });
    fs.rmSync(path.join(THUMBNAILS_PATH, `${video.id}.jpg`), { force: true });
    fs.rmSync(path.join(TRICKPLAY_DIR, `${video.id}.json`), { force: true });
    fs.rmSync(path.join(TRICKPLAY_DIR, `${video.id}.jpg`), { force: true });
  }
  removeProgressIds(ids);
  metadata.forgetMetadata(key);
  await catalog.scan();
  return { removed: ids.length };
}

module.exports = { purgeKey };
