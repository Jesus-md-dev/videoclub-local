const fs = require('fs');
const path = require('path');
const { DATA_PATH, HLS_PATH, getVideosPath } = require('./config');
const catalog = require('./catalog');
const metadata = require('./metadata');
const thumbnails = require('./thumbnails');
const hls = require('./hls');

const PROGRESS_DIR = path.join(DATA_PATH, 'progress');
const TRICKPLAY_DIR = path.join(DATA_PATH, 'trickplay');

// Caracteres no válidos en un nombre de archivo de Windows, más espacios o
// puntos sobrantes al final (Windows tampoco los admite ahí).
function sanitizeName(str) {
  return str
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

// Solo se toca el nombre si se reconoce con confianza un marcador de
// temporada/episodio en el nombre original: "S06E12" manda si aparece, si
// no un "E04" suelto. Si no hay ninguno de los dos, se deja el archivo tal
// cual (mejor no tocar nada que arriesgarse a desordenar los episodios).
function extractEpisodeMarker(rawTitle) {
  let m = rawTitle.match(/S(\d{1,2})E(\d{1,4})/i);
  if (m) return `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}`;
  m = rawTitle.match(/(?:^|[^a-z0-9])E(\d{1,4})(?:[^0-9]|$)/i);
  if (m) return `E${m[1].padStart(2, '0')}`;
  return null;
}

// Nombre limpio propuesto para un vídeo, o null si no hace falta tocarlo
// (ya está bien, es un vídeo archivado sin archivo real, o no se pudo
// reconocer con confianza el episodio). No depende de que TMDB ya haya
// respondido: si la clave todavía no tiene "cleanName" en caché, usa el
// nombre de la carpeta/archivo (ya limpiado de puntos/guiones bajos) como
// alternativa razonable.
function buildCandidate(video) {
  if (video.archived) return null;

  const groupKey = catalog.metadataKeyFor(video);
  const isEpisode = Boolean(catalog.getShowKeyFor(video));
  const meta = metadata.getCached(groupKey);
  const baseName = sanitizeName(meta.cleanName || groupKey);
  const ext = path.extname(video.relativePath).toLowerCase();
  const dir = path.dirname(video.relativePath);

  let newBaseName;
  if (isEpisode) {
    const marker = extractEpisodeMarker(video.title);
    if (!marker) return null;
    newBaseName = `${baseName} - ${marker}`;
  } else {
    newBaseName = meta.year ? `${baseName} (${meta.year})` : baseName;
  }

  const newFileName = `${sanitizeName(newBaseName)}${ext}`;
  const newRelativePath = dir === '.' ? newFileName : path.join(dir, newFileName);

  if (newRelativePath === video.relativePath) return null;
  return { newRelativePath };
}

// Mismo patrón que dedupe.js: el id sale de un hash de la ruta relativa, así
// que renombrar cambia el id. Se migra el progreso/carátula/vista
// previa/HLS ya generado al id nuevo para no perderlos ni tener que
// regenerar nada.
function migrateProgress(oldId, newId) {
  if (!fs.existsSync(PROGRESS_DIR)) return;
  for (const file of fs.readdirSync(PROGRESS_DIR)) {
    const full = path.join(PROGRESS_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }
    if (data[oldId]) {
      data[newId] = { ...data[oldId], ...(data[newId] || {}) };
      delete data[oldId];
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
    }
  }
}

function migrateFile(oldPath, newPath) {
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) fs.renameSync(oldPath, newPath);
}

function migrateDir(oldDir, newDir) {
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
}

// Igual que al archivar (ver hls.js): el disco externo a veces "acepta" la
// operación sin que el cambio llegue a confirmarse. Se reintenta y se
// comprueba en disco antes de dar el renombrado por bueno.
async function safeRename(oldAbsPath, newAbsPath) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fs.renameSync(oldAbsPath, newAbsPath);
      if (fs.existsSync(newAbsPath) && !fs.existsSync(oldAbsPath)) return;
      lastErr = new Error('El renombrado no se confirmó en disco');
    } catch (err) {
      lastErr = err;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastErr;
}

