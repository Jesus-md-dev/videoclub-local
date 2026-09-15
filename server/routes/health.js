const express = require('express');
const fs = require('fs');
const path = require('path');
const catalog = require('../catalog');
const { DATA_PATH, HLS_PATH } = require('../config');

const router = express.Router();

const CODEC_CHECKS_FILE = path.join(DATA_PATH, 'codec-checks.json');

// Comprobación pensada específicamente para lo que causó el episodio de
// Bleach sin subtítulos: un vídeo ARCHIVADO (original ya borrado, ver
// hls.js) que se haya quedado sin caché de análisis (codec-checks.json) es
// irrecuperable para siempre - ya no hay ningún archivo del que volver a
// sacar qué pistas de audio/subtítulos tenía. Mejor detectarlo ahora (y
// poder al menos buscarle un subtítulo de repuesto con SubDL)
// que enterarse vídeo a vídeo, mucho después, cuando alguien intente verlo.
router.get('/health/archived-videos', (req, res) => {
  let codecChecks = {};
  try {
    codecChecks = JSON.parse(fs.readFileSync(CODEC_CHECKS_FILE, 'utf-8'));
  } catch {
    // sin caché en absoluto: todos contarán como "sin análisis"
  }

  const archived = catalog.getCatalog().filter((v) => v.archived);
  const withoutCache = archived.filter((v) => !codecChecks[v.id]);
  const withoutAnything = withoutCache.filter((v) => !fs.existsSync(path.join(HLS_PATH, v.id, 'master.m3u8')));

  res.json({
    totalArchived: archived.length,
    withoutCache: withoutCache.length,
    withoutAnything: withoutAnything.length,
    sample: withoutCache.slice(0, 50).map((v) => ({ id: v.id, title: v.title, hasHls: !withoutAnything.includes(v) })),
  });
});

module.exports = router;
