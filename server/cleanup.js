const fs = require('fs');
const path = require('path');
const { DATA_PATH, HLS_PATH, getVideosPath } = require('./config');
const catalog = require('./catalog');
const archivedVideos = require('./archivedVideos');
const backup = require('./backup');

// Limpieza periódica de data/ y del espejo data-backup/ (issue #138).
//
// Carátulas, trickplay y subtítulos se guardan con el id del vídeo delante
// del nombre ("<id>.jpg", "<id>-3.vtt"...). Cuando un vídeo se renombra o
// desaparece, su id deja de existir pero esos archivos se quedaban para
// siempre, aquí y en el espejo (que nunca borra). Esto los quita, con
// mucho cuidado: el trickplay y los subtítulos de un vídeo archivado (sin
// original) son la única copia que queda, así que se conserva todo id que
// esté en el catálogo, en hls-archived.json o en lost-videos.json, o que
// tenga carpeta en HLS_PATH (un registro incompleto ya dejó vídeos cuya
// única copia era su HLS sin que constara en ningún sitio, ver #108).
//
// Nada se borra directamente: va a una papelera (.papelera/<fecha>/ en el
// mismo disco, así que mover es instantáneo) que se vacía a los
// TRASH_DAYS días.

const fsp = fs.promises;
const ID_RE = /^([0-9a-f]{16})/;
const DIRS = ['thumbnails', 'trickplay', 'subtitles'];
// Un archivo recién creado puede ser de un vídeo que el catálogo aún no ha
// visto (p.ej. a mitad de un renombrado): solo se tocan los de más de 3 días.
const MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const TRASH_DAYS = 7;
const TRASH_DIR = '.papelera';
// Si el catálogo tiene de golpe menos del 90% de los vídeos de la última
// vez, lo más probable es un disco desconectado o un escaneo a medias, no
// que se hayan borrado cientos de vídeos: mejor no limpiar nada. Si la
// siguiente vez (al día siguiente) se ve el mismo tamaño, sí era real y se
// acepta como el nuevo normal.
const MIN_CATALOG_RATIO = 0.9;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = path.join(DATA_PATH, 'cleanup-state.json');

