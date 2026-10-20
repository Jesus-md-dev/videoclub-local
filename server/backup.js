const fs = require('fs');
const path = require('path');
const { DATA_PATH, reloadVideosPath, reloadTmdbApiKey, reloadSubdlApiKey } = require('./config');

// DATA_PATH ahora vive en el disco externo (ver .env: DATA_PATH=D:\...),
// para que viaje solo con la biblioteca al cambiar de PC/servidor. Pero ese
// mismo disco externo ha dado problemas de fiabilidad antes (desconexiones,
// corrupción) - así que esta copia de seguridad ya no es "de C: hacia el
// disco externo" como al principio, sino al revés: un espejo LOCAL, dentro
// del propio proyecto (por tanto en el disco del PC, uno físico distinto),
// para poder recuperar los datos si el disco externo falla. Sigue siendo
// "gana el más reciente" en los dos sentidos, así que también sirve para
// llevarse los datos a mano a otro PC si hiciera falta.
const BACKUP_DIR = path.join(__dirname, '..', 'data-backup');

// El espejo de arriba (BACKUP_DIR) es "gana el más reciente" en vivo: si el
// dato local se corrompe o se sobrescribe con algo peor (p.ej. una
// escritura a medias por disco lleno), el espejo copia también ese estado
// malo en cuestión de segundos - no da ningún "antes" al que volver. Así se
// perdió de verdad el progreso de "continuar viendo" de un perfil el
// 2026-09-20 (ver profiles.js). Estas instantáneas fechadas son la
// diferencia: una copia congelada por día, que un futuro fallo similar no
// puede tocar retroactivamente.
const SNAPSHOTS_DIR = path.join(BACKUP_DIR, 'snapshots');
const SNAPSHOT_RETENTION_DAYS = 30;

// Ahí se guarda una copia de todo lo que sería caro o lento de rehacer
// desde cero: perfiles, progreso de "Continuar viendo"/visto, carpeta
// configurada, carátulas generadas, caché de géneros/análisis de códecs y
// analítica. Los vídeos convertidos y el certificado HTTPS se quedan
// fuera: son caché regenerable bajo demanda (o, en el caso de los
// convertidos, demasiado grandes para duplicarlos).
//
// subtitles/, trickplay/ y hls-archived.json sí se respaldan (a
// diferencia de antes): cuando el HLS de un vídeo sustituye a su
// original (ver hls.js), esos dejan de ser caché regenerable para ese
// vídeo en concreto - sin el original ya no hay forma de volver a
// extraerlos, así que perderlos sería perderlos para siempre.
const ITEMS = [
  { name: 'settings.json', type: 'file' },
  { name: 'profiles.json', type: 'file' },
  { name: 'progress', type: 'dir' },
  { name: 'metadata.json', type: 'file' },
  // Correcciones manuales de carátula/nombre (PosterPicker, overrideFromTmdb):
  // sin esto, sobrevivían a un reinicio normal pero se perdían al cambiar de
  // PC/servidor, aunque metadata.json (con el resultado ya aplicado) sí
  // viajara - solo se notaría la próxima vez que una actualización masiva
  // volviera a pisar esa clave sin encontrar el override guardado.
  { name: 'metadata-overrides.json', type: 'file' },
  // Nombres puestos a mano desde la web (metadata.js setCustomName).
  { name: 'custom-names.json', type: 'file' },
  { name: 'anime-marks.json', type: 'file' },
  // Igual de razonamiento: qué vídeos se dan por perdidos (lostVideos.js) y
  // qué carpetas se han marcado como "no es una serie, son títulos sueltos"
  // (catalogOverrides.js) son decisiones tomadas a mano que no se deben
  // perder al cambiar de PC.
  { name: 'lost-videos.json', type: 'file' },
  { name: 'catalog-ungrouped.json', type: 'file' },
  { name: 'codec-checks.json', type: 'file' },
  { name: 'analytics.log', type: 'file' },
  { name: 'thumbnails', type: 'dir' },
  { name: 'subtitles', type: 'dir' },
  { name: 'trickplay', type: 'dir' },
  { name: 'hls-archived.json', type: 'file' },
  // Qué subtítulo de SubDL se descargó para cada vídeo (idioma, nombre de
  // el "release"...) - sin este registro, los .vtt ya descargados en
  // subtitles/ (que sí se respaldan) seguirían en disco tras restaurar,
  // pero subdl.listDownloaded() no sabría de ellos (no hace falta leer el
  // disco para saber si existen: lee este registro primero).
  { name: 'subtitle-downloads.json', type: 'file' },
];

