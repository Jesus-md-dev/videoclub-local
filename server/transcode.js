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

const TRANSCODED_PATH = path.join(DATA_PATH, 'transcoded');

const COMPATIBLE_VIDEO_CODECS = ['h264'];
const COMPATIBLE_AUDIO_CODECS = ['aac', 'mp3'];
const COMPATIBLE_CONTAINERS = ['.mp4', '.m4v'];

// Estado por vídeo: 'checking' | 'compatible' | 'processing' | 'ready' | 'failed'
const status = new Map();

function outputFile(id) {
  return path.join(TRANSCODED_PATH, `${id}.mp4`);
}

function probe(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function inspect(inputPath, ext) {
  const info = await probe(inputPath);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.codec_type === 'audio');

  const videoOk = Boolean(videoStream) && COMPATIBLE_VIDEO_CODECS.includes(videoStream.codec_name);
  const audioOk = !audioStream || COMPATIBLE_AUDIO_CODECS.includes(audioStream.codec_name);
  const containerOk = COMPATIBLE_CONTAINERS.includes(ext);

  return { needed: !(videoOk && audioOk && containerOk), videoCopy: videoOk, audioCopy: audioOk };
}

function runFfmpeg(inputPath, id, { videoCopy, audioCopy }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TRANSCODED_PATH, { recursive: true });
    const tmpOutput = `${outputFile(id)}.tmp.mp4`;
    const outputOptions = ['-movflags +faststart'];
    if (!videoCopy) {
      outputOptions.push('-preset veryfast', '-crf 23');
    }

    ffmpeg(inputPath)
      .videoCodec(videoCopy ? 'copy' : 'libx264')
      .audioCodec(audioCopy ? 'copy' : 'aac')
      .outputOptions(outputOptions)
      .format('mp4')
      .on('error', (err) => {
        fs.rm(tmpOutput, { force: true }, () => {});
        reject(err);
      })
      .on('end', () => {
        fs.renameSync(tmpOutput, outputFile(id));
        resolve();
      })
      .save(tmpOutput);
  });
}

async function ensureChecked(video) {
  const current = status.get(video.id);
  if (current) return current;

  if (fs.existsSync(outputFile(video.id))) {
    status.set(video.id, 'ready');
    return 'ready';
  }

  status.set(video.id, 'checking');
  const inputPath = path.join(getVideosPath(), video.relativePath);
  const ext = path.extname(video.relativePath).toLowerCase();

  let work;
  try {
    work = await inspect(inputPath, ext);
  } catch (err) {
    console.warn(`No se pudo analizar "${video.title}": ${err.message}`);
    status.set(video.id, 'failed');
    return 'failed';
  }

  if (!work.needed) {
    status.set(video.id, 'compatible');
    return 'compatible';
  }

  status.set(video.id, 'processing');
  runFfmpeg(inputPath, video.id, work)
    .then(() => status.set(video.id, 'ready'))
    .catch((err) => {
      console.warn(`No se pudo convertir "${video.title}": ${err.message}`);
      status.set(video.id, 'failed');
    });

  return 'processing';
}

function getStatus(id) {
  return status.get(id) || 'unknown';
}

function playableFile(id) {
  return fs.existsSync(outputFile(id)) ? outputFile(id) : null;
}

module.exports = { ensureChecked, getStatus, playableFile };