let running = null;
let usageCache = null;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`Limpieza: no se pudo guardar su estado: ${err.message}`);
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Ids que hay que conservar, o un motivo para no limpiar nada esta vez.
function idsToKeep(state) {
  const videosPath = getVideosPath();
  if (!videosPath || !fs.existsSync(videosPath)) {
    return { reason: `la carpeta de vídeos (${videosPath || 'sin configurar'}) no está accesible` };
  }
  const videos = catalog.getCatalog();
  if (!videos.length) return { reason: 'el catálogo está vacío' };
  const shrunk = state.catalogCount && videos.length < state.catalogCount * MIN_CATALOG_RATIO;
  const confirmedShrink = state.shrinkSeen && Math.abs(videos.length - state.shrinkSeen) <= state.shrinkSeen * 0.02;
  if (shrunk && !confirmedShrink) {
    return {
      reason: `el catálogo tiene ${videos.length} vídeos y la última vez tenía ${state.catalogCount} (¿disco desconectado?)`,
      shrinkSeen: videos.length,
    };
  }
  let lost;
  try {
    lost = JSON.parse(fs.readFileSync(path.join(DATA_PATH, 'lost-videos.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') return { reason: `no se pudo leer lost-videos.json: ${err.message}` };
    lost = {};
  }
  let hlsIds;
  try {
    hlsIds = fs.readdirSync(HLS_PATH);
  } catch (err) {
    return { reason: `la carpeta de HLS (${HLS_PATH}) no está accesible: ${err.message}` };
  }
  const keep = new Set(videos.map((v) => v.id));
  for (const id of Object.keys(archivedVideos.getAll())) keep.add(id);
  for (const id of Object.keys(lost)) keep.add(id);
  for (const id of hlsIds) keep.add(id);
  return { keep, catalogCount: videos.length };
}

async function moveToTrash(base, dir, file) {
  const src = path.join(base, dir, file);
  const destDir = path.join(base, TRASH_DIR, todayKey(), dir);
  await fsp.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, file);
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
  // Ver #122: en Windows un borrado puede "funcionar" sin hacer nada.
  if (fs.existsSync(src)) throw new Error(`sigue en su sitio: ${src}`);
}

async function moveOrphans(base, keep, result) {
  const cutoff = Date.now() - MIN_AGE_MS;
  for (const dir of DIRS) {
    let names;
    try {
      names = await fsp.readdir(path.join(base, dir));
    } catch {
      continue;
    }
    for (const file of names) {
      const match = ID_RE.exec(file);
      // Lo que no empieza por un id no sabemos de quién es: no se toca.
      if (!match || keep.has(match[1])) continue;
      try {
        const st = await fsp.stat(path.join(base, dir, file));
        if (!st.isFile() || st.mtimeMs > cutoff) continue;
        await moveToTrash(base, dir, file);
        result.files += 1;
        result.bytes += st.size;
      } catch (err) {
        result.errors += 1;
        console.warn(`Limpieza: no se pudo mover a la papelera ${path.join(base, dir, file)}: ${err.message}`);
      }
    }
  }
}

async function emptyOldTrash(base, result) {
  const trash = path.join(base, TRASH_DIR);
  let days;
  try {
    days = await fsp.readdir(trash);
  } catch {
    return;
  }
  const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
  for (const day of days) {
    const time = new Date(day).getTime();
    if (Number.isNaN(time) || time >= cutoff) continue;
    const target = path.join(trash, day);
    try {
      await fsp.rm(target, { recursive: true, force: true });
      if (fs.existsSync(target)) throw new Error('sigue existiendo');
      result.trashEmptied.push(day);
    } catch (err) {
      console.warn(`Limpieza: no se pudo vaciar la papelera ${target}: ${err.message}`);
    }
  }
}

async function doCleanup(trigger) {
  const state = readState();
  const startedAt = new Date().toISOString();
  const result = {
    trigger,
    startedAt,
    files: 0,
    bytes: 0,
    errors: 0,
    trashEmptied: [],
    snapshotsRemoved: [],
    snapshotsSlimmed: 0,
  };

  const { keep, catalogCount, reason, shrinkSeen } = idsToKeep(state);
  if (reason) {
    result.skippedOrphans = reason;
    console.warn(`Limpieza: no se quitan archivos sobrantes porque ${reason}`);
  }

  // Dentro de backup.exclusive: si una copia al espejo corriera a la vez,
  // podría volver a copiar al espejo lo que se acaba de mover a la papelera.
  await backup.exclusive(async () => {
    if (keep) {
      for (const base of [DATA_PATH, backup.BACKUP_DIR]) await moveOrphans(base, keep, result);
    }
    for (const base of [DATA_PATH, backup.BACKUP_DIR]) await emptyOldTrash(base, result);
    const snapshots = await backup.pruneOldSnapshots();
    result.snapshotsRemoved = snapshots.removed;
    result.snapshotsSlimmed = snapshots.slimmed;
  });

  result.finishedAt = new Date().toISOString();
  writeState({
    lastRunAt: result.finishedAt,
    catalogCount: catalogCount || state.catalogCount,
    shrinkSeen,
    lastResult: result,
  });
  usageCache = null;
  console.log(
    `Limpieza (${trigger}): ${result.files} archivo(s) sobrantes a la papelera (${Math.round(result.bytes / 1e6)} MB), ` +
      `${result.snapshotsRemoved.length} instantánea(s) borradas, ${result.snapshotsSlimmed} aligeradas, ` +
      `${result.trashEmptied.length} día(s) de papelera vaciados`
  );
  return result;
}

function runCleanup(trigger = 'manual') {
  if (!running) {
    running = doCleanup(trigger).finally(() => {
      running = null;
    });
  }
  return running;
}

// Se llama cada hora: solo limpia si han pasado RUN_EVERY_MS desde la
// última vez. Así funciona aunque el PC se apague cada noche (un
// setInterval de 24 h no llegaría a dispararse nunca).
function runIfDue() {
  const { lastRunAt } = readState();
  if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < RUN_EVERY_MS) return;
  runCleanup('automática').catch((err) => console.warn(`Limpieza automática: ${err.message}`));
}

async function folderSize(dir, skip = new Set()) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await folderSize(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += (await fsp.stat(full)).size;
        files += 1;
      } catch {
        // Borrado mientras se medía: no cuenta.
      }
    }
  }
  return { bytes, files };
}

// Cuánto ocupa cada cosa, para Configuración. Recorre decenas de miles de
// archivos, así que se guarda 10 minutos (y se rehace tras limpiar).
async function getStorageUsage() {
  if (usageCache && Date.now() - usageCache.at < 10 * 60 * 1000) return usageCache.value;
  const skip = new Set(['snapshots', TRASH_DIR, '.backup-manifest.json']);
  const [data, mirror, snapshots, trashData, trashMirror] = await Promise.all([
    folderSize(DATA_PATH, new Set([TRASH_DIR])),
    folderSize(backup.BACKUP_DIR, skip),
    folderSize(backup.SNAPSHOTS_DIR),
    folderSize(path.join(DATA_PATH, TRASH_DIR)),
    folderSize(path.join(backup.BACKUP_DIR, TRASH_DIR)),
  ]);
  const value = {
    items: [
      { key: 'data', label: 'Datos', path: DATA_PATH, ...data },
      { key: 'mirror', label: 'Copia de seguridad (espejo)', path: backup.BACKUP_DIR, ...mirror },
      { key: 'snapshots', label: 'Instantáneas diarias', path: backup.SNAPSHOTS_DIR, ...snapshots },
      {
        key: 'trash',
        label: `Papelera (se vacía a los ${TRASH_DAYS} días)`,
        bytes: trashData.bytes + trashMirror.bytes,
        files: trashData.files + trashMirror.files,
      },
    ],
    measuredAt: new Date().toISOString(),
  };
  usageCache = { at: Date.now(), value };
  return value;
}

function getState() {
  const { lastRunAt, lastResult } = readState();
  return { lastRunAt: lastRunAt || null, lastResult: lastResult || null, running: Boolean(running) };
}

module.exports = { runCleanup, runIfDue, getStorageUsage, getState };
