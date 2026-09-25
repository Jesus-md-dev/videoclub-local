const express = require('express');
const normalize = require('../normalize');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Muestra de hasta 30 cambios propuestos, sin tocar nada todavía: para que
// la persona vea qué haría el botón antes de lanzarlo.
router.get(
  '/normalize/preview',
  asyncHandler(async (req, res) => {
    const candidates = await normalize.previewCandidates();
    // ?all=1: la lista entera, para revisar un cambio grande antes de lanzarlo.
    const shown = req.query.all === '1' ? candidates : candidates.slice(0, 30);
    res.json({
      count: candidates.length,
      items: shown.map((c) => ({ from: c.video.relativePath, to: c.newRelativePath })),
    });
  })
);

router.post(
  '/normalize/run',
  asyncHandler(async (req, res) => {
    if (normalize.getProgress().running) {
      res.status(409).json({ error: 'Ya hay una normalización en marcha', progress: normalize.getProgress() });
      return;
    }
    // runNormalizeAll calcula los candidatos y arranca el trabajo en segundo
    // plano, pero solo espera a eso (no a que termine) antes de devolver el
    // progreso inicial con el total ya calculado.
    const progress = await normalize.runNormalizeAll();
    res.json({ started: true, total: progress.total });
  })
);

router.get('/normalize/status', (req, res) => {
  res.json(normalize.getProgress());
});

module.exports = router;
