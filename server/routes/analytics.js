const express = require('express');
const analytics = require('../analytics');

const router = express.Router();

router.use(express.json());

// Lista blanca de eventos: para no acabar guardando cualquier cosa que
// mande el navegador de cualquiera, ni datos personales sin querer.
const ALLOWED_EVENTS = new Set([
  'search',
  'genre_filter',
  'play_start',
  'play_complete',
  'stall',
  'play_error',
]);

router.post('/analytics/track', (req, res) => {
  const { event, ...data } = req.body || {};
  if (!ALLOWED_EVENTS.has(event)) {
    res.status(400).json({ error: 'Evento no reconocido' });
    return;
  }
  analytics.track(event, data);
  res.json({ ok: true });
});

router.get('/analytics/summary', (req, res) => {
  res.json(analytics.summary());
});

module.exports = router;
