const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PORT = parseInt(process.env.PORT, 10) || 3000;

const DATA_PATH = path.join(__dirname, '..', 'data');
const THUMBNAILS_PATH = path.join(DATA_PATH, 'thumbnails');
const SETTINGS_FILE = path.join(DATA_PATH, 'settings.json');

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
  DATA_PATH,
  THUMBNAILS_PATH,
  VIDEO_EXTENSIONS,
  getVideosPath,
  setVideosPath,
};
