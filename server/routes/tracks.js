const express = require('express');
const catalog = require('../catalog');
const tracks = require('../tracks');
const subtitles = require('../subtitles');
const localSubtitles = require('../localSubtitles');
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

// Importar a mano un subtítulo (.srt/.vtt) que ya tienes, para un vídeo en
// concreto: el archivo se manda como texto ya leído en el navegador (base64,
// para conservar los bytes crudos y que el servidor decida bien si viene en
// UTF-8 o Windows-1252/latin1 - ver subtitleConvert.js), no como subida
// multipart (evita añadir una dependencia nueva solo para esto).
router.post(
  '/subtitle/import',
  asyncHandler(async (req, res) => {
    const { videoId, filename, contentBase64, language } = req.body || {};
    if (!videoId || !filename || !contentBase64) {
      res.status(400).json({ error: 'Faltan "videoId", "filename" y/o "contentBase64"' });
      return;
    }
    const video = catalog.getVideoById(videoId);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch {
      res.status(400).json({ error: 'El contenido del archivo no es válido' });
      return;
    }
    try {
      const track = localSubtitles.importBuffer(videoId, filename, buffer, { language: language || null });
      res.json(track);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

module.exports = router;