async function applyRename(video, newRelativePath) {
  const videosPath = getVideosPath();
  const oldAbsPath = path.join(videosPath, video.relativePath);
  const newAbsPath = path.join(videosPath, newRelativePath);

  if (!fs.existsSync(oldAbsPath)) throw new Error('No se encuentra el archivo original en disco.');
  if (fs.existsSync(newAbsPath)) {
    throw new Error(`Ya existe un archivo en "${newRelativePath}"; se omite por seguridad.`);
  }

  const oldId = video.id;
  await safeRename(oldAbsPath, newAbsPath);
  const newId = catalog.idFor(newRelativePath);

  if (newId !== oldId) {
    migrateProgress(oldId, newId);
    thumbnails.forget(oldId);
    migrateFile(thumbnails.thumbnailFile(oldId), thumbnails.thumbnailFile(newId));
    migrateFile(path.join(TRICKPLAY_DIR, `${oldId}.json`), path.join(TRICKPLAY_DIR, `${newId}.json`));
    migrateFile(path.join(TRICKPLAY_DIR, `${oldId}.jpg`), path.join(TRICKPLAY_DIR, `${newId}.jpg`));
    migrateDir(path.join(HLS_PATH, oldId), path.join(HLS_PATH, newId));
  }

  return { oldId, newId, from: video.relativePath, to: newRelativePath };
}

async function previewCandidates() {
  const candidates = [];
  for (const video of catalog.getCatalog()) {
    const candidate = buildCandidate(video);
    if (candidate) candidates.push({ video, ...candidate });
  }
  return candidates;
}

const progress = { running: false, total: 0, done: 0, renamed: 0, errors: [], startedAt: null };

function getProgress() {
  return progress;
}

// Pasada completa y manual (botón "Normalizar nombres" en /config): recorre
// TODA la biblioteca ya escaneada y renombra lo que reconozca con
// confianza. Al terminar, un único reescaneo (no uno por archivo, sería
// tan lento como escanear toda la carpeta una vez por cada renombrado).
async function runNormalizeAll() {
  if (progress.running) return progress;
  const candidates = await previewCandidates();

  progress.running = true;
  progress.total = candidates.length;
  progress.done = 0;
  progress.renamed = 0;
  progress.errors = [];
  progress.startedAt = Date.now();

  (async () => {
    for (const { video, newRelativePath } of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await applyRename(video, newRelativePath);
        progress.renamed += 1;
      } catch (err) {
        progress.errors.push({ title: video.title, message: err.message });
      }
      progress.done += 1;
    }
    try {
      const videos = await catalog.scan();
      thumbnails.generateMissingThumbnails(videos);
      metadata.warmAll(catalog.getAllGroupKeys());
      hls.warmAll(videos);
    } catch (err) {
      progress.errors.push({ title: '(reescaneo final)', message: err.message });
    }
    progress.running = false;
  })().catch((err) => {
    progress.running = false;
    progress.errors.push({ title: '(error general)', message: err.message });
  });

  return progress;
}

// Normalización silenciosa de archivos recién llegados (ver watcher.js): a
// diferencia del botón manual, esto solo toca vídeos que no estaban ya en
// el catálogo antes de este reescaneo, así que no hay progreso/carátula/HLS
// previos que migrar en la práctica - es justo el momento más barato y
// seguro para renombrar, antes de generar nada para ellos. Devuelve true si
// renombró algo (para que el llamador vuelva a escanear antes de seguir).
async function autoNormalizeNewFiles(videos, previousIds) {
  let renamedAny = false;
  for (const video of videos) {
    if (previousIds.has(video.id) || video.archived) continue;
    const candidate = buildCandidate(video);
    if (!candidate) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await applyRename(video, candidate.newRelativePath);
      renamedAny = true;
      console.log(`Nombre normalizado automáticamente: "${video.relativePath}" -> "${candidate.newRelativePath}"`);
    } catch (err) {
      console.warn(`No se pudo normalizar "${video.relativePath}": ${err.message}`);
    }
  }
  return renamedAny;
}

module.exports = { previewCandidates, runNormalizeAll, getProgress, autoNormalizeNewFiles };
