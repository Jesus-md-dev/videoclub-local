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

function backupDir() {
  return BACKUP_DIR;
}

// Copia src -> dest solo si src es más reciente que dest (o dest no existe
// todavía), preservando la fecha de modificación del origen. Es lo que
// convierte esto en una sincronización real "gana el más reciente" en vez
// de un simple volcado: se usa tanto para restaurar (copia -> local) como
// para respaldar (local -> copia), así que no se reescribe sin necesidad un
// archivo que ya está igual a ambos lados (importante para no reescribir de
// más en el disco de vídeos, a veces una red/USB, con miles de carátulas).
function syncFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  const srcStat = fs.statSync(src);
  const destStat = fs.existsSync(dest) ? fs.statSync(dest) : null;
  if (destStat && destStat.mtimeMs >= srcStat.mtimeMs) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
  return true;
}

// Igual que syncFile pero para una carpeta plana (progress/, thumbnails/):
// compara y sincroniza archivo a archivo, nunca de golpe, para no perder ni
// pisar nada que solo exista en un lado todavía.
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
// de data/: recupera de la copia guardada en la carpeta de vídeos lo que
// falte localmente Y lo que esté desactualizado (p.ej. se ha usado el
// videoclub desde otro PC/servidor más recientemente que en este). Nunca
// pisa un dato local que sea igual o más reciente que el de la copia.
function restoreIfNeeded() {
  const dir = backupDir();
  if (!dir || !fs.existsSync(dir)) return;

  let restoredSettings = false;
  for (const { name, type } of ITEMS) {
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

// Guarda en la carpeta de vídeos una copia de los datos locales, para poder
// recuperarlos al usar el videoclub desde otro PC/servidor.
function backupNow() {
  const dir = backupDir();
  if (!dir) return;
  for (const { name, type } of ITEMS) {
    const src = path.join(DATA_PATH, name);
    if (!fs.existsSync(src)) continue;
    try {
      syncItem(src, path.join(dir, name), type);
    } catch (err) {
      console.warn(`No se pudo actualizar la copia de seguridad de "${name}": ${err.message}`);
    }
  }
  snapshotNow();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Copia recursiva simple: los ítems respaldados son JSON sueltos y unas
// pocas carpetas de archivos pequeños (carátulas, subtítulos...), nada que
// necesite streaming ni justifique una dependencia externa.
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Como mucho una instantánea nueva por día (se llama desde backupNow, que
// ya se repite solo cada 10 minutos y tras cada cambio - de sobra para
// pillar el primer momento libre de cada día sin necesidad de su propio
// temporizador). Si ya existe la carpeta de hoy, no se toca - la
// instantánea es del primer estado del día, no del último, precisamente
// para no heredar una corrupción de última hora del mismo día en que pasó.
function snapshotNow() {
  const dir = backupDir();
  if (!dir) return;
  const key = todayKey();
  const target = path.join(SNAPSHOTS_DIR, key);
  if (fs.existsSync(target)) return;

  for (const { name } of ITEMS) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    try {
      copyRecursive(src, path.join(target, name));
    } catch (err) {
      console.warn(`No se pudo incluir "${name}" en la instantánea del ${key}: ${err.message}`);
    }
  }
  console.log(`Instantánea de copia de seguridad guardada: ${target}`);
  pruneOldSnapshots();
}

// Nombres de carpeta "YYYY-MM-DD": el constructor de Date los interpreta
// bien tal cual, no hace falta parsear a mano.
function pruneOldSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return;
  const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(SNAPSHOTS_DIR)) {
    const time = new Date(name).getTime();
    if (!Number.isNaN(time) && time < cutoff) {
      fs.rmSync(path.join(SNAPSHOTS_DIR, name), { recursive: true, force: true });
      console.log(`Instantánea de copia de seguridad eliminada por antigüedad (${SNAPSHOT_RETENTION_DAYS} días): ${name}`);
    }
  }
}

// Para no reescribir en el disco de vídeos (a veces una red/USB) en cada
// pequeño cambio (p.ej. cada segundo de reproducción), se agrupan los
// cambios cercanos en una sola copia.
let pending = null;
function scheduleBackup() {
  clearTimeout(pending);
  pending = setTimeout(backupNow, 5000);
}

module.exports = { restoreIfNeeded, backupNow, scheduleBackup };
