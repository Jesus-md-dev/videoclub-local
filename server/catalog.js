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

function toWebPath(osPath) {
  return osPath.split(path.sep).join('/');
}

function toOsPath(webPath) {
  return webPath.split('/').join(path.sep);
}

// Primer vídeo (recursivo, orden natural por ruta) dentro de una carpeta,
// usado como carátula representativa de esa carpeta.
function firstVideoIn(osFolderPath) {
  const prefix = osFolderPath + path.sep;
  let first = null;
  for (const video of cache) {
    if (!video.relativePath.startsWith(prefix)) continue;
    if (!first || video.relativePath.localeCompare(first.relativePath, 'es', { numeric: true }) < 0) {
      first = video;
    }
  }
  return first;
}

// Lista el contenido directo (subcarpetas + vídeos) de una carpeta del
// catálogo, sin aplanar el árbol completo. `webDir` usa '/' como separador
// independientemente del sistema operativo.
function listDir(webDir = '') {
  const osDir = webDir ? toOsPath(webDir) : '';
  const prefix = osDir ? osDir + path.sep : '';
  const folderMap = new Map();
  const videos = [];

  for (const video of cache) {
    if (prefix && !video.relativePath.startsWith(prefix)) continue;

    const rest = prefix ? video.relativePath.slice(prefix.length) : video.relativePath;
    const parts = rest.split(path.sep);

    if (parts.length === 1) {
      videos.push(video);
    } else {
      const name = parts[0];
      if (!folderMap.has(name)) {
        folderMap.set(name, prefix + name);
      }
    }
  }

  const folders = [...folderMap.entries()]
    .map(([name, osPath]) => ({
      name,
      path: toWebPath(osPath),
      thumbnailId: firstVideoIn(osPath)?.id ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  videos.sort((a, b) => a.title.localeCompare(b.title, 'es'));

  let parent = null;
  if (osDir) {
    const dirname = path.dirname(osDir);
    parent = dirname === '.' ? '' : toWebPath(dirname);
  }

  return { dir: webDir, parent, folders, videos };
}

// Clave de metadatos (TMDb) para un vídeo: el nombre de la carpeta de nivel
// superior si pertenece a una serie, o su propio título si es un vídeo suelto.
function metadataKeyFor(video) {
  const [first] = video.relativePath.split(path.sep);
  const hasFolder = video.relativePath.includes(path.sep);
  return hasFolder ? cleanTitle(first) : video.title;
}

module.exports = { scan, getCatalog, getVideoById, listDir, metadataKeyFor };
