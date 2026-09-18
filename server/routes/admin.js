const express = require('express');
const adminReload = require('../adminReload');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

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

module.exports = router;
