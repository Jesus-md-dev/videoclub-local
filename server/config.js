const fs = require('fs');
const path = require('path');
// Sin `path`, dotenv busca ".env" relativo al directorio de trabajo desde
// el que se lanzó "node" (process.cwd()), no a la carpeta del proyecto:
// arrancar el servidor desde otro sitio (p.ej. "cd client && ... && cd ..
// && node server\index.js" en la misma sesión de terminal, sin volver a
// "cd" explícito) hacía que TRANSCODED_PATH/HLS_PATH del .env se
// ignorasen en silencio (dotenv no avisa si no encuentra el archivo) y
// todo volviera a generarse dentro de data/, local a esta máquina.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;

// Busca una carpeta con ese nombre en la raíz de cualquier unidad disponible
// (C: a Z:). Pensado para el disco externo (USB): la letra que Windows le
// asigna puede cambiar de un PC a otro (visto en producción: mismo disco
// físico, D: en un PC, E: en otro), así que fijar la letra en el .env de
// cada máquina se rompía sin avisar al cambiar de sitio y dejaba el
// servidor leyendo (o, peor, escribiendo) en la carpeta local por defecto
// sin que nadie se diera cuenta hasta perder progreso/carátulas. Buscar por
// nombre en vez de por letra fija hace que encontrarla sea automático.
function findDriveWithFolder(folderName) {
  for (let code = 67; code <= 90; code += 1) {
    // 67 = 'C', evita A/B (disqueteras históricas, a veces lentas de sondear)
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(drive) && fs.existsSync(path.join(drive, folderName))) {
        return path.join(drive, folderName);
      }
    } catch {
      // Unidad no disponible (lector óptico vacío, red desconectada...): se ignora.
    }
  }
  return null;
}

// Perfiles, progreso, carátulas, vista previa al arrastrar... Por defecto se
// busca automáticamente una carpeta "VideoclubDatos" en cualquier unidad
// (pensada para vivir en el disco externo, junto a la biblioteca, así viaja
// sola al cambiar de PC/servidor); DATA_PATH en .env la fija a mano si hace
// falta, y si no se encuentra ninguna cae a data/ dentro del proyecto (local
// a esta máquina, como al principio).
const DATA_PATH = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH)
  : findDriveWithFolder('VideoclubDatos') || path.join(__dirname, '..', 'data');
const THUMBNAILS_PATH = path.join(DATA_PATH, 'thumbnails');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');
// Los vídeos ya convertidos pueden ocupar mucho (decenas/cientos de GB):
// por defecto se busca una carpeta "VideoclubTranscoded" en cualquier
// unidad (igual razón que DATA_PATH/VIDEOS_PATH: no depender de la letra
// que le toque al disco externo en cada PC), y si no se encuentra ninguna
// cae dentro de DATA_PATH.
const TRANSCODED_PATH = process.env.TRANSCODED_PATH
  ? path.resolve(process.env.TRANSCODED_PATH)
  : findDriveWithFolder('VideoclubTranscoded') || path.join(DATA_PATH, 'transcoded');
// Igual que TRANSCODED_PATH: los paquetes HLS (segmentos de vídeo + una
// pista aparte por cada idioma de audio) también pueden ocupar mucho. Un
// HLS generado en un PC cuyo HLS_PATH no llegara a resolver aquí (p.ej. si
// cayera en la carpeta local de esa máquina en vez del disco externo)
// dejaría, tras archivar el original, un vídeo sin ninguna copia accesible
// desde otro PC - visto en producción con 212 episodios (#68).
const HLS_PATH = process.env.HLS_PATH
  ? path.resolve(process.env.HLS_PATH)
  : findDriveWithFolder('VideoclubHLS') || path.join(DATA_PATH, 'hls');

// Carpeta de respaldo frío para los originales ya con HLS listo (ver
// moveOriginal.js/movedOriginals.js/scripts/mover-originales-a-d.js):
// opcional a propósito, sin ella el traslado automático simplemente no hace
// nada (los originales se quedan donde siempre). A diferencia de
// DATA_PATH/TRANSCODED_PATH/HLS_PATH no tiene fallback local: si no se
// encuentra la carpeta "VideoclubOriginales" en ningún disco, es que no está
// configurada, no un error - no tendría sentido inventar una ruta local
// para algo pensado justo para sacar peso del disco de la biblioteca.
const MOVED_ORIGINALS_PATH = process.env.MOVED_ORIGINALS_PATH
  ? path.resolve(process.env.MOVED_ORIGINALS_PATH)
  : findDriveWithFolder('VideoclubOriginales');

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v'];

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function initialVideosPath() {
  const stored = readSettings().videosPath;
  // La ruta guardada lleva la letra de unidad de la máquina donde se guardó
  // - si ya no existe (disco reconectado con otra letra, típico al cambiar
  // de PC), no sirve de nada insistir en ella: se busca de nuevo por nombre
  // en vez de dejar el servidor sin biblioteca hasta que alguien lo note y
  // lo reconfigure a mano.
  if (stored && fs.existsSync(stored)) return path.resolve(stored);
  if (process.env.VIDEOS_PATH && fs.existsSync(process.env.VIDEOS_PATH)) {
    return path.resolve(process.env.VIDEOS_PATH);
  }
  const found = findDriveWithFolder('Videoclub');
  if (found) return found;
  // Nada disponible ahora mismo: mejor devolver lo guardado (aunque no
  // exista en este instante, p.ej. el USB tarda un poco en montarse) que
  // nada, para no perder de vista cuál era la carpeta configurada.
  if (stored) return path.resolve(stored);
  return null;
}

