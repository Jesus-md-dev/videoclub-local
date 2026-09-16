const express = require('express');
const catalog = require('../catalog');
const dlna = require('../dlna');

const router = express.Router();
router.use(express.json());

router.get('/dlna/devices', (req, res) => {
  res.json({ devices: dlna.getDevices() });
});

router.post('/dlna/cast', async (req, res) => {
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
  try {
    await dlna.cast({ deviceId, video, profileId, audioIndex: audioIndex != null ? Number(audioIndex) : null });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dlna/remux/:id', (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  dlna.remuxStream(req, res, video);
});

router.post('/dlna/pause', async (req, res) => {
  try {
    await dlna.pause();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dlna/resume', async (req, res) => {
  try {
    await dlna.resume();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dlna/seek', async (req, res) => {
  const seconds = Number(req.body?.seconds);
  if (!Number.isFinite(seconds)) {
    res.status(400).json({ error: 'Falta "seconds"' });
    return;
  }
  try {
    await dlna.seek(seconds);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dlna/stop', async (req, res) => {
  await dlna.stop();
  res.json({ ok: true });
});

router.get('/dlna/status', (req, res) => {
  res.json(dlna.getStatus());
});

module.exports = router;
