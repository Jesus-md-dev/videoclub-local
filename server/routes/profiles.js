const express = require('express');
const profiles = require('../profiles');
const backup = require('../backup');

const router = express.Router();

router.use(express.json());

router.get('/profiles', (req, res) => {
  res.json(profiles.listProfiles());
});

router.post('/profiles', (req, res) => {
  try {
    const profile = profiles.createProfile(req.body?.name);
    backup.scheduleBackup();
    res.json(profile);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/profiles/:id', (req, res) => {
  profiles.deleteProfile(req.params.id);
  backup.scheduleBackup();
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
  backup.scheduleBackup();
}

// PUT para el uso normal (fetch); también se acepta POST porque
// navigator.sendBeacon (usado en beforeunload, más fiable que fetch al
// cerrar la pestaña) solo puede enviar POST.
router.put('/profiles/:id/progress/:videoId', saveProgress);
router.post('/profiles/:id/progress/:videoId', saveProgress);

router.post('/profiles/:id/progress/:videoId/dismiss', (req, res) => {
  if (!requireProfile(req, res)) return;
  profiles.dismissProgress(req.params.id, req.params.videoId);
  backup.scheduleBackup();
  res.json({ ok: true });
});

// Preferencias de reproducción del perfil (aspecto de los subtítulos,
// idioma de audio/subtítulos elegido la última vez...): se guardan en el
// servidor porque son "cómo prefiere ver/leer esto esta persona", igual en
// cualquier dispositivo de la red, no algo local a un aparato en concreto.
router.get('/profiles/:id/settings', (req, res) => {
  if (!requireProfile(req, res)) return;
  res.json(profiles.getSettings(req.params.id));
});

router.patch('/profiles/:id/settings', (req, res) => {
  if (!requireProfile(req, res)) return;
  res.json(profiles.setSettings(req.params.id, req.body || {}));
  backup.scheduleBackup();
});

module.exports = router;
