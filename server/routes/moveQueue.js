const express = require('express');
const moveOriginal = require('../moveOriginal');

const router = express.Router();

// Estado de la cola de traslado de originales a MOVED_ORIGINALS_PATH (ver
// server/moveOriginal.js): qué se está moviendo ahora mismo, qué queda en
// cola, y lo ya hecho/fallido desde que arrancó el servidor.
router.get('/move-queue', (req, res) => {
  res.json(moveOriginal.getQueueStatus());
});

module.exports = router;
