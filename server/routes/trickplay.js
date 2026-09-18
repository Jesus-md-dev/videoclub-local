const express = require('express');
const catalog = require('../catalog');
const trickplay = require('../trickplay');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.get(
  '/trickplay/:id',
  asyncHandler(async (req, res) => {
    const video = catalog.getVideoById(req.params.id);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    const meta = await trickplay.ensureTrickplay(video);
    if (!meta) {
      res.status(404).json({ error: 'Sin vista previa disponible' });
      return;
    }
    res.json({ ...meta, spriteUrl: `/api/trickplay/${video.id}/sprite.jpg` });
  })
);

router.get('/trickplay/:id/sprite.jpg', (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video || !trickplay.hasSprite(video.id)) {
    res.status(404).end();
    return;
  }
  res.type('image/jpeg');
  res.sendFile(trickplay.spriteFile(video.id));
});

module.exports = router;
