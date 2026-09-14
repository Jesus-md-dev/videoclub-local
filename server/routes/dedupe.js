const express = require('express');
const catalog = require('../catalog');
const dedupe = require('../dedupe');
const transcode = require('../transcode');

const router = express.Router();

router.use(express.json());

// Sustituye el archivo original de un vídeo por su versión ya convertida
// (para no tener las dos copias ocupando espacio). Requiere que ya exista
// una conversión lista. Por defecto conserva una copia de seguridad del
// original (".bak") junto al archivo, por si hay que revertirlo.
router.post('/videos/:id/replace-with-transcoded', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  const keepBackup = req.body?.keepBackup !== false;
  try {
    const transcodedFile = await transcode.playableFile(video);
    const result = await dedupe.replaceWithTranscoded(video, transcodedFile, { keepBackup });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
