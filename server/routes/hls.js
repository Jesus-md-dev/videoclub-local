const express = require('express');
const fs = require('fs');
const path = require('path');
const catalog = require('../catalog');
const hls = require('../hls');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  // fMP4 (ver hls.js): segmentos ".m4s" + un archivo de inicialización
  // ".mp4" por variante (init_<variante>.mp4), en vez de MPEG-TS.
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
};

// Segmentos binarios (no manifiestos): cacheables de forma agresiva e
// inmutable, ya generados y fijos para siempre (VOD).
const SEGMENT_EXTENSIONS = new Set(['.ts', '.m4s', '.mp4']);

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

// Estado de la generación, para pintar "preparando..." en vez de dejar al
// reproductor esperando el manifiesto a ciegas. 'high': quien pregunta
// esto es alguien con el reproductor abierto ahora mismo, así que arrancar
// la generación (si hace falta) adelanta al precalentamiento en segundo
// plano en la cola compartida de ffmpeg.
router.get('/hls/:id/status', (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  const status = hls.ensureGenerating(video, 'high');
  res.json({ status, progress: status === 'processing' ? hls.getProgress(video) : null });
});

// Reintenta un vídeo marcado como 'failed' (botón "Reintentar" en /queue):
// algunos fallos son puntuales (un hipo del disco externo, p.ej.), no
// corrupción real del archivo, y sin esto se quedaban así hasta reiniciar
// el servidor entero.
router.post('/hls/:id/retry', (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  const status = hls.retry(video);
  res.json({ status });
});

// Sirve el manifiesto maestro. Se llama solo cuando /status ya ha dicho
// 'ready' (o se está dispuesto a esperar): si aún no existe, arranca la
// generación y espera aquí mismo a que termine antes de responder.
router.get(
  '/hls/:id/master.m3u8',
  asyncHandler(async (req, res) => {
    const video = catalog.getVideoById(req.params.id);
    if (!video) {
      res.status(404).json({ error: 'Vídeo no encontrado' });
      return;
    }
    const master = await hls.generateHls(video, 'high');
    sendPlaylist(res, master);
  })
);

// Sirve el manifiesto de una variante (vídeo o una pista de audio) y sus
// segmentos, ya generados por /master.m3u8. Los segmentos ya generados no
// cambian nunca (VOD): cacheables de forma agresiva e inmutable.
router.get('/hls/:id/:variant/:file', (req, res) => {
  const { id, variant, file } = req.params;
  const ext = path.extname(file);
  const isKnownSegment =
    (ext === '.ts' && /^seg_\d+\.ts$/.test(file)) ||
    (ext === '.m4s' && /^seg_\d+\.m4s$/.test(file)) ||
    (ext === '.mp4' && /^init_.+\.mp4$/.test(file));
  if (!CONTENT_TYPES[ext] || (SEGMENT_EXTENSIONS.has(ext) && !isKnownSegment) || (ext === '.m3u8' && file !== 'prog.m3u8')) {
    res.status(400).end();
    return;
  }

  const target = safeJoin(hls.outDirFor({ id }), variant, file);
  if (!target || !fs.existsSync(target)) {
    res.status(404).end();
    return;
  }

  if (SEGMENT_EXTENSIONS.has(ext)) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Type', CONTENT_TYPES[ext]);
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).end();
    });
    return;
  }

  sendPlaylist(res, target);
});

module.exports = router;
