const express = require('express');
const catalog = require('../catalog');
const hls = require('../hls');
const { MAX_CONCURRENT_FFMPEG } = require('../ffmpeg-limiter');

const router = express.Router();

// Antes esto reflejaba el pipeline antiguo (transcode.js), con su propia
// cola visible de "activo ahora" vs "en cola, en tal posición". HLS
// comparte la cola global de ffmpeg (ffmpeg-limiter.js) con carátulas y
// trickplay, que no distingue "encolado, esperando hueco" de "activo ahora
// mismo" por trabajo concreto - así que aquí solo se puede mostrar
// "procesando" en conjunto (con su % cuando se conoce) y cuántos quedan
// por empezar, no una posición exacta en la cola.
router.get('/queue', (req, res) => {
  const videos = catalog.getCatalog();
  const summary = { total: videos.length, ready: 0, processing: 0, failed: 0, pending: 0 };
  const processing = [];
  const failed = [];

  for (const video of videos) {
    const status = hls.getStatus(video);
    if (status === 'ready') {
      summary.ready += 1;
    } else if (status === 'processing' || status === 'checking') {
      summary.processing += 1;
      const progress = hls.getProgress(video);
      processing.push({
        id: video.id,
        title: video.title,
        size: video.size,
        percent: progress?.percent ?? null,
        elapsedMs: progress?.elapsedMs ?? null,
      });
    } else if (status === 'failed') {
      summary.failed += 1;
      failed.push({ id: video.id, title: video.title, size: video.size, error: hls.getLastError(video) });
    } else {
      summary.pending += 1;
    }
  }

  // Los que sí se conoce que están en marcha (con progreso o ya iniciados)
  // antes que los recién marcados "checking", para que lo más relevante
  // salga arriba en una lista que puede tener varios a la vez.
  processing.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));

  res.json({ summary, processing, failed: failed.slice(0, 200), maxConcurrentFfmpeg: MAX_CONCURRENT_FFMPEG });
});

module.exports = router;
