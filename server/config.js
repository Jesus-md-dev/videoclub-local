const fs = require('fs');
const path = require('path');
require('dotenv').config();

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
  VIDEO_EXTENSIONS,
  getVideosPath,
  setVideosPath,
};
