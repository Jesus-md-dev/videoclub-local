const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getVideosPath, VIDEO_EXTENSIONS } = require('./config');

let cache = [];
let byId = new Map();

function makeId(relativePath) {
  return crypto.createHash('sha1').update(relativePath).digest('hex').slice(0, 16);
}

function cleanTitle(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function walk(dir, baseDir, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, baseDir, results);
    } else if (VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      const relativePath = path.relative(baseDir, fullPath);
      const stat = fs.statSync(fullPath);
      const id = makeId(relativePath);
      results.push({
        id,
        title: cleanTitle(entry.name),
        relativePath,
        size: stat.size,
        modifiedAt: stat.mtime,
      });
    }
  }
}

function scan() {
  const videosPath = getVideosPath();
  if (!videosPath) {
    throw new Error('No hay carpeta de vídeos configurada. Ajústala en /config.html o en .env');
  }
  if (!fs.existsSync(videosPath)) {
    throw new Error(`La carpeta configurada no existe: ${videosPath}`);
  }

  const results = [];
  walk(videosPath, videosPath, results);
  results.sort((a, b) => a.title.localeCompare(b.title, 'es'));

  cache = results;
  byId = new Map(results.map((video) => [video.id, video]));
  return cache;
}

function getCatalog() {
  return cache;
}

function getVideoById(id) {
  return byId.get(id);
}

module.exports = { scan, getCatalog, getVideoById };
