const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const archivedVideos = require('./archivedVideos');
const lostVideos = require('./lostVideos');
const metadata = require('./metadata');
const { DATA_PATH, HLS_PATH, THUMBNAILS_PATH } = require('./config');

const PROGRESS_DIR = path.join(DATA_PATH, 'progress');
const TRICKPLAY_DIR = path.join(DATA_PATH, 'trickplay');

function removeProgressFor(ids) {
  if (!fs.existsSync(PROGRESS_DIR)) return;
  for (const file of fs.readdirSync(PROGRESS_DIR)) {
    const full = path.join(PROGRESS_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }
    let changed = false;
    for (const id of ids) {
      if (data[id]) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(full, JSON.stringify(data, null, 2));
  }
}

// Quita del catálogo una obra completa cuya carpeta se ha borrado a mano
// (p.ej. porque quedaban demasiados episodios perdidos sin solución - ver
// hls.js:isLost / lostVideos.js). A diferencia de borrar un archivo
// suelto, esto hace falta de forma explícita: los vídeos "archivados"
// (HLS sin original, ver archivedVideos.js) sobreviven a propósito a que
// su carpeta desaparezca del escaneo, así que sin esto seguirían
// apareciendo en el catálogo para siempre por mucho que se borre en disco.
function purgeKey(key) {
  const { videos } = catalog.listDir(key);
  if (!videos.length) return { removed: 0 };

  const ids = videos.map((v) => v.id);
  for (const video of videos) {
    archivedVideos.forget(video.id);
    lostVideos.forget(video.id);
    fs.rmSync(path.join(HLS_PATH, video.id), { recursive: true, force: true });
    fs.rmSync(path.join(THUMBNAILS_PATH, `${video.id}.jpg`), { force: true });
    fs.rmSync(path.join(TRICKPLAY_DIR, `${video.id}.json`), { force: true });
    fs.rmSync(path.join(TRICKPLAY_DIR, `${video.id}.jpg`), { force: true });
  }
  removeProgressFor(ids);
  metadata.forgetMetadata(key);
  catalog.scan();
  return { removed: ids.length };
}

module.exports = { purgeKey };
