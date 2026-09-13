const fs = require('fs');
const path = require('path');
const { ffmpeg, getMediaInfo, inputPathFor } = require('./mediaInfo');
const { DATA_PATH } = require('./config');

const TRICKPLAY_PATH = path.join(DATA_PATH, 'trickplay');
const THUMB_WIDTH = 160;
const MAX_THUMBS = 100;
const MIN_INTERVAL = 5;

const pending = new Map(); // video.id -> Promise
const failed = new Set();

function metaFile(id) {
  return path.join(TRICKPLAY_PATH, `${id}.json`);
}

function spriteFile(id) {
  return path.join(TRICKPLAY_PATH, `${id}.jpg`);
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), 'utf-8'));
  } catch {
    return null;
  }
}

async function generate(video) {
  const info = await getMediaInfo(video);
  const duration = Number(info.format?.duration);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  if (!duration || !videoStream) throw new Error('No se pudo determinar la duración/vídeo');

  const interval = Math.max(MIN_INTERVAL, Math.ceil(duration / MAX_THUMBS));
  const count = Math.max(1, Math.min(MAX_THUMBS, Math.ceil(duration / interval)));
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const thumbHeight = Math.round((THUMB_WIDTH * videoStream.height) / videoStream.width);

  fs.mkdirSync(TRICKPLAY_PATH, { recursive: true });
  const tmpSprite = `${spriteFile(video.id)}.tmp.jpg`;

  await new Promise((resolve, reject) => {
    ffmpeg(inputPathFor(video))
      .outputOptions([
        `-vf fps=1/${interval},scale=${THUMB_WIDTH}:-1,tile=${columns}x${rows}`,
        '-frames:v 1',
        '-q:v 4',
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(tmpSprite);
  });

  fs.renameSync(tmpSprite, spriteFile(video.id));
  const meta = { interval, columns, rows, count, thumbWidth: THUMB_WIDTH, thumbHeight, duration };
  fs.writeFileSync(metaFile(video.id), JSON.stringify(meta));
  return meta;
}

// Genera (si falta) la hoja de miniaturas para la vista previa al arrastrar
// la barra de progreso. Bajo demanda, cacheada en disco; si falla (formato
// raro, vídeo muy corto...) simplemente no habrá vista previa, sin romper
// la reproducción normal.
function ensureTrickplay(video) {
  const existing = readMeta(video.id);
  if (existing) return Promise.resolve(existing);
  if (failed.has(video.id)) return Promise.resolve(null);
  if (pending.has(video.id)) return pending.get(video.id);

  const promise = generate(video)
    .catch((err) => {
      console.warn(`No se pudo generar la vista previa de "${video.title}": ${err.message}`);
      failed.add(video.id);
      return null;
    })
    .finally(() => pending.delete(video.id));

  pending.set(video.id, promise);
  return promise;
}

function getMeta(id) {
  return readMeta(id);
}

function hasSprite(id) {
  return fs.existsSync(spriteFile(id));
}

module.exports = { ensureTrickplay, getMeta, hasSprite, spriteFile };
