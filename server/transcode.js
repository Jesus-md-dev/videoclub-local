const fs = require('fs');
const path = require('path');
const { ffmpeg, getMediaInfo, inputPathFor } = require('./mediaInfo');
const { DATA_PATH } = require('./config');

const TRANSCODED_PATH = path.join(DATA_PATH, 'transcoded');

const COMPATIBLE_VIDEO_CODECS = ['h264'];
const COMPATIBLE_AUDIO_CODECS = ['aac', 'mp3'];
const COMPATIBLE_CONTAINERS = ['.mp4', '.m4v'];

// Estado por clave ('<id>' para la pista de audio por defecto, o '<id>#a<index>'
// para una pista de audio concreta): 'checking' | 'compatible' | 'processing' | 'ready' | 'failed'
const status = new Map();
const progress = new Map(); // key -> { percent: 0-100 | null, startedAt: number }
const defaultAudioCache = new Map(); // video.id -> índice de la pista de audio por defecto

function outputFile(key) {
  return path.join(TRANSCODED_PATH, `${key.replace('#', '__')}.mp4`);
}

async function defaultAudioIndex(video) {
  if (defaultAudioCache.has(video.id)) return defaultAudioCache.get(video.id);
  const info = await getMediaInfo(video);
  const audioStreams = info.streams.filter((s) => s.codec_type === 'audio');
  const chosen = audioStreams.find((s) => s.disposition?.default === 1) || audioStreams[0];
  const index = chosen ? chosen.index : null;
  defaultAudioCache.set(video.id, index);
  return index;
}

async function resolveKey(video, audioIndex) {
  const defaultAudio = await defaultAudioIndex(video);
  const effectiveAudio = audioIndex != null ? Number(audioIndex) : defaultAudio;
  return effectiveAudio === defaultAudio ? video.id : `${video.id}#a${effectiveAudio}`;
}

function runFfmpeg(inputPath, key, { videoCopy, audioCopy, audioMapIndex }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TRANSCODED_PATH, { recursive: true });
    const tmpOutput = `${outputFile(key)}.tmp.mp4`;

    const outputOptions = [
      '-map 0:v:0',
      audioMapIndex != null ? `-map 0:${audioMapIndex}` : '-map 0:a:0?',
      `-c:v ${videoCopy ? 'copy' : 'libx264'}`,
      `-c:a ${audioCopy ? 'copy' : 'aac'}`,
      '-movflags +faststart',
    ];
    if (!videoCopy) {
      outputOptions.push('-preset veryfast', '-crf 23');
    }

    progress.set(key, { percent: null, startedAt: Date.now() });

    ffmpeg(inputPath)
      .outputOptions(outputOptions)
      .format('mp4')
      .on('progress', (p) => {
        if (typeof p.percent === 'number' && !Number.isNaN(p.percent)) {
          const entry = progress.get(key);
          progress.set(key, { ...entry, percent: Math.min(99, Math.max(0, Math.round(p.percent))) });
        }
      })
      .on('error', (err) => {
        progress.delete(key);
        fs.rm(tmpOutput, { force: true }, () => {});
        reject(err);
      })
      .on('end', () => {
        progress.delete(key);
        fs.renameSync(tmpOutput, outputFile(key));
        resolve();
      })
      .save(tmpOutput);
  });
}

async function ensureChecked(video, audioIndex = null) {
  const defaultAudio = await defaultAudioIndex(video);
  const effectiveAudio = audioIndex != null ? Number(audioIndex) : defaultAudio;
  const useDefault = effectiveAudio === defaultAudio;
  const key = useDefault ? video.id : `${video.id}#a${effectiveAudio}`;

  const current = status.get(key);
  if (current) return current;

  if (fs.existsSync(outputFile(key))) {
    status.set(key, 'ready');
    return 'ready';
  }

  status.set(key, 'checking');

  const ext = path.extname(video.relativePath).toLowerCase();
  let info;
  try {
    info = await getMediaInfo(video);
  } catch (err) {
    console.warn(`No se pudo analizar "${video.title}": ${err.message}`);
    status.set(key, 'failed');
    return 'failed';
  }

  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.index === effectiveAudio);

  const videoOk = Boolean(videoStream) && COMPATIBLE_VIDEO_CODECS.includes(videoStream.codec_name);
  const audioOk = !audioStream || COMPATIBLE_AUDIO_CODECS.includes(audioStream.codec_name);
  const containerOk = COMPATIBLE_CONTAINERS.includes(ext);

  if (useDefault && videoOk && audioOk && containerOk) {
    status.set(key, 'compatible');
    return 'compatible';
  }

  status.set(key, 'processing');
  runFfmpeg(inputPathFor(video), key, {
    videoCopy: videoOk,
    audioCopy: audioOk,
    audioMapIndex: useDefault ? null : effectiveAudio,
  })
    .then(() => status.set(key, 'ready'))
    .catch((err) => {
      console.warn(`No se pudo convertir "${video.title}": ${err.message}`);
      status.set(key, 'failed');
    });

  return 'processing';
}

async function getStatus(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  return status.get(key) || 'unknown';
}

// Progreso de la conversión en curso (0-100, o null si aún no se puede
// estimar) y el tiempo transcurrido, para mostrar una barra de carga real.
async function getProgress(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  const entry = progress.get(key);
  if (!entry) return null;
  return { percent: entry.percent, elapsedMs: Date.now() - entry.startedAt };
}

async function playableFile(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  const file = outputFile(key);
  return fs.existsSync(file) ? file : null;
}

module.exports = { ensureChecked, getStatus, getProgress, playableFile };
