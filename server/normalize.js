const fs = require('fs');
const path = require('path');
const { DATA_PATH, HLS_PATH, getVideosPath } = require('./config');
const catalog = require('./catalog');
const metadata = require('./metadata');
const thumbnails = require('./thumbnails');
const hls = require('./hls');
const archivedVideos = require('./archivedVideos');
const mediaInfo = require('./mediaInfo');
const subdl = require('./subdl');

const PROGRESS_DIR = path.join(DATA_PATH, 'progress');
const TRICKPLAY_DIR = path.join(DATA_PATH, 'trickplay');
const SUBTITLES_DIR = path.join(DATA_PATH, 'subtitles');

// Un vídeo puede tener varios subtítulos extraídos ("<id>-2.vtt",
// "<id>-4.vtt"...), uno por cada pista - a diferencia de la carátula o la
// vista previa (siempre un único archivo), hay que buscarlos todos.
function migrateSubtitles(oldId, newId) {
  if (!fs.existsSync(SUBTITLES_DIR)) return;
  const prefix = `${oldId}-`;
  for (const file of fs.readdirSync(SUBTITLES_DIR)) {
    if (!file.startsWith(prefix)) continue;
    const suffix = file.slice(prefix.length);
    migrateFile(path.join(SUBTITLES_DIR, file), path.join(SUBTITLES_DIR, `${newId}-${suffix}`));
  }
}

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
// no un "1x01" (temporada x episodio, sin letras), si no un "E04" suelto
// (se asume entonces temporada 1, así el resultado siempre lleva
// temporada+episodio - nunca una mezcla de "E04" y "S01E04" dentro de la
// misma serie según lo que traiga cada archivo original). Si no hay
// ninguno de los tres, se deja el archivo tal cual (mejor no tocar nada
// que arriesgarse a desordenar los episodios).
function extractEpisodeMarker(video) {
  const rawTitle = video.title;
  let m = rawTitle.match(/S(\d{1,2})E(\d{1,4})/i);
  if (m) return `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}`;
  // Requiere un separador (espacio/guion/punto/inicio) antes de la
  // temporada, no solo dígitos: si no, algo como "1920x1080" (resolución)
  // se leería como si fuera la temporada 19 (o 20) episodio 1080.
  m = rawTitle.match(/(?:^|[\s\-_.])(\d{1,2})x(\d{1,4})(?:[\s\-_.]|$)/i);
  if (m) return `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}`;
  m = rawTitle.match(/(?:^|[^a-z0-9])E(\d{1,4})(?:[^0-9]|$)/i);
  if (m) return `S01E${m[1].padStart(2, '0')}`;
  // Nombre de archivo formado solo por el número de episodio (ej. "01",
  // sin ninguna letra de por medio): habitual cuando el episodio vive
  // directamente dentro de una carpeta de temporada (ver Initial D,
  // carpetas "T1".."T4"). Sin esa carpeta no hay forma fiable de saber la
  // temporada, así que se deja sin tocar en ese caso.
  m = rawTitle.match(/^0*(\d{1,4})$/);
  if (m) {
    const season = catalog.seasonNumberFor(video);
    if (season != null) return `S${String(season).padStart(2, '0')}E${m[1].padStart(2, '0')}`;
  }
  // Archivo que repite el propio marcador de temporada de su carpeta (ej.
  // "T3.mp4" dentro de "Initial D/T3"): esa temporada es una única
  // entrega (típico de un OVA/película recopilatorio), sin número de
  // episodio propio que extraer. Se asume episodio 1 de esa temporada.
  if (catalog.isGenericFolderName(rawTitle)) {
    const season = catalog.seasonNumberFor(video);
    if (season != null) return `S${String(season).padStart(2, '0')}E01`;
  }
  return null;
}

// Una película suelta usa su propio nombre de archivo como clave de
// metadatos (ver catalog.js groupKeyFor: sin carpeta propia, cae al
// título). Eso significa que, tras renombrarla añadiendo el año, la CLAVE
// cambia también - si se volviera a ejecutar sobre el nombre ya renombrado
// sin quitar antes el "(año)" que ya lleva, se le añadiría otro encima cada
// vez ("Película (2001)" -> "Película (2001) (2001)" -> ...). Se quita
// cualquier "(año)" ya presente al final (puede haber más de uno, por si
// ya se coló alguno) antes de usarlo como base.
function stripTrailingYear(str) {
  let result = str;
  let prev;
  do {
    prev = result;
    result = result.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  } while (result !== prev);
  return result;
}

