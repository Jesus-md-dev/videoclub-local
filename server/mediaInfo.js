const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const ffmpeg = require('fluent-ffmpeg');
const { getVideosPath, DATA_PATH } = require('./config');

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

function probeRaw(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
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

// Tras cada escaneo del catálogo: quita del fichero los vídeos que ya no
// están (borrados/renombrados), para que no crezca sin límite.
function pruneStore(currentIds) {
  const ids = new Set(currentIds);
  let changed = false;
  for (const id of Object.keys(store)) {
    if (!ids.has(id)) {
      delete store[id];
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

module.exports = { ffmpeg, getMediaInfo, inputPathFor, pruneStore };
