const express = require('express');
const profiles = require('../profiles');

const router = express.Router();

router.use(express.json());

router.get('/profiles', (req, res) => {
  res.json(profiles.listProfiles());
});

router.post('/profiles', (req, res) => {
  try {
    res.json(profiles.createProfile(req.body?.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/profiles/:id', (req, res) => {
  profiles.deleteProfile(req.params.id);
  res.json({ ok: true });
});

function requireProfile(req, res) {
  if (!profiles.profileExists(req.params.id)) {
    res.status(404).json({ error: 'Perfil no encontrado' });
    return false;
  }
  return true;
}

router.get('/profiles/:id/progress', (req, res) => {
  if (!requireProfile(req, res)) return;
  res.json(profiles.getProgress(req.params.id));
});

router.get('/profiles/:id/progress/:videoId', (req, res) => {
  if (!requireProfile(req, res)) return;
  const data = profiles.getProgress(req.params.id);
  res.json(data[req.params.videoId] || null);
});

function saveProgress(req, res) {
  if (!requireProfile(req, res)) return;
  const { time, ratio } = req.body || {};
  if (typeof time !== 'number' || typeof ratio !== 'number') {
    res.status(400).json({ error: 'Faltan "time"/"ratio" (números)' });
    return;
  }
  res.json(profiles.setProgress(req.params.id, req.params.videoId, { time, ratio }));
}

// PUT para el uso normal (fetch); también se acepta POST porque
// navigator.sendBeacon (usado en beforeunload, más fiable que fetch al
// cerrar la pestaña) solo puede enviar POST.
router.put('/profiles/:id/progress/:videoId', saveProgress);
router.post('/profiles/:id/progress/:videoId', saveProgress);

router.post('/profiles/:id/progress/:videoId/dismiss', (req, res) => {
  if (!requireProfile(req, res)) return;
  profiles.dismissProgress(req.params.id, req.params.videoId);
  res.json({ ok: true });
});

module.exports = router;
