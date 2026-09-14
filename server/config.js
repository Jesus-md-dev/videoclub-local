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

const DATA_PATH = path.join(__dirname, '..', 'data');
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
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ videosPath: resolved }, null, 2));
  currentVideosPath = resolved;
  return currentVideosPath;
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
};
