const express = require('express');
const upscale = require('../upscale');

const router = express.Router();

// Estado de la cola de reescalado con IA (ver server/upscale.js): qué se
// está reescalando ahora mismo y en qué fase, qué queda en cola, y lo ya
// hecho/fallido desde que arrancó el servidor.
router.get('/upscale-queue', (req, res) => {
  res.json(upscale.getQueueStatus());
});

module.exports = router;
