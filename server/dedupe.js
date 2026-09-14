const fs = require('fs');
const path = require('path');
const { DATA_PATH, THUMBNAILS_PATH, getVideosPath } = require('./config');
const catalog = require('./catalog');
const thumbnails = require('./thumbnails');

const PROGRESS_DIR = path.join(DATA_PATH, 'progress');
const TRICKPLAY_DIR = path.join(DATA_PATH, 'trickplay');

// El id de un vídeo sale de un hash de su ruta relativa (con extensión
// incluida), así que cambiar la extensión (p.ej. .mkv -> .mp4) cambia el
// id. Migrar el progreso/carátula/vista previa del id viejo al nuevo evita
// perderlos, sin tener que rehacer el id de TODA la biblioteca (eso sí
// invalidaría de golpe el progreso/caché de todo lo demás).
function migrateProgress(oldId, newId) {
  if (!fs.existsSync(PROGRESS_DIR)) return;
  for (const file of fs.readdirSync(PROGRESS_DIR)) {
    const full = path.join(PROGRESS_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }
    if (data[oldId]) {
      data[newId] = { ...data[oldId], ...(data[newId] || {}) };
      delete data[oldId];
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
    }
  }
}

function migrateFile(oldPath, newPath) {
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
  }
}

// Sustituye el archivo original de un vídeo por su versión ya convertida
// (recibida en `transcodedFile`, la ruta del archivo ya listo), para no
// tener las dos copias ocupando espacio (la convertida suele pesar mucho
// menos, sobre todo en 4K/HDR). No depende de transcode.js a propósito
// (evita una dependencia circular: transcode.js llama a esto justo después
// de terminar una conversión).
//
// Devuelve { oldId, newId, relativePath }. Si el id cambia (cambió la
// extensión), migra progreso/carátula/vista previa al id nuevo.
async function replaceWithTranscoded(video, transcodedFile, { keepBackup = true } = {}) {
  if (!transcodedFile || !fs.existsSync(transcodedFile)) {
    throw new Error('Este vídeo todavía no tiene una conversión lista para sustituirlo.');
  }

  const videosPath = getVideosPath();
  const oldAbsPath = path.join(videosPath, video.relativePath);
  const dir = path.dirname(video.relativePath);
  const baseName = path.basename(video.relativePath, path.extname(video.relativePath));
  const newRelativePath = dir === '.' ? `${baseName}.mp4` : path.join(dir, `${baseName}.mp4`);
  const newAbsPath = path.join(videosPath, newRelativePath);

  if (!fs.existsSync(oldAbsPath)) {
    throw new Error('No se encuentra el archivo original en disco.');
  }
  if (path.resolve(newAbsPath) !== path.resolve(oldAbsPath) && fs.existsSync(newAbsPath)) {
    throw new Error(`Ya existe un archivo en "${newRelativePath}"; cancelado por seguridad.`);
  }

  const backupPath = `${oldAbsPath}.bak`;
  if (fs.existsSync(backupPath)) {
    throw new Error(`Ya existe una copia de seguridad en "${backupPath}"; revísala antes de continuar.`);
  }

  const oldId = video.id;
  fs.renameSync(oldAbsPath, backupPath);
  fs.renameSync(transcodedFile, newAbsPath);
  if (!keepBackup) fs.rmSync(backupPath, { force: true });

  // Re-escanea para que el catálogo calcule el id (nuevo o el mismo, según
  // si cambió la extensión) a partir del archivo ya sustituido en su sitio.
  await catalog.scan();
  const newVideo = catalog.getCatalog().find((v) => v.relativePath === newRelativePath);
  const newId = newVideo ? newVideo.id : oldId;

  if (newId !== oldId) {
    migrateProgress(oldId, newId);
    thumbnails.forget(oldId);
    migrateFile(path.join(THUMBNAILS_PATH, `${oldId}.jpg`), path.join(THUMBNAILS_PATH, `${newId}.jpg`));
    migrateFile(path.join(TRICKPLAY_DIR, `${oldId}.json`), path.join(TRICKPLAY_DIR, `${newId}.json`));
    migrateFile(path.join(TRICKPLAY_DIR, `${oldId}.jpg`), path.join(TRICKPLAY_DIR, `${newId}.jpg`));
  }

  return { oldId, newId, relativePath: newRelativePath, backupPath: keepBackup ? backupPath : null };
}

module.exports = { replaceWithTranscoded };
