const express = require('express');
const catalog = require('../catalog');
const chromecast = require('../chromecast');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Mismas rutas que routes/dlna.js, mismo formato de respuesta - así el
// cliente (VideoControls.jsx) puede tratar los dos orígenes de dispositivo
// (DLNA y Chromecast, ver issue #109) de forma prácticamente idéntica, solo
// cambiando el prefijo según de qué lista venga el dispositivo elegido.
router.get('/chromecast/devices', (req, res) => {
  res.json({ devices: chromecast.getDevices() });
});

router.post(
  '/chromecast/cast',
  asyncHandler(async (req, res) => {
    const { deviceId, videoId, profileId, audioIndex } = req.body || {};
    if (!deviceId || !videoId) {
      res.status(400).json({ error: 'Faltan "deviceId" y/o "videoId"' });
      return;
    }
    const video = catalog.getVideoById(videoId);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    await chromecast.cast({ deviceId, video, profileId, audioIndex: audioIndex != null ? Number(audioIndex) : null });
    res.json({ ok: true });
  })
);

router.post('/chromecast/pause', async (req, res) => {
  try {
    await chromecast.pause();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/chromecast/resume', async (req, res) => {
  try {
    await chromecast.resume();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/chromecast/seek', async (req, res) => {
  const seconds = Number(req.body?.seconds);
  if (!Number.isFinite(seconds)) {
    res.status(400).json({ error: 'Falta "seconds"' });
    return;
  }
  try {
    await chromecast.seek(seconds);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post(
  '/chromecast/stop',
  asyncHandler(async (req, res) => {
    await chromecast.stop();
    res.json({ ok: true });
  })
);

router.get('/chromecast/status', (req, res) => {
  res.json(chromecast.getStatus());
});

module.exports = router;