// Carpetas con miles de archivos (issue #137): recorrerlas entera de forma
// síncrona al arrancar tenía el servidor sin responder varios segundos (y
// más cuanto más crece la biblioteca). Se restauran en segundo plano
// (restoreHeavyDirs) y no entran en las instantáneas diarias (#138): son
// lo que hacía que cada instantánea ocupara ~2 GB. Siguen en el espejo.
const HEAVY_DIRS = new Set(['thumbnails', 'trickplay', 'subtitles']);
const SNAPSHOT_ITEMS = ITEMS.filter(({ name }) => !HEAVY_DIRS.has(name));

// Instantáneas que se conservan: las SNAPSHOT_DAILY más recientes y, de
// las anteriores, la más reciente de cada semana hasta SNAPSHOT_WEEKLY
// semanas.
const SNAPSHOT_DAILY = 7;
const SNAPSHOT_WEEKLY = 4;

// Índice de lo ya copiado al espejo (ruta relativa -> mtime del origen al
// copiarlo): así respaldar una carpeta solo mira el origen, no también el
// destino archivo a archivo.
const MANIFEST_FILE = path.join(BACKUP_DIR, '.backup-manifest.json');

const fsp = fs.promises;

// Al copiar la fecha de modificación (utimes) se pierde lo que haya por
// debajo del milisegundo y a veces se redondea hacia arriba: la copia
// quedaba una fracción de ms "más nueva" que el original, y en el
// siguiente arranque se "recuperaba" del espejo un archivo idéntico (o al
// revés, se recopiaba en cada pasada). Una modificación real va segundos
// o minutos por delante, así que por debajo de este margen se consideran
// la misma versión.
const MTIME_SLACK_MS = 2;
function isNewer(srcMs, destMs) {
  return srcMs - destMs > MTIME_SLACK_MS;
}

function backupDir() {
  return BACKUP_DIR;
}

// Copia src -> dest solo si src es más reciente que dest (o dest no existe
// todavía), preservando la fecha de modificación del origen. Es lo que
// convierte esto en una sincronización real "gana el más reciente" en vez
// de un simple volcado: se usa tanto para restaurar (copia -> local) como
// para respaldar (local -> copia).
function syncFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  const srcStat = fs.statSync(src);
  const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
  if (destStat && !isNewer(srcStat.mtimeMs, destStat.mtimeMs)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
  return true;
}

// Igual que syncFile pero para una carpeta plana pequeña (progress/).
function syncDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  let changed = false;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    if (fs.statSync(s).isDirectory()) continue;
    if (syncFile(s, path.join(dest, name))) changed = true;
  }
  return changed;
}

function syncItem(src, dest, type) {
  return type === 'dir' ? syncDir(src, dest) : syncFile(src, dest);
}

// Se llama al arrancar, antes de que el resto del servidor lea sus ficheros
// de data/: recupera del espejo lo que falte localmente Y lo que esté
// desactualizado. Nunca pisa un dato local que sea igual o más reciente que
// el de la copia. Las carpetas grandes van aparte, en restoreHeavyDirs().
function restoreIfNeeded() {
  const dir = backupDir();
  if (!dir || !fs.existsSync(dir)) return;

  let restoredSettings = false;
  for (const { name, type } of ITEMS) {
    if (HEAVY_DIRS.has(name)) continue;
    const src = path.join(dir, name);
    const dest = path.join(DATA_PATH, name);
    try {
      const changed = syncItem(src, dest, type);
      if (changed) {
        console.log(`Recuperado "${name}" desde la copia de seguridad en ${dir} (más reciente que la copia local)`);
        if (name === 'settings.json') restoredSettings = true;
      }
    } catch (err) {
      console.warn(`No se pudo recuperar "${name}" de la copia de seguridad: ${err.message}`);
    }
  }
  if (restoredSettings) {
    reloadVideosPath();
    reloadTmdbApiKey();
    reloadSubdlApiKey();
  }
}

async function listNames(dir) {
  try {
    return new Set(await fsp.readdir(dir));
  } catch {
    return new Set();
  }
}

async function copyPreservingMtime(src, dest, srcStat) {
  await fsp.copyFile(src, dest);
  await fsp.utimes(dest, srcStat.atime, srcStat.mtime);
}

