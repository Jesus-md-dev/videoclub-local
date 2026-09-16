const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const ffmpeg = require('fluent-ffmpeg');
const { getVideosPath, DATA_PATH } = require('./config');
const archivedVideos = require('./archivedVideos');

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

const memo = new Map(); // video.id -> ffprobe data (memoria, solo para esta ejecución)

// ffprobe es la parte lenta de arrancar con una biblioteca grande: sin
// guardar su resultado, cada reinicio del servidor tenía que volver a
// analizar TODOS los vídeos, aunque no hubiera cambiado nada desde la vez
// anterior. Se guarda en un fichero propio junto al resto de datos
// persistentes del videoclub (perfiles, progreso...), no como una caché
// desechable: viaja con el resto de data/ y se respalda igual en
// `.videoclub-datos/` (ver backup.js), así que sobrevive tanto a un
// reinicio como a mover el servidor a otro PC. Cada entrada lleva el
// tamaño+fecha de modificación que tenía el archivo al analizarlo, para
// solo repetir el análisis si el archivo ha cambiado de verdad.
const CODEC_CHECKS_FILE = path.join(DATA_PATH, 'codec-checks.json');
let store = loadStore();
let saveTimer = null;

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(CODEC_CHECKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeStore() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(CODEC_CHECKS_FILE, JSON.stringify(store));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeStore, 2000);
}

function fingerprint(video) {
  const mtime = video.modifiedAt ? new Date(video.modifiedAt).getTime() : 0;
  return `${video.size}:${mtime}`;
}

function inputPathFor(video) {
  return path.join(getVideosPath(), video.relativePath);
}

// Sin límite de tiempo, un archivo que se está copiando todavía (o
// realmente dañado) puede dejar a ffprobe esperando para siempre - y como
// el precalentamiento en segundo plano solo tiene un "trabajador" a la vez
// (WARM_CONCURRENCY=1 en hls.js, por la lección del disco externo saturado
// del #67), ese único cuelgue bloqueaba TODO lo que viniera detrás sin
// ningún aviso, incluidos vídeos añadidos después - solo se liberaba
// reiniciando el servidor entero a mano. Con el timeout, se marca como
// fallo puntual (reintentable desde /queue) y el resto sigue su curso solo.
const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

function probeRaw(inputPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('ffprobe no respondió a tiempo (el archivo podría seguir copiándose, o estar dañado).'));
    }, PROBE_TIMEOUT_MS);
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function getMediaInfo(video) {
  if (memo.has(video.id)) return memo.get(video.id);

  const fp = fingerprint(video);
  const saved = store[video.id];
  if (saved && saved.fp === fp) {
    memo.set(video.id, saved.info);
    return saved.info;
  }

  const info = await probeRaw(inputPathFor(video));
  memo.set(video.id, info);
  store[video.id] = { fp, info };
  scheduleSave();
  return info;
}

// Para normalize.js: al renombrar un vídeo cambia su id (hash de la ruta
// relativa), así que sin esto se perdía el análisis de ffprobe ya hecho -
// intrascendente para un vídeo con archivo real (se puede volver a
// analizar), pero GRAVE para uno archivado (ver hls.js/archivedVideos.js):
// su original ya no existe, así que un análisis perdido no se puede
// recuperar nunca más con ffprobe, solo seguir sirviendo desde la caché.
function migrateEntry(oldId, newId) {
  if (oldId === newId || !store[oldId]) return;
  if (!store[newId]) store[newId] = store[oldId];
  delete store[oldId];
  scheduleSave();
}

// Tras cada escaneo del catálogo: quita del fichero los vídeos que ya no
// están (borrados/renombrados), para que no crezca sin límite. Nunca se
// borra la entrada de un vídeo ARCHIVADO (ver archivedVideos.js), pase lo
// que pase con "currentIds": para uno de esos, este análisis es la única
// fuente que queda de qué pistas tenía (el original ya no existe) - un
// despiste ahí sería irrecuperable, así que esta comprobación va por
// libre, sin fiarse solo de que quien llame haya incluido bien todos los
// ids archivados en "currentIds".
function pruneStore(currentIds) {
  const ids = new Set(currentIds);
  const archivedIds = new Set(Object.keys(archivedVideos.getAll()));
  let changed = false;
  for (const id of Object.keys(store)) {
    if (!ids.has(id) && !archivedIds.has(id)) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// Para el botón "Reintentar"/"Resolver fallidos" (ver hls.js:retry): getMediaInfo
// memoiza en RAM el resultado por video.id y esa memoria nunca caduca sola -
// solo la comprueba la primera vez en todo el proceso. Si un archivo se
// analizó una vez estando roto/incompleto (por eso falló) y luego se
// reemplaza por uno bueno (p.ej. se vuelve a descargar), el fingerprint en
// disco (codec-checks.json) sí detecta el cambio de tamaño/fecha, pero la
// memoria en RAM ni lo mira: seguía devolviendo el análisis viejo para
// siempre, así que "Reintentar" repetía el mismo error aunque el archivo ya
// estuviera bien, hasta reiniciar el servidor entero. Solo se borra la
// memoria en RAM, no la entrada persistida en disco (codec-checks.json): esa
// ya se revalida sola por fingerprint (tamaño+fecha) en cada llamada, y para
// un vídeo ARCHIVADO (original ya borrado) es la única prueba que queda de
// qué pistas tenía - no se puede volver a analizar nunca, así que no se toca.
function forgetAnalysis(id) {
  memo.delete(id);
}

// Para POST /api/admin/reload (ver adminReload.js): recarga codec-checks.json
// desde disco por si algo lo editó por fuera de este proceso. Antes hace
// *flush* del guardado diferido pendiente (scheduleSave, 2s de debounce) -
// si no, un análisis de ffprobe recién terminado y aún no escrito a disco se
// perdería sin más al machacarse "store" con lo que hubiera en el archivo.
function reloadStore() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeStore();
  }
  store = loadStore();
}

module.exports = {
  ffmpeg,
  getMediaInfo,
  inputPathFor,
  pruneStore,
  migrateEntry,
  ffprobePath,
  reloadStore,
  forgetAnalysis,
};
