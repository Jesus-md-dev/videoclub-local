const express = require('express');
const catalog = require('../catalog');
const metadata = require('../metadata');
const config = require('../config');
const subdl = require('../subdl');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

function parseSeasonEpisode(title) {
  const m = title.match(/S(\d{1,2})E(\d{1,4})/i);
  if (!m) return { season: null, episode: null };
  return { season: Number(m[1]), episode: Number(m[2]) };
}

function metaFor(video) {
  const groupKey = catalog.metadataKeyFor(video);
  return metadata.getCached(groupKey);
}

function queryFor(video, meta) {
  const groupKey = catalog.metadataKeyFor(video);
  return meta.tmdbName || meta.cleanName || groupKey;
}

router.get('/subdl/status', (req, res) => {
  res.json({ configured: subdl.isConfigured() });
});

router.get('/subdl/config', (req, res) => {
  res.json({ apiKey: config.getSubdlApiKey() || '' });
});

router.post('/subdl/config', (req, res) => {
  const key = config.setSubdlApiKey(req.body?.apiKey);
  res.json({ configured: Boolean(key) });
});

router.post(
  '/subdl/search',
  asyncHandler(async (req, res) => {
    const { videoId, languages } = req.body || {};
    const video = catalog.getVideoById(videoId);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    const { season, episode } = parseSeasonEpisode(video.title);
    const meta = metaFor(video);
    const results = await subdl.search({ query: queryFor(video, meta), season, episode, languages, type: meta.type });
    res.json({ results });
  })
);

router.post(
  '/subdl/download',
  asyncHandler(async (req, res) => {
    const { videoId, fileId, language, release } = req.body || {};
    const video = catalog.getVideoById(videoId);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    if (!fileId) {
      res.status(400).json({ error: 'Falta "fileId"' });
      return;
    }
    const track = await subdl.downloadSubtitle(videoId, { fileId, language, release });
    res.json(track);
  })
);

module.exports = router;
