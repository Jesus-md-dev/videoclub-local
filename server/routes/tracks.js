const express = require('express');
const catalog = require('../catalog');
const tracks = require('../tracks');
const subtitles = require('../subtitles');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.get(
  '/tracks/:id',
  asyncHandler(async (req, res) => {
    const video = catalog.getVideoById(req.params.id);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    const result = await tracks.getTracks(video);
    res.json(result);
  })
);

router.get('/subtitle/:id/:streamIndex', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).end();
    return;
  }
  try {
    const file = await subtitles.extractSubtitle(video, req.params.streamIndex);
    res.type('text/vtt');
    res.sendFile(file);
  } catch (err) {
    res.status(500).json({ error: 'No se pudo extraer el subtítulo' });
  }
});

module.exports = router;
