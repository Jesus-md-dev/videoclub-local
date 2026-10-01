const fs = require('fs');
const path = require('path');
const express = require('express');
const adminReload = require('../adminReload');
const asyncHandler = require('../asyncHandler');
const restartManager = require('../restartManager');
const updater = require('../updater');
const catalog = require('../catalog');
const hls = require('../hls');
const moveOriginal = require('../moveOriginal');
const cleanup = require('../cleanup');
const ffmpegLimiter = require('../ffmpeg-limiter');
const { DATA_PATH, HLS_PATH, MOVED_ORIGINALS_PATH, getVideosPath } = require('../config');

const router = express.Router();
const startedAt = new Date().toISOString();

// Recarga en caliente de todos los datos JSON que el servidor solo leía una
// vez al arrancar (issue #89) - para cuando algo los edita por fuera de
// este proceso (migración, restauración de backup, un script de limpieza
// suelto) sin tener que reiniciar el servidor entero y cortar generaciones
// HLS en curso.
router.post(
  '/admin/reload',
  asyncHandler(async (req, res) => {
    const result = await adminReload.reloadAll();
    res.json(result);
  })
);

// Espacio libre de cada disco que usa el videoclub (uno por letra de unidad).
function diskUsage() {
  const places = [
    ['Vídeos', getVideosPath()],
    ['Datos', DATA_PATH],
    ['HLS', HLS_PATH],
    ['Originales trasladados', MOVED_ORIGINALS_PATH],
    ['Proyecto y copia de seguridad', path.join(__dirname, '..', '..')],
  ];
  const byRoot = new Map();
  for (const [label, dir] of places) {
    if (!dir) continue;
    const root = path.parse(path.resolve(dir)).root;
    if (!byRoot.has(root)) byRoot.set(root, { drive: root, uses: [] });
    byRoot.get(root).uses.push(label);
  }
  return [...byRoot.values()].map((disk) => {
    try {
      const st = fs.statfsSync(disk.drive);
      return { ...disk, freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
    } catch (err) {
      return { ...disk, error: err.message };
    }
  });
}

function hlsSummary() {
  const summary = { total: 0, ready: 0, processing: 0, pending: 0, failed: 0 };
  for (const video of catalog.getCatalog()) {
    summary.total += 1;
    const status = hls.getStatus(video);
    if (status === 'ready') summary.ready += 1;
    else if (status === 'processing' || status === 'checking') summary.processing += 1;
    else if (status === 'failed') summary.failed += 1;
    else summary.pending += 1;
  }
  return summary;
}

// Todo el estado de un vistazo (issue #140): versión en marcha y si hay
// cambios pendientes de aplicar, reinicio programado y qué lo retiene,
// discos, colas y fallidos, última limpieza.
router.get(
  '/admin/status',
  asyncHandler(async (req, res) => {
    const moves = moveOriginal.getQueueStatus();
    res.json({
      server: {
        pid: process.pid,
        startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
      },
      restart: restartManager.getState(),
      updates: await updater.getState(),
      disks: diskUsage(),
      hls: hlsSummary(),
      ffmpeg: ffmpegLimiter.getStats(),
      moves: {
        moving: moves.moving.length,
        queued: moves.queued.length,
        done: moves.done.length,
        failed: moves.failed.length,
      },
      cleanup: cleanup.getState(),
    });
  })
);

// { mode: 'idle' } (por defecto) reinicia cuando no haya nada en marcha que
// se pueda cortar; { mode: 'now' } al momento; { mode: 'cancel' } anula uno
// programado.
router.post('/admin/restart', (req, res) => {
  const mode = req.body?.mode || 'idle';
  try {
    if (mode === 'cancel') {
      res.json(restartManager.cancelRestart());
    } else if (mode === 'idle' || mode === 'now') {
      res.json(restartManager.requestRestart(mode, mode === 'now' ? 'pedido desde la web' : 'pedido desde la web (cuando esté libre)'));
    } else {
      res.status(400).json({ error: 'mode debe ser "idle", "now" o "cancel"' });
    }
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Aplica lo que haya cambiado desde que arrancó el proceso: recompila la
// web si hace falta (sin reiniciar) y, si cambió el servidor, programa un
// reinicio cuando esté libre. { pull: true } trae antes lo último de GitHub.
router.post(
  '/admin/update',
  asyncHandler(async (req, res) => {
    try {
      res.json(await updater.applyUpdates({ pull: Boolean(req.body?.pull), reason: 'pedido desde la web' }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  })
);

// Solo recompilar la web (cambios de client/): no hace falta reiniciar.
router.post(
  '/admin/rebuild-client',
  asyncHandler(async (req, res) => {
    res.json(await updater.rebuildClient());
  })
);

module.exports = router;
