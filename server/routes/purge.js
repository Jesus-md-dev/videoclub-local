const express = require('express');
const purge = require('../purge');
const catalog = require('../catalog');
const catalogOverrides = require('../catalogOverrides');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Marca una carpeta con varios vídeos como "no es una serie, son títulos
// sueltos" (p.ej. "Berserk" con sus 3 películas de "La Edad de Oro"): a
// partir de ahí se listan cada uno como su propia película, no como una
// carpeta/serie conjunta.
router.post(
  '/catalog/ungroup',
  asyncHandler(async (req, res) => {
    const { key, ungrouped = true } = req.body || {};
    if (!key) {
      res.status(400).json({ error: 'Falta "key"' });
      return;
    }
    catalogOverrides.setUngrouped(key, ungrouped);
    await catalog.scan();
    res.json({ ok: true, key, ungrouped });
  })
);

// Quita del catálogo una obra cuya carpeta se ha borrado a mano en disco
// (ver purge.js: sin esto, los episodios "archivados" -HLS sin original-
// seguirían apareciendo para siempre aunque ya no quede nada de ellos).
router.post(
  '/catalog/purge',
  asyncHandler(async (req, res) => {
    const { key } = req.body || {};
    if (!key) {
      res.status(400).json({ error: 'Falta "key"' });
      return;
    }
    const result = await purge.purgeKey(key);
    res.json(result);
  })
);

// Borra el archivo de vídeo real (no solo sus metadatos, ver /catalog/purge
// arriba). Operación irreversible: además de la confirmación que ya exige
// el cliente (escribir el título exacto), se vuelve a exigir aquí -
// "confirmTitle" tiene que coincidir con "key" letra por letra- para que
// nada pueda llegar a borrar un archivo real sin pasar por esa doble
// comprobación, ni siquiera por un futuro error en el cliente.
router.post(
  '/catalog/delete-content',
  asyncHandler(async (req, res) => {
    const { key, confirmTitle } = req.body || {};
    if (!key) {
      res.status(400).json({ error: 'Falta "key"' });
      return;
    }
    if (typeof confirmTitle !== 'string' || confirmTitle.trim() !== key.trim()) {
      res.status(400).json({ error: 'El título de confirmación no coincide.' });
      return;
    }
    const result = await purge.deleteContent(key);
    res.json(result);
  })
);

// Borra un solo vídeo (un episodio o una película suelta, no una serie
// entera - ver /catalog/delete-content arriba para eso), desde el botón
// "Borrar" de la ficha rápida (QuickInfoModal, doble clic "Borrar" -> "¿Seguro?"
// en el cliente). "confirm: true" es la comprobación de que la petición viene
// de ese flujo con intención real, no de una llamada suelta - mismo espíritu
// que el título exacto de /catalog/delete-content, pero sin pedir escribir
// nada para un borrado puntual de un solo episodio.
router.post(
  '/catalog/delete-video',
  asyncHandler(async (req, res) => {
    const { id, confirm } = req.body || {};
    if (!id) {
      res.status(400).json({ error: 'Falta "id"' });
      return;
    }
    if (confirm !== true) {
      res.status(400).json({ error: 'Falta confirmar el borrado.' });
      return;
    }
    const result = await purge.deleteVideo(id);
    if (result.removed === 0) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    res.json(result);
  })
);

module.exports = router;
