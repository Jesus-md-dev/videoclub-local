const express = require('express');
const metadata = require('../metadata');
const catalog = require('../catalog');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

// Fuerza nombre y carátula de TODA la biblioteca desde TMDB (en español),
// sin tocar lo que no encuentre. Se lanza en segundo plano (puede tardar
// varios minutos con cientos de series/películas, limitado por el mismo
// throttle que el resto de peticiones a TMDB) y se consulta con
// GET /metadata/force-tmdb-status.
router.post('/metadata/force-tmdb-all', (req, res) => {
  const progress = metadata.getForceTmdbProgress();
  if (progress.running) {
    res.status(409).json({ error: 'Ya hay una actualización en marcha', progress });
    return;
  }
  const keys = catalog.getAllGroupKeys();
  metadata.forceTmdbRefreshAll(keys).catch((err) => {
    console.warn(`Fallo forzando actualización TMDB de toda la biblioteca: ${err.message}`);
  });
  res.json({ started: true, total: keys.length });
});

router.get('/metadata/force-tmdb-status', (req, res) => {
  res.json(metadata.getForceTmdbProgress());
});

// Olvida la caché de una clave (nombre de carpeta de serie/anime o de
// vídeo suelto) y la vuelve a buscar ya mismo, sin reiniciar el servidor.
router.post(
  '/metadata/refresh',
  asyncHandler(async (req, res) => {
    const { key } = req.body || {};
    if (!key) {
      res.status(400).json({ error: 'Falta "key"' });
      return;
    }
    const data = await metadata.refreshMetadata(key);
    res.json(data);
  })
);

// Fija a mano los metadatos de una clave a partir de un id de TMDB
// conocido (para cuando la búsqueda automática encuentra la ficha
// equivocada, o hace falta la carátula de una temporada en concreto).
router.post(
  '/metadata/override',
  asyncHandler(async (req, res) => {
    const { key, tmdbType, tmdbId, season } = req.body || {};
    if (!key || !tmdbType || !tmdbId) {
      res.status(400).json({ error: 'Faltan "key", "tmdbType" ("tv" o "movie") y/o "tmdbId"' });
      return;
    }
    const data = await metadata.overrideFromTmdb(key, { tmdbType, tmdbId, season });
    res.json(data);
  })
);

// Hasta 3 fichas candidatas de TMDB (nombre, año, carátula) para que la
// persona elija cuál es la correcta a mano, en vez de fiarse a ciegas de
// la búsqueda automática (ver ConfigPage/QuickInfoModal "Cambiar carátula").
router.get(
  '/metadata/candidates',
  asyncHandler(async (req, res) => {
    const key = typeof req.query.key === 'string' ? req.query.key : '';
    if (!key) {
      res.status(400).json({ error: 'Falta "key"' });
      return;
    }
    const candidates = await metadata.getPosterCandidates(key);
    res.json({ candidates });
  })
);

module.exports = router;
