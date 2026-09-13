const express = require('express');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');

const router = express.Router();

router.get('/videos', (req, res) => {
  const videos = catalog.getCatalog().map((video) => ({
    id: video.id,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    hasThumbnail: thumbnails.hasThumbnail(video.id),
  }));
  res.json(videos);
});

router.post('/scan', async (req, res) => {
  try {
    const videos = catalog.scan();
    // Generar carátulas en segundo plano, sin bloquear la respuesta.
    thumbnails.generateMissingThumbnails(videos);
    res.json({ count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