// Series/películas excluidas del renombrado a propósito (a petición del
// usuario): por su clave de metadatos (nombre de carpeta o de archivo
// suelto), sin distinguir mayúsculas. "One Piece" tiene cientos de
// episodios ya nombrados a su manera - no se toca ni ahora ni en el futuro.
const EXCLUDED_GROUP_KEYS = new Set(['one piece']);

function isExcluded(groupKey) {
  return EXCLUDED_GROUP_KEYS.has(groupKey.trim().toLowerCase());
}

// Nombre limpio propuesto para un vídeo, o null si no hace falta tocarlo
// (ya está bien, está en la lista de exclusión, es un vídeo archivado sin
// archivo real, o no se pudo reconocer con confianza el episodio). No
// depende de que TMDB ya haya respondido: si la clave todavía no tiene
// "cleanName" en caché, usa el nombre de la carpeta/archivo (ya limpiado de
// puntos/guiones bajos y de cualquier año ya puesto) como alternativa
// razonable.
function buildCandidate(video) {
  const groupKey = catalog.metadataKeyFor(video);
  if (isExcluded(groupKey)) return null;
  const isEpisode = Boolean(catalog.getShowKeyFor(video));
  const meta = metadata.getCached(groupKey);
  const coreGroupKey = stripTrailingYear(groupKey);

  // Si el propio nombre ya traía un año (p.ej. el usuario ya lo había puesto
  // a mano) y el año encontrado por metadata.js no coincide, es buena señal
  // de que ha encontrado una entrega distinta de la misma saga (p.ej.
  // "Rompiendo las reglas" (2008) encontrando por error "Rompiendo las
  // reglas 3" (2016)): no se toca el archivo en absoluto - ni con el
  // título/año de TMDB (puede ser el de otra película) ni quitándole el año
  // que ya tenía (podría ser el correcto y dejar de estarlo, además de que
  // sin año ya no habría desajuste que detectar en una pasada posterior).
  const existingYear = metadata.extractYear(groupKey);
  if (existingYear && meta.year && existingYear !== String(meta.year)) return null;

  const baseName = sanitizeName(meta.cleanName || coreGroupKey);
  const ext = path.extname(video.relativePath).toLowerCase();
  const dir = path.dirname(video.relativePath);

  let newBaseName;
  if (isEpisode) {
    const marker = extractEpisodeMarker(video);
    if (!marker) return null;
    newBaseName = `${baseName} - ${marker}`;
  } else {
    newBaseName = meta.year ? `${baseName} (${meta.year})` : baseName;
  }

  const newFileName = `${sanitizeName(newBaseName)}${ext}`;
  const newRelativePath = dir === '.' ? newFileName : path.join(dir, newFileName);

  if (newRelativePath === video.relativePath) return null;
  return { newRelativePath, groupKey };
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

// Windows no distingue mayúsculas/minúsculas al buscar un archivo: si el
// único cambio es de capitalización ("HunterxHunter" -> "HunterXHunter"),
// el nuevo nombre "ya existe" porque en realidad es el propio archivo que se
// está renombrando, no una colisión real con otro archivo.
function isCaseOnlyRename(oldAbsPath, newAbsPath) {
  return oldAbsPath !== newAbsPath && path.resolve(oldAbsPath).toLowerCase() === path.resolve(newAbsPath).toLowerCase();
}

// fs.existsSync no distingue mayúsculas en Windows, así que no sirve para
// comprobar que un renombrado "solo de mayúsculas" surtió efecto de
// verdad: hay que mirar el nombre exacto que hay en el listado de la
// carpeta.
function existsExactCase(absPath) {
  try {
    return fs.readdirSync(path.dirname(absPath)).includes(path.basename(absPath));
  } catch {
    return false;
  }
}

// Igual que al archivar (ver hls.js): el disco externo a veces "acepta" la
// operación sin que el cambio llegue a confirmarse. Se reintenta y se
// comprueba en disco antes de dar el renombrado por bueno.
async function safeRename(oldAbsPath, newAbsPath) {
  const caseOnly = isCaseOnlyRename(oldAbsPath, newAbsPath);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (caseOnly) {
        // Un rename directo entre dos rutas que solo difieren en mayúsculas
        // puede quedarse sin efecto en NTFS (ve el destino "igual" al
        // origen): pasar por un nombre temporal intermedio lo fuerza.
        const tempPath = `${oldAbsPath}.normalize-tmp-${Date.now()}`;
        fs.renameSync(oldAbsPath, tempPath);
        fs.renameSync(tempPath, newAbsPath);
      } else {
        fs.renameSync(oldAbsPath, newAbsPath);
      }
      if (caseOnly) {
        if (existsExactCase(newAbsPath)) return;
      } else if (fs.existsSync(newAbsPath) && !fs.existsSync(oldAbsPath)) {
        return;
      }
      lastErr = new Error('El renombrado no se confirmó en disco');
    } catch (err) {
      lastErr = err;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastErr;
}

// Compartido entre applyRename (archivo real) y applyArchivedRename (solo
// registro, ver más abajo): migra todo lo que cuelga del id viejo al nuevo
// (progreso, carátula, vista previa, HLS ya generado) y, si la clave de
// metadatos también cambia (solo pasa con películas sueltas: ver
// catalog.js groupKeyFor), la caché ya encontrada (género, carátula, nombre
// en español) a la clave nueva - así no queda huérfana ni hay que volver a
// buscarla de cero bajo el nombre ya renombrado.
function migrateVideoData(oldId, newId, oldGroupKey, newRelativePath) {
  if (newId !== oldId) {
    migrateProgress(oldId, newId);
    thumbnails.forget(oldId);
    migrateFile(thumbnails.thumbnailFile(oldId), thumbnails.thumbnailFile(newId));
    migrateFile(path.join(TRICKPLAY_DIR, `${oldId}.json`), path.join(TRICKPLAY_DIR, `${newId}.json`));
    migrateFile(path.join(TRICKPLAY_DIR, `${oldId}.jpg`), path.join(TRICKPLAY_DIR, `${newId}.jpg`));
    migrateDir(path.join(HLS_PATH, oldId), path.join(HLS_PATH, newId));
    migrateSubtitles(oldId, newId);
    subdl.migrateVideo(oldId, newId);
    // El análisis de ffprobe (codec-checks.json) también está indexado por
    // id: para un vídeo archivado (sin original ya en disco) perderlo es
    // definitivo, no se puede volver a analizar - ver mediaInfo.js.
    mediaInfo.migrateEntry(oldId, newId);
  }

  const newGroupKey = catalog.metadataKeyFor({
    relativePath: newRelativePath,
    title: path.basename(newRelativePath, path.extname(newRelativePath)),
  });
  metadata.migrateCacheKey(oldGroupKey, newGroupKey);
}

async function applyRename(video, newRelativePath) {
  const videosPath = getVideosPath();
  const oldAbsPath = path.join(videosPath, video.relativePath);
  const newAbsPath = path.join(videosPath, newRelativePath);
  const oldGroupKey = catalog.metadataKeyFor(video);

  if (!fs.existsSync(oldAbsPath)) throw new Error('No se encuentra el archivo original en disco.');
  if (!isCaseOnlyRename(oldAbsPath, newAbsPath) && fs.existsSync(newAbsPath)) {
    throw new Error(`Ya existe un archivo en "${newRelativePath}"; se omite por seguridad.`);
  }

  const oldId = video.id;
  await safeRename(oldAbsPath, newAbsPath);
  const newId = catalog.idFor(newRelativePath);

  migrateVideoData(oldId, newId, oldGroupKey, newRelativePath);

  return { oldId, newId, from: video.relativePath, to: newRelativePath };
}

// Un vídeo archivado (ver hls.js/archivedVideos.js: su original se borró
// tras generar el HLS, solo H.264 compatibles cuyo HLS es un simple remux)
// no tiene archivo real que mover - solo el registro que sigue mostrándolo
// en el catálogo. Sin esto, quedaría para siempre con el nombre de antes de
// archivarse aunque el resto de la serie ya se hubiera normalizado.
function applyArchivedRename(video, newRelativePath) {
  const oldGroupKey = catalog.metadataKeyFor(video);
  const oldId = video.id;
  const newId = catalog.idFor(newRelativePath);

  archivedVideos.rename(oldId, newId, {
    relativePath: newRelativePath,
    title: path.basename(newRelativePath, path.extname(newRelativePath)),
    size: video.size,
    modifiedAt: video.modifiedAt,
  });

  migrateVideoData(oldId, newId, oldGroupKey, newRelativePath);

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
        if (video.archived) {
          applyArchivedRename(video, newRelativePath);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await applyRename(video, newRelativePath);
        }
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

module.exports = {
  previewCandidates,
  runNormalizeAll,
  getProgress,
  autoNormalizeNewFiles,
  applyRename,
  applyArchivedRename,
};
