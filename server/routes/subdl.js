const express = require('express');
const catalog = require('../catalog');
const metadata = require('../metadata');
const config = require('../config');
const subdl = require('../subdl');
const openSubtitles = require('../opensubtitles');

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
  res.json({
    configured: subdl.isConfigured() || openSubtitles.isConfigured(),
    subdl: subdl.isConfigured(),
    openSubtitles: openSubtitles.isConfigured(),
  });
});

router.get('/subdl/config', (req, res) => {
  const os = config.getOpenSubtitlesConfig();
  res.json({
    apiKey: config.getSubdlApiKey() || '',
    openSubtitles: { apiKey: os.apiKey || '', username: os.username || '', hasPassword: Boolean(os.password) },
  });
});

router.post('/subdl/config', (req, res) => {
  const { apiKey, openSubtitles: osBody } = req.body || {};
  const key = config.setSubdlApiKey(apiKey);
  let osConfig = config.getOpenSubtitlesConfig();
  if (osBody) osConfig = config.setOpenSubtitlesConfig(osBody);
  res.json({
    configured: Boolean(key) || Boolean(osConfig.apiKey),
    subdl: Boolean(key),
    openSubtitles: Boolean(osConfig.apiKey),
  });
});

// SubDL siempre tiene prioridad (cuota gratuita mucho más generosa);
// OpenSubtitles solo se consulta si SubDL no está configurado, falla, o no
// encuentra nada - así la cuota tan baja de OpenSubtitles se gasta lo
// menos posible. Cada resultado lleva su "provider" para que la descarga
// sepa a qué API volver a pedírselo.
router.post('/subdl/search', async (req, res) => {
  const { videoId, languages } = req.body || {};
  const video = catalog.getVideoById(videoId);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  const { season, episode } = parseSeasonEpisode(video.title);
  const query = queryFor(video);

  let results = [];
  let lastError = null;
  if (subdl.isConfigured()) {
    try {
      results = (await subdl.search({ query, season, episode, languages })).map((r) => ({ ...r, provider: 'subdl' }));
    } catch (err) {
      lastError = err;
    }
  }
  if (results.length === 0 && openSubtitles.isConfigured()) {
    try {
      const fallback = await openSubtitles.search({ query, season, episode, languages: languages || 'es' });
      results = fallback.map((r) => ({ ...r, provider: 'opensubtitles' }));
      lastError = null;
    } catch (err) {
      lastError = lastError || err;
    }
  }
  if (results.length === 0 && lastError) {
    res.status(500).json({ error: lastError.message });
    return;
  }
  res.json({ results });
});

router.post('/subdl/download', async (req, res) => {
  const { videoId, fileId, language, release, provider } = req.body || {};
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
    const source = provider === 'opensubtitles' ? openSubtitles : subdl;
    const track = await source.downloadSubtitle(videoId, { fileId, language, release });
    res.json(track);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
