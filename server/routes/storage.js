const express = require('express');
const cleanup = require('../cleanup');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Espacio que ocupan los datos, el espejo, las instantáneas y la papelera,
// más el resultado de la última limpieza (ver server/cleanup.js).
router.get(
  '/storage',
  asyncHandler(async (req, res) => {
    res.json({ usage: await cleanup.getStorageUsage(), cleanup: cleanup.getState() });
  })
);

// Botón "Limpiar ahora" de Configuración.
router.post(
  '/storage/cleanup',
  asyncHandler(async (req, res) => {
    const result = await cleanup.runCleanup('manual');
    res.json({ result, usage: await cleanup.getStorageUsage(), cleanup: cleanup.getState() });
  })
);

module.exports = router;
