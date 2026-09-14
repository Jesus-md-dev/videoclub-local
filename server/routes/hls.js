const express = require('express');
const fs = require('fs');
const path = require('path');
const catalog = require('../catalog');
const hls = require('../hls');

const router = express.Router();

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

// Los nombres de variante (carpetas) salen del idioma/título de la pista
// de audio original, que viene del propio archivo de vídeo (metadatos no
// de fiar). safeJoin comprueba que la ruta resuelta se queda dentro de la
// carpeta del vídeo pase lo que pase en esos nombres (nada de "../").
function safeJoin(base, ...parts) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, ...parts);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) return null;
  return resolved;
}

function sendPlaylist(res, filePath) {
  res.set('Content-Type', CONTENT_TYPES['.m3u8']);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
}

// Genera (si hace falta) y sirve el manifiesto maestro. Nota: esto espera
// aquí mismo a que ffmpeg termine antes de responder - para un vídeo que
// necesite recodificar puede tardar. La cola/progreso con el mismo patrón
// que ya usa /api/stream/:id/status es el alcance de #61, no de esta issue.
router.get('/hls/:id/master.m3u8', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  try {
    const master = await hls.generateHls(video);
    sendPlaylist(res, master);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sirve el manifiesto de una variante (vídeo o una pista de audio) y sus
// segmentos, ya generados por /master.m3u8. Los segmentos ya generados no
// cambian nunca (VOD): cacheables de forma agresiva e inmutable.
router.get('/hls/:id/:variant/:file', (req, res) => {
  const { id, variant, file } = req.params;
  const ext = path.extname(file);
  if (!CONTENT_TYPES[ext] || (ext === '.ts' && !/^seg_\d+\.ts$/.test(file)) || (ext === '.m3u8' && file !== 'prog.m3u8')) {
    res.status(400).end();
    return;
  }

  const target = safeJoin(hls.outDirFor({ id }), variant, file);
  if (!target || !fs.existsSync(target)) {
    res.status(404).end();
    return;
  }

  if (ext === '.ts') {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Type', CONTENT_TYPES['.ts']);
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).end();
    });
    return;
  }

  sendPlaylist(res, target);
});

module.exports = router;
