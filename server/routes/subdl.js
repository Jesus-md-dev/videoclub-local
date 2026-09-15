const express = require('express');
const catalog = require('../catalog');
const metadata = require('../metadata');
const config = require('../config');
const subdl = require('../subdl');

const router = express.Router();
router.use(express.json());

function parseSeasonEpisode(title) {
  const m = title.match(/S(\d{1,2})E(\d{1,4})/i);
  if (!m) return { season: null, episode: null };
  return { season: Number(m[1]), episode: Number(m[2]) };
}

function queryFor(video) {
  const groupKey = catalog.metadataKeyFor(video);
  const meta = metadata.getCached(groupKey);
  return meta.cleanName || groupKey;
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

router.post('/subdl/search', async (req, res) => {
  const { videoId, languages } = req.body || {};
  const video = catalog.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  try {
    const { season, episode } = parseSeasonEpisode(video.title);
    const results = await subdl.search({ query: queryFor(video), season, episode, languages });
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/subdl/download', async (req, res) => {
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
  try {
    const track = await subdl.downloadSubtitle(videoId, { fileId, language, release });
    res.json(track);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
