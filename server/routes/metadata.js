const express = require('express');
const metadata = require('../metadata');

const router = express.Router();

router.use(express.json());

// Olvida la caché de una clave (nombre de carpeta de serie/anime o de
// vídeo suelto) y la vuelve a buscar ya mismo, sin reiniciar el servidor.
router.post('/metadata/refresh', async (req, res) => {
  const { key } = req.body || {};
  if (!key) {
    res.status(400).json({ error: 'Falta "key"' });
    return;
  }
  try {
    const data = await metadata.refreshMetadata(key);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fija a mano los metadatos de una clave a partir de un id de TMDB
// conocido (para cuando la búsqueda automática encuentra la ficha
// equivocada, o hace falta la carátula de una temporada en concreto).
router.post('/metadata/override', async (req, res) => {
  const { key, tmdbType, tmdbId, season } = req.body || {};
  if (!key || !tmdbType || !tmdbId) {
    res.status(400).json({ error: 'Faltan "key", "tmdbType" ("tv" o "movie") y/o "tmdbId"' });
    return;
  }
  try {
    const data = await metadata.overrideFromTmdb(key, { tmdbType, tmdbId, season });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
