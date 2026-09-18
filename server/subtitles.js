const fs = require('fs');
const path = require('path');
const { ffmpeg, inputPathFor } = require('./mediaInfo');
const { DATA_PATH } = require('./config');

const SUBTITLES_PATH = path.join(DATA_PATH, 'subtitles');
const extracting = new Map();

function outputFile(videoId, streamIndex) {
  return path.join(SUBTITLES_PATH, `${videoId}-${streamIndex}.vtt`);
}

function extractSubtitle(video, streamIndex) {
  const file = outputFile(video.id, streamIndex);
  if (fs.existsSync(file)) return Promise.resolve(file);

  const key = `${video.id}:${streamIndex}`;
  if (extracting.has(key)) return extracting.get(key);

  const promise = new Promise((resolve, reject) => {
    fs.mkdirSync(SUBTITLES_PATH, { recursive: true });
    const tmpFile = `${file}.tmp.vtt`;

    ffmpeg(inputPathFor(video))
      .outputOptions([`-map 0:${streamIndex}`])
      .format('webvtt')
      .on('error', (err) => {
        fs.rm(tmpFile, { force: true }, () => {});
        reject(err);
      })
      .on('end', () => {
        fs.renameSync(tmpFile, file);
        resolve(file);
      })
      .save(tmpFile);
  }).finally(() => extracting.delete(key));

  extracting.set(key, promise);
  return promise;
}

// Para purge.js/deleteContent: borra todos los subtítulos de un vídeo (los
// tres orígenes -extraído, SubDL, importado- comparten el mismo prefijo de
// nombre "<id>-", ver outputFile), sin tener que conocer aquí el streamIndex
// exacto de cada uno.
function removeAllFor(videoId) {
  let entries;
  try {
    entries = fs.readdirSync(SUBTITLES_PATH);
  } catch {
    return;
  }
  const prefix = `${videoId}-`;
  for (const name of entries) {
    if (name.startsWith(prefix)) fs.rmSync(path.join(SUBTITLES_PATH, name), { force: true });
  }
}

module.exports = { extractSubtitle, outputFile, removeAllFor };
