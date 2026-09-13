const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const ffmpeg = require('fluent-ffmpeg');
const { getVideosPath, THUMBNAILS_PATH } = require('./config');

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

const generating = new Set();

function thumbnailFile(id) {
  return path.join(THUMBNAILS_PATH, `${id}.jpg`);
}

function hasThumbnail(id) {
  return fs.existsSync(thumbnailFile(id));
}

function generateThumbnail(video) {
  return new Promise((resolve) => {
    if (!ffmpegPath || generating.has(video.id) || hasThumbnail(video.id)) {
      resolve();
      return;
    }
    generating.add(video.id);

    const inputPath = path.join(getVideosPath(), video.relativePath);
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
  });
}

async function generateMissingThumbnails(videos) {
  fs.mkdirSync(THUMBNAILS_PATH, { recursive: true });
  for (const video of videos) {
    // Secuencial para no saturar CPU/disco al escanear catálogos grandes.
    // eslint-disable-next-line no-await-in-loop
    await generateThumbnail(video);
  }
}

module.exports = { generateMissingThumbnails, hasThumbnail, thumbnailFile };
