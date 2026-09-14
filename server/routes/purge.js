const express = require('express');
const purge = require('../purge');
const catalog = require('../catalog');
const catalogOverrides = require('../catalogOverrides');

const router = express.Router();

router.use(express.json());

// Marca una carpeta con varios vídeos como "no es una serie, son títulos
// sueltos" (p.ej. "Berserk" con sus 3 películas de "La Edad de Oro"): a
// partir de ahí se listan cada uno como su propia película, no como una
// carpeta/serie conjunta.
router.post('/catalog/ungroup', (req, res) => {
  const { key, ungrouped = true } = req.body || {};
  if (!key) {
    res.status(400).json({ error: 'Falta "key"' });
    return;
  }
  catalogOverrides.setUngrouped(key, ungrouped);
  catalog.scan();
  res.json({ ok: true, key, ungrouped });
});

// Quita del catálogo una obra cuya carpeta se ha borrado a mano en disco
// (ver purge.js: sin esto, los episodios "archivados" -HLS sin original-
// seguirían apareciendo para siempre aunque ya no quede nada de ellos).
router.post('/catalog/purge', (req, res) => {
  const { key } = req.body || {};
  if (!key) {
    res.status(400).json({ error: 'Falta "key"' });
    return;
  }
  try {
    const result = purge.purgeKey(key);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
