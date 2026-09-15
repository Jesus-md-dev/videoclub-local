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

// Perfiles, progreso, carátulas, vista previa al arrastrar... por defecto
// vive dentro del proyecto (local a esta máquina), pero se puede mover a
// otro disco (p.ej. el mismo externo que la biblioteca de vídeos) igual que
// TRANSCODED_PATH/HLS_PATH - así sobrevive a mover el proyecto a otro
// PC/servidor sin depender de la copia de seguridad periódica (backup.js)
// para tenerlo al día.
const DATA_PATH = process.env.DATA_PATH ? path.resolve(process.env.DATA_PATH) : path.join(__dirname, '..', 'data');
const THUMBNAILS_PATH = path.join(DATA_PATH, 'thumbnails');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');
// Los vídeos ya convertidos pueden ocupar mucho (decenas/cientos de GB):
// por defecto viven dentro de data/, pero se puede mover a otro disco con
// más sitio libre sin tocar los archivos originales de la biblioteca.
const TRANSCODED_PATH = process.env.TRANSCODED_PATH
  ? path.resolve(process.env.TRANSCODED_PATH)
  : path.join(DATA_PATH, 'transcoded');
// Igual que TRANSCODED_PATH: los paquetes HLS (segmentos de vídeo + una
// pista aparte por cada idioma de audio) también pueden ocupar mucho.
const HLS_PATH = process.env.HLS_PATH ? path.resolve(process.env.HLS_PATH) : path.join(DATA_PATH, 'hls');

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
  if (stored) return path.resolve(stored);
  if (process.env.VIDEOS_PATH) return path.resolve(process.env.VIDEOS_PATH);
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