// Restaura en segundo plano carátulas, trickplay y subtítulos que falten en
// local pero sigan en el espejo (p.ej. tras perder o cambiar el disco de
// datos). Solo los que faltan: estos archivos no se editan en el sitio, así
// que no hace falta comparar fechas de los miles que ya están.
async function restoreHeavyDirs() {
  const dir = backupDir();
  if (!dir || !fs.existsSync(dir)) return;
  for (const name of HEAVY_DIRS) {
    const src = path.join(dir, name);
    const dest = path.join(DATA_PATH, name);
    const local = await listNames(dest);
    let restored = 0;
    for (const file of await listNames(src)) {
      if (local.has(file)) continue;
      try {
        const st = await fsp.stat(path.join(src, file));
        if (!st.isFile()) continue;
        await fsp.mkdir(dest, { recursive: true });
        await copyPreservingMtime(path.join(src, file), path.join(dest, file), st);
        restored += 1;
      } catch (err) {
        console.warn(`No se pudo recuperar "${name}/${file}" de la copia de seguridad: ${err.message}`);
      }
    }
    if (restored) console.log(`Recuperados ${restored} archivo(s) de "${name}" desde la copia de seguridad`);
  }
}

// Una sola operación sobre el espejo a la vez (copia, instantánea o la
// limpieza de cleanup.js): si la limpieza moviera archivos a la papelera a
// mitad de una copia, esta podría volver a dejarlos en el espejo.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function backupFileItem(name) {
  const src = path.join(DATA_PATH, name);
  const dest = path.join(BACKUP_DIR, name);
  let srcStat;
  try {
    srcStat = await fsp.stat(src);
  } catch {
    return;
  }
  const destStat = await fsp.stat(dest).catch(() => null);
  if (destStat && !isNewer(srcStat.mtimeMs, destStat.mtimeMs)) return;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await copyPreservingMtime(src, dest, srcStat);
}

async function backupDirItem(name, manifest) {
  const src = path.join(DATA_PATH, name);
  const dest = path.join(BACKUP_DIR, name);
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch {
    return;
  }
  await fsp.mkdir(dest, { recursive: true });
  const inDest = await listNames(dest);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const key = `${name}/${entry.name}`;
    try {
      const srcStat = await fsp.stat(path.join(src, entry.name));
      if (inDest.has(entry.name)) {
        if (manifest[key] === srcStat.mtimeMs) continue;
        // Primera pasada con el índice (o archivo que no está en él): se
        // compara con el destino como se hacía antes.
        if (manifest[key] === undefined) {
          const destStat = await fsp.stat(path.join(dest, entry.name));
          if (!isNewer(srcStat.mtimeMs, destStat.mtimeMs)) {
            manifest[key] = srcStat.mtimeMs;
            continue;
          }
        }
      }
      await copyPreservingMtime(path.join(src, entry.name), path.join(dest, entry.name), srcStat);
      manifest[key] = srcStat.mtimeMs;
    } catch (err) {
      console.warn(`No se pudo copiar "${key}" a la copia de seguridad: ${err.message}`);
    }
  }
}

// Guarda en el espejo una copia de los datos. Asíncrono a propósito: antes
// era síncrono y bloqueaba el servidor entero unos segundos cada vez que se
// guardaba progreso (scheduleBackup) y, al arrancar, antes de abrir el puerto.
let backupQueued = null;
function backupNow() {
  // Si ya hay una copia esperando turno, esa misma recogerá estos cambios.
  if (backupQueued) return backupQueued;
  backupQueued = exclusive(async () => {
    backupQueued = null;
    const dir = backupDir();
    if (!dir) return;
    try {
      await backupEverything();
    } catch (err) {
      // Nunca rechaza: quien la llama no suele esperar la promesa.
      console.warn(`Copia de seguridad: ${err.message}`);
    }
  });
  return backupQueued;
}

async function backupEverything() {
  const manifest = readManifest();
  for (const { name, type } of ITEMS) {
    try {
      if (type === 'dir') await backupDirItem(name, manifest);
      else await backupFileItem(name);
    } catch (err) {
      console.warn(`No se pudo actualizar la copia de seguridad de "${name}": ${err.message}`);
    }
  }
  try {
    await fsp.writeFile(MANIFEST_FILE, JSON.stringify(manifest));
  } catch (err) {
    console.warn(`No se pudo guardar el índice de la copia de seguridad: ${err.message}`);
  }
  await snapshotNow();
}

