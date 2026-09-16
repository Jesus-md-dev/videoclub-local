const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

// Vídeos cuyo archivo original se borró tras generar su HLS (solo pasa
// cuando el vídeo ya era H.264 compatible: el HLS es un simple remux del
// mismo vídeo, así que conservar los dos era tener el mismo vídeo dos
// veces). catalog.js los sigue listando a partir de aquí, no de un
// escaneo de disco (el archivo ya no está) - por eso esto tiene que
// sobrevivir a un reinicio/cambio de servidor igual que perfiles o
// progreso (ver backup.js).
const FILE = path.join(DATA_PATH, 'hls-archived.json');

let registry = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function save() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(registry, null, 2));
}

function archive(video) {
  registry[video.id] = {
    relativePath: video.relativePath,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
  };
  save();
}

function isArchived(id) {
  return Boolean(registry[id]);
}

function getAll() {
  return registry;
}

// Para purgar del todo una obra cuya carpeta se ha borrado a mano (ver
// purge.js): sin esto, catalog.js la seguiría añadiendo de vuelta al
// catálogo para siempre a partir de este registro, aunque ya no quede ni
// rastro suyo en disco.
function forget(id) {
  if (!registry[id]) return;
  delete registry[id];
  save();
}

// Para normalize.js: un vídeo archivado no tiene archivo real que renombrar
// (se borró al generar su HLS), pero sí conviene poder corregirle el
// nombre/ruta "virtual" que sigue mostrando el catálogo - si no, se queda
// para siempre con el nombre de antes de archivarlo, desentonando con sus
// hermanos si luego se normaliza el resto de la serie. oldId/newId pueden
// coincidir (si la ruta nueva da la casualidad de tener el mismo hash, muy
// raro) - se soporta igualmente.
function rename(oldId, newId, info) {
  if (!registry[oldId]) return;
  delete registry[oldId];
  registry[newId] = info;
  save();
}

// Para POST /api/admin/reload (ver adminReload.js): recarga desde disco por
// si algo editó hls-archived.json por fuera de este proceso (migración,
// restauración de backup...) sin tener que reiniciar el servidor entero.
function reloadRegistry() {
  registry = load();
}

module.exports = { archive, isArchived, getAll, forget, rename, reloadRegistry };
