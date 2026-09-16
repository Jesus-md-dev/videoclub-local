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
const store = loadStore();
let saveTimer = null;

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(CODEC_CHECKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(CODEC_CHECKS_FILE, JSON.stringify(store));
  }, 2000);
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

module.exports = { ffmpeg, getMediaInfo, inputPathFor, pruneStore, migrateEntry, ffprobePath };