// Al cerrar el servidor no da tiempo a la copia asíncrona (process.exit va
// justo detrás): se copia en síncrono solo lo pequeño e importante
// (progreso, perfiles, ajustes...), que es lo que se perdería.
function backupEssentialsSync() {
  for (const { name, type } of SNAPSHOT_ITEMS) {
    try {
      syncItem(path.join(DATA_PATH, name), path.join(BACKUP_DIR, name), type);
    } catch (err) {
      console.warn(`No se pudo actualizar la copia de seguridad de "${name}": ${err.message}`);
    }
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function copyRecursive(src, dest) {
  const stat = await fsp.stat(src);
  if (stat.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const name of await fsp.readdir(src)) {
      await copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

// Como mucho una instantánea nueva por día. Si ya existe la carpeta de hoy,
// no se toca - la instantánea es del primer estado del día, no del último,
// precisamente para no heredar una corrupción de última hora del mismo día
// en que pasó. Solo lleva SNAPSHOT_ITEMS (unos MB, no los ~2 GB de antes).
async function snapshotNow() {
  const dir = backupDir();
  if (!dir) return;
  const key = todayKey();
  const target = path.join(SNAPSHOTS_DIR, key);
  if (fs.existsSync(target)) return;

  for (const { name } of SNAPSHOT_ITEMS) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    try {
      await copyRecursive(src, path.join(target, name));
    } catch (err) {
      console.warn(`No se pudo incluir "${name}" en la instantánea del ${key}: ${err.message}`);
    }
  }
  console.log(`Instantánea de copia de seguridad guardada: ${target}`);
  await pruneOldSnapshots();
}

// Lunes de la semana de una fecha "YYYY-MM-DD", como clave de semana.
function weekKey(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Qué instantáneas se quedan: las SNAPSHOT_DAILY más recientes y, de las
// anteriores, la más reciente de cada semana hasta SNAPSHOT_WEEKLY semanas.
function snapshotsToKeep(days) {
  const sorted = [...days].sort().reverse();
  const keep = new Set(sorted.slice(0, SNAPSHOT_DAILY));
  const weeks = new Set();
  for (const day of sorted.slice(SNAPSHOT_DAILY)) {
    const week = weekKey(day);
    if (weeks.has(week) || weeks.size >= SNAPSHOT_WEEKLY) continue;
    weeks.add(week);
    keep.add(day);
  }
  return keep;
}

async function removeDir(target) {
  await fsp.rm(target, { recursive: true, force: true });
  // fs.rm puede no hacer nada en silencio en Windows (ver #122): se comprueba.
  if (fs.existsSync(target)) throw new Error(`no se pudo borrar ${target}`);
}

// Borra las instantáneas que ya no toca guardar y quita de las que quedan
// las carpetas grandes que tenían las de antes de #138 (siguen en el
// espejo). Devuelve qué ha hecho, para el resumen de la limpieza.
async function pruneOldSnapshots() {
  const result = { removed: [], slimmed: 0 };
  if (!fs.existsSync(SNAPSHOTS_DIR)) return result;
  const days = (await fsp.readdir(SNAPSHOTS_DIR)).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));
  const keep = snapshotsToKeep(days);
  for (const day of days) {
    const target = path.join(SNAPSHOTS_DIR, day);
    try {
      if (!keep.has(day)) {
        await removeDir(target);
        result.removed.push(day);
        console.log(`Instantánea de copia de seguridad eliminada (se guardan ${SNAPSHOT_DAILY} diarias y ${SNAPSHOT_WEEKLY} semanales): ${day}`);
        continue;
      }
      let slimmed = false;
      for (const heavy of HEAVY_DIRS) {
        const heavyPath = path.join(target, heavy);
        if (!fs.existsSync(heavyPath)) continue;
        await removeDir(heavyPath);
        slimmed = true;
      }
      if (slimmed) result.slimmed += 1;
    } catch (err) {
      console.warn(`Limpieza de la instantánea ${day}: ${err.message}`);
    }
  }
  return result;
}

// Para no reescribir en cada pequeño cambio (p.ej. cada pocos segundos de
// reproducción), se agrupan los cambios cercanos en una sola copia.
let pending = null;
function scheduleBackup() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    backupNow().catch((err) => console.warn(`Copia de seguridad: ${err.message}`));
  }, 5000);
}

module.exports = {
  BACKUP_DIR,
  SNAPSHOTS_DIR,
  HEAVY_DIRS,
  restoreIfNeeded,
  restoreHeavyDirs,
  backupNow,
  backupEssentialsSync,
  scheduleBackup,
  exclusive,
  pruneOldSnapshots,
};
