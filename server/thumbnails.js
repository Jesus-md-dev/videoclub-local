const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const ffmpeg = require('fluent-ffmpeg');
const { THUMBNAILS_PATH } = require('./config');
const { runLimited } = require('./ffmpeg-limiter');
const { inputPathFor } = require('./mediaInfo');

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

const generating = new Set();

// Mismo motivo que readyIds en hls.js: hasThumbnail se llama una vez por
// vídeo en cada petición a /api/videos (miles de fs.existsSync síncronos
// sobre el catálogo completo) - con el disco externo ocupado eso puede
// bloquear el hilo principal de Node entero (#65). Una carátula que ya
// existe no desaparece salvo purga explícita (ver forget()).
const existingIds = new Set();

function thumbnailFile(id) {
  return path.join(THUMBNAILS_PATH, `${id}.jpg`);
}

function hasThumbnail(id) {
  if (existingIds.has(id)) return true;
  const exists = fs.existsSync(thumbnailFile(id));
  if (exists) existingIds.add(id);
  return exists;
}

function forget(id) {
  existingIds.delete(id);
}

function generateThumbnail(video) {
  if (!ffmpegPath || generating.has(video.id) || hasThumbnail(video.id)) {
    return Promise.resolve();
  }
  generating.add(video.id);

  // El escaneo inicial y el vigilante de carpeta (watcher) pueden llamar a
  // esto por separado casi a la vez; runLimited comparte el mismo tope
  // global de ffmpeg que trickplay/transcode, no solo uno propio.
  return runLimited(
    () =>
      new Promise((resolve) => {
        const inputPath = inputPathFor(video);
        const outputFile = `${video.id}.jpg`;

        ffmpeg(inputPath)
          .on('end', () => {
            generating.delete(video.id);
            resolve();
          })
          .on('error', (err) => {
            generating.delete(video.id);
            console.warn(`No se pudo generar carátula para "${video.title}": ${err.message}`);
            resolve();
          })
          .screenshots({
            count: 1,
            timestamps: ['10%'],
            filename: outputFile,
            folder: THUMBNAILS_PATH,
            size: '320x?',
          });
      })
  );
}

async function generateMissingThumbnails(videos) {
  fs.mkdirSync(THUMBNAILS_PATH, { recursive: true });
  for (const video of videos) {
    // Secuencial para no saturar CPU/disco al escanear catálogos grandes.
    // eslint-disable-next-line no-await-in-loop
    await generateThumbnail(video);
  }
}

module.exports = { generateMissingThumbnails, hasThumbnail, thumbnailFile, forget };
