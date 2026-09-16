const fs = require('fs');
const path = require('path');
const express = require('express');
const catalog = require('../catalog');
const hls = require('../hls');
const { MAX_CONCURRENT_FFMPEG } = require('../ffmpeg-limiter');
const { getVideosPath } = require('../config');

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
  // Los vídeos "perdidos" (isLost: ni original ni HLS, ver hls.js) ya no
  // están en catalog.getCatalog() (catalog.js los excluye a propósito desde
  // que dejaron de mostrarse en la web, a petición del usuario) - el
  // recuento sale de catalog.getLostCount() (calculado en vivo en el último
  // escaneo), no de lostVideos.js: ese registro solo crece con el tiempo y
  // puede acumular entradas obsoletas (p.ej. de un id de antes de un
  // renombrado), no refleja cuántos hay perdidos AHORA MISMO. Siguen
  // apuntados para siempre en "Volver a descargar" (lostVideos.js) para no
  // olvidar volver a descargarlos, eso no cambia.
  const summary = {
    total: videos.length,
    ready: 0,
    processing: 0,
    failed: 0,
    pending: 0,
    lost: catalog.getLostCount(),
  };
  const processing = [];
  const failed = [];
  const pending = [];

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
      pending.push({ id: video.id, title: video.title, size: video.size });
    }
  }

  // Los que sí se conoce que están en marcha (con progreso o ya iniciados)
  // antes que los recién marcados "checking", para que lo más relevante
  // salga arriba en una lista que puede tener varios a la vez.
  processing.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  // El precalentamiento en segundo plano procesa los archivos más ligeros
  // primero (ver comentario en hls.js): el mismo orden aquí para que la
  // lista refleje de verdad quién va a tocarle turno antes.
  pending.sort((a, b) => (a.size || 0) - (b.size || 0));

  res.json({
    summary,
    processing,
    failed: failed.slice(0, 200),
    pending: pending.slice(0, 200),
    maxConcurrentFfmpeg: MAX_CONCURRENT_FFMPEG,
  });
});

// Botón "Resolver fallidos" de /queue: para cada vídeo marcado 'failed'
// (los "perdidos" ya no pasan por aquí en absoluto - ni siquiera están en
// catalog.getCatalog(), ver catalog.js), si el original ya no existe en
// disco (se borró/movió a mano justo después del fallo) se reescanea el
// catálogo al final para que desaparezca del todo. Si el archivo sigue ahí,
// se reintenta de verdad (mismo mecanismo que el botón "Reintentar" de cada
// fila), por si fue un fallo puntual (disco externo con hipos, GPU
// ocupada...).
router.post('/queue/resolve-failed', async (req, res) => {
  const videosPath = getVideosPath();
  const videos = catalog.getCatalog();
  let retried = 0;
  let missing = 0;

  for (const video of videos) {
    if (hls.getStatus(video) !== 'failed') continue;
    const exists = videosPath && fs.existsSync(path.join(videosPath, video.relativePath));
    if (exists) {
      hls.retry(video);
      retried += 1;
    } else {
      missing += 1;
    }
  }

  if (missing > 0) await catalog.scan();

  res.json({ retried, missing });
});

module.exports = router;