let currentVideosPath = initialVideosPath();

function getVideosPath() {
  return currentVideosPath;
}

// Se llama tras restaurar settings.json desde la copia de seguridad, para
// que la carpeta de vídeos recuperada se tenga en cuenta sin reiniciar.
function reloadVideosPath() {
  currentVideosPath = initialVideosPath();
  return currentVideosPath;
}

function setVideosPath(newPath) {
  const resolved = path.resolve(newPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`La carpeta no existe: ${resolved}`);
  }
  fs.mkdirSync(DATA_PATH, { recursive: true });
  // Se combina con lo que ya hubiera en settings.json (p.ej. tmdbApiKey):
  // sobrescribir el archivo entero aquí lo borraría sin querer.
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readSettings(), videosPath: resolved }, null, 2));
  currentVideosPath = resolved;
  return currentVideosPath;
}

// La clave de TMDB (búsqueda de nombre/carátula/género bastante más
// precisa que el respaldo sin clave) se guarda igual que la carpeta de
// vídeos: en settings.json, dentro de DATA_PATH - así, ahora que DATA_PATH
// vive en el disco externo, viaja con la biblioteca a cualquier PC/servidor
// sin tener que volver a crear un .env a mano cada vez. TMDB_API_KEY en
// .env sigue funcionando como alternativa si no hay ninguna guardada así.
function initialTmdbApiKey() {
  const stored = readSettings().tmdbApiKey;
  if (stored) return stored;
  return process.env.TMDB_API_KEY || null;
}

let currentTmdbApiKey = initialTmdbApiKey();

function getTmdbApiKey() {
  return currentTmdbApiKey;
}

function reloadTmdbApiKey() {
  currentTmdbApiKey = initialTmdbApiKey();
  return currentTmdbApiKey;
}

function setTmdbApiKey(key) {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  fs.mkdirSync(DATA_PATH, { recursive: true });
  const settings = { ...readSettings() };
  if (trimmed) settings.tmdbApiKey = trimmed;
  else delete settings.tmdbApiKey;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  currentTmdbApiKey = trimmed || process.env.TMDB_API_KEY || null;
  return currentTmdbApiKey;
}

// Clave de API de SubDL (para buscar/descargar subtítulos de mejor calidad
// que solo los que ya lleve incrustados el archivo, ver subdl.js): igual
// patrón que TMDB, guardada en settings.json (DATA_PATH, disco externo).
function initialSubdlApiKey() {
  const stored = readSettings().subdlApiKey;
  if (stored) return stored;
  return process.env.SUBDL_API_KEY || null;
}

let currentSubdlApiKey = initialSubdlApiKey();

function getSubdlApiKey() {
  return currentSubdlApiKey;
}

function reloadSubdlApiKey() {
  currentSubdlApiKey = initialSubdlApiKey();
  return currentSubdlApiKey;
}

function setSubdlApiKey(key) {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  fs.mkdirSync(DATA_PATH, { recursive: true });
  const settings = { ...readSettings() };
  if (trimmed) settings.subdlApiKey = trimmed;
  else delete settings.subdlApiKey;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  currentSubdlApiKey = trimmed || process.env.SUBDL_API_KEY || null;
  return currentSubdlApiKey;
}

module.exports = {
  PORT,
  HTTPS_PORT,
  DATA_PATH,
  THUMBNAILS_PATH,
  TRANSCODED_PATH,
  HLS_PATH,
  MOVED_ORIGINALS_PATH,
  VIDEO_EXTENSIONS,
  getVideosPath,
  setVideosPath,
  reloadVideosPath,
  getTmdbApiKey,
  setTmdbApiKey,
  reloadTmdbApiKey,
  getSubdlApiKey,
  setSubdlApiKey,
  reloadSubdlApiKey,
};
