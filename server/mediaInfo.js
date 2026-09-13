const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const ffmpeg = require('fluent-ffmpeg');
const { getVideosPath } = require('./config');

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

const cache = new Map(); // video.id -> ffprobe data

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
  if (cache.has(video.id)) return cache.get(video.id);
  const info = await probeRaw(inputPathFor(video));
  cache.set(video.id, info);
  return info;
}

module.exports = { ffmpeg, getMediaInfo, inputPathFor };
