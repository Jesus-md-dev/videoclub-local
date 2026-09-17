const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

// Vídeos cuyo archivo original SÍ existe de verdad, pero se trasladó fuera
// de getVideosPath() (a otro disco, ver scripts/mover-originales-a-d.js)
// para ahorrar espacio en el disco externo una vez su HLS ya está listo. A
// diferencia de archivedVideos.js (vídeos SIN ninguna copia real, solo su
// HLS), aquí sí hay un archivo real en `absolutePath` - simplemente no está
// bajo la carpeta de vídeos, así que el escaneo normal (catalog.js: walk())
// no lo encuentra por sí solo.
//
// Vive en un registro aparte, igual que archivedVideos.js, para que el
// catálogo NO dependa de que ese otro disco esté conectado en el momento de
// escanear: si se desconecta, el vídeo sigue apareciendo en la web con los
// datos ya conocidos (carátula, género, seguir viendo con su HLS...), en
// vez de desaparecer hasta que se reconecte y se vuelva a escanear.
const FILE = path.join(DATA_PATH, 'moved-originals.json');

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

function register(video, absolutePath) {
  registry[video.id] = {
    relativePath: video.relativePath,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    absolutePath,
  };
  save();
}

function get(id) {
  return registry[id] || null;
}

function isMoved(id) {
  return Boolean(registry[id]);
}

function getAll() {
  return registry;
}

// Para purgar del todo una obra cuya carpeta se ha borrado a mano (ver
// purge.js) o que se ha traído de vuelta al disco principal: sin esto,
// catalog.js la seguiría añadiendo al catálogo para siempre a partir de
// este registro.
function forget(id) {
  if (!registry[id]) return;
  delete registry[id];
  save();
}

// Mismo patrón que archivedVideos.js: para normalize.js, poder renombrar el
// nombre/ruta "virtual" que sigue mostrando el catálogo aunque el archivo
// real ya no viva bajo getVideosPath().
function rename(oldId, newId, info, absolutePath) {
  if (!registry[oldId]) return;
  delete registry[oldId];
  registry[newId] = { ...info, absolutePath };
  save();
}

// Para POST /api/admin/reload: recarga desde disco por si algo editó
// moved-originals.json por fuera de este proceso sin reiniciar el servidor.
function reloadRegistry() {
  registry = load();
}

module.exports = { register, get, isMoved, getAll, forget, rename, reloadRegistry };
