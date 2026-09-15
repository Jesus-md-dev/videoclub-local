const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getVideosPath, VIDEO_EXTENSIONS } = require('./config');
const archivedVideos = require('./archivedVideos');
const catalogOverrides = require('./catalogOverrides');

let cache = [];
let byId = new Map();
let showsList = []; // agrupaciones con más de un vídeo (series/anime)
let moviesList = []; // vídeos sueltos (películas)
let showVideos = new Map(); // clave de serie -> vídeos ordenados

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

// Nombres de carpeta que son categorías genéricas, no el título de una obra
// concreta (p.ej. "Anime", "Peliculas"). Se ignoran al buscar la clave de
// agrupación de un vídeo, para no acabar agrupando por "Anime" o "Peliculas"
// en vez del título real.
const GENERIC_FOLDER_NAMES = new Set([
  'anime', 'peliculas', 'películas', 'pelis', 'series', 'movies', 'movie',
  'tv', 'shows', 'videos', 'video', 'films', 'film', 'dorama', 'doramas',
  // Variantes de idioma/audio, habituales como subcarpeta dentro de una categoría.
  'castellano', 'español', 'espanol', 'latino', 'subtitulado', 'subtitulados',
  'vose', 'dual', 'japones', 'japonés', 'ingles', 'inglés',
]);

// Subcarpetas por arco/temporada/tanda de episodios dentro de una misma obra
// (ej. "[442-489] Thriller Bark", "Temporada 2", "Season 3", "Arc 5"): no son
// el nombre de la obra, sino una subdivisión suya, así que también se tratan
// como genéricas para que la agrupación siga subiendo hasta el nombre real.
const RANGE_OR_SEASON_PATTERN =
  /^\[?\(?\s*\d+\s*[-–]\s*\d+\s*\)?\]?(\s|$)|^(temporada|season|arco|arc|saga|cour|parte|part|volumen|vol)\.?\s*\d+(\s|$)/i;

function isGenericFolderName(name) {
  const clean = name.trim().toLowerCase();
  return GENERIC_FOLDER_NAMES.has(clean) || RANGE_OR_SEASON_PATTERN.test(clean);
}

// Clave de agrupación para un vídeo: el nombre de la carpeta contenedora más
// específica (la más profunda que no sea una categoría genérica), asumiendo
// que agrupa otros vídeos de la misma obra (ej. episodios de una serie). Si
// no hay ninguna carpeta así en la ruta, se usa el propio título del
// archivo. No se asume de antemano si es serie o película por estructura de
// carpetas: eso lo decide cuántos vídeos comparten la clave y la propia
// búsqueda de metadatos.
function groupKeyFor(video) {
  const folderSegments = video.relativePath.split(path.sep).slice(0, -1);
  for (let i = folderSegments.length - 1; i >= 0; i -= 1) {
    const name = cleanTitle(folderSegments[i]);
    if (!isGenericFolderName(name)) {
      // Carpeta marcada como "no es una serie, son varios títulos sueltos"
      // (ver catalogOverrides.js, p.ej. "Berserk" con sus 3 películas de
      // "La Edad de Oro"): cada vídeo usa su propio título como clave, así
      // que buildLibrary() los trata como películas independientes en vez
      // de agruparlos todos bajo la misma carpeta.
      if (catalogOverrides.isUngrouped(name)) return video.title;
      return name;
    }
  }
  return video.title;
}

// Asíncrono a propósito (fs.promises, no fs...Sync): con la carpeta de
// vídeos en un disco externo, una sola llamada síncrona lenta (el disco
// saturado por streaming/conversión/copia a la vez) bloqueaba el bucle de
// eventos de Node entero mientras duraba - el servidor se quedaba sin
// responder a NINGUNA petición, a veces varios segundos, a veces mucho
// más. Con await, solo esta función concreta espera; el resto del
// servidor sigue atendiendo peticiones mientras tanto.
async function walk(baseDir) {
  const entries = await fs.promises.readdir(baseDir, { recursive: true, withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    const parentDir = entry.parentPath ?? entry.path;
    const fullPath = path.join(parentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.promises.stat(fullPath);
    const id = makeId(relativePath);
    results.push({
      id,
      title: cleanTitle(entry.name),
      relativePath,
      size: stat.size,
      modifiedAt: stat.mtime,
    });
  }
  return results;
}

// Agrupa el catálogo por `groupKeyFor`: las claves con más de un vídeo se
// tratan como series/anime (mostradas como carpeta), y las de un único
// vídeo como películas sueltas. Esto ignora la carpeta física real en la
// que esté cada archivo: la agrupación es por lo detectado, no por disco.
function buildLibrary() {
  const groups = new Map();
  for (const video of cache) {
    const key = groupKeyFor(video);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }

  showsList = [];
  moviesList = [];
  showVideos = new Map();

  for (const [key, videos] of groups) {
    videos.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'es', { numeric: true }));

    if (videos.length > 1) {
      showsList.push({ name: key, path: key, thumbnailId: videos[0].id });
      showVideos.set(key, videos);
    } else {
      moviesList.push(videos[0]);
    }
  }

  showsList.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  moviesList.sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

// Un archivo que se está copiando/moviendo a la carpeta de vídeos (tamaño
// todavía creciendo) no se muestra en el catálogo ni se procesa hasta que
// termina: incluirlo a medias generaba ruido ("Permission denied" al
// intentar leerlo mientras Windows lo tiene bloqueado por el propio
// proceso de copia) y, peor, arriesgaba analizarlo/generar su carátula con
// datos incompletos si el tamaño se quedaba quieto un instante a medio
// copiar. Un archivo con el mtime reciente (menos de 2 minutos) se trata
// con cautela: solo se da por "listo" cuando su tamaño coincide con el que
// tenía en el escaneo anterior. El historial vive en memoria (se pierde al
// reiniciar el servidor), así que fiarse solo de "¿tengo historial
// previo?" ocultaría TODA la biblioteca en el primer escaneo tras cada
// reinicio - por eso un mtime ya antiguo se da por estable directamente,
// sin depender de ese historial.
const RECENT_MS = 2 * 60 * 1000;
const sizeHistory = new Map(); // video.id -> tamaño visto en el escaneo anterior

function filterStableFiles(results) {
  const now = Date.now();
  const stillCopyingIds = new Set();
  const seenNow = new Set();
  for (const video of results) {
    seenNow.add(video.id);
    const isRecent = now - new Date(video.modifiedAt).getTime() < RECENT_MS;
    if (isRecent) {
      const previousSize = sizeHistory.get(video.id);
      if (previousSize === undefined || previousSize !== video.size) {
        stillCopyingIds.add(video.id);
      }
    }
    sizeHistory.set(video.id, video.size);
  }
  // Limpia del historial lo que ya no está en disco (se borró/movió/ya se
  // archivó), para no acumular basura indefinidamente.
  for (const id of sizeHistory.keys()) {
    if (!seenNow.has(id)) sizeHistory.delete(id);
  }
  return results.filter((video) => !stillCopyingIds.has(video.id));
}

async function scan() {
  const videosPath = getVideosPath();
  if (!videosPath) {
    throw new Error('No hay carpeta de vídeos configurada. Ajústala en /config.html o en .env');
  }
  if (!fs.existsSync(videosPath)) {
    throw new Error(`La carpeta configurada no existe: ${videosPath}`);
  }

  const results = filterStableFiles(await walk(videosPath));

  // Vídeos cuyo original se borró tras generar su HLS (ver hls.js): siguen
  // en el catálogo a partir del registro, no del escaneo, porque el
  // archivo ya no está en disco.
  const seenIds = new Set(results.map((v) => v.id));
  for (const [id, info] of Object.entries(archivedVideos.getAll())) {
    if (seenIds.has(id)) continue; // no debería pasar, pero por si acaso
    results.push({
      id,
      title: info.title,
      relativePath: info.relativePath,
      size: info.size,
      modifiedAt: info.modifiedAt,
      archived: true,
    });
  }

  results.sort((a, b) => a.title.localeCompare(b.title, 'es'));

  cache = results;
  byId = new Map(results.map((video) => [video.id, video]));
  buildLibrary();
  return cache;
}

function getCatalog() {
  return cache;
}

function getVideoById(id) {
  return byId.get(id);
}

// Lista el contenido del catálogo: sin clave, la raíz (series/anime como
// "carpetas" + películas sueltas); con clave, los vídeos de esa serie.
function listDir(key = '') {
  if (!key) {
    return { dir: '', parent: null, folders: showsList, videos: moviesList };
  }
  return { dir: key, parent: '', folders: [], videos: showVideos.get(key) || [] };
}

// Todas las claves de agrupación del catálogo (series + películas), para
// precalentar la caché de metadatos en segundo plano tras escanear.
function getAllGroupKeys() {
  return [...showsList.map((show) => show.name), ...moviesList.map((movie) => movie.title)];
}

// Clave de la serie a la que pertenece un vídeo, o null si es una película
// suelta (para poder volver a la lista de episodios en vez de al catálogo).
function getShowKeyFor(video) {
  const key = groupKeyFor(video);
  return showVideos.has(key) ? key : null;
}

module.exports = {
  scan,
  getCatalog,
  getVideoById,
  listDir,
  metadataKeyFor: groupKeyFor,
  isGenericFolderName,
  getAllGroupKeys,
  getShowKeyFor,
  // Para normalize.js: calcular el id que tendría una ruta relativa nueva
  // (tras renombrar un archivo) sin tener que reescanear toda la carpeta de
  // vídeos solo para eso - con miles de vídeos en un disco externo, hacerlo
  // una vez por archivo renombrado sería tan lento como el propio escaneo.
  idFor: makeId,
};
