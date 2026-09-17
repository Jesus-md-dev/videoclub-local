const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const hls = require('./hls');
const { getVideosPath } = require('./config');

// Para cada vídeo con el HLS marcado como fallido: si el original ya no
// existe en disco (se borró/movió a mano justo después del fallo) se
// reescanea el catálogo al final para que desaparezca del todo. Si el
// archivo sigue ahí, se reintenta de verdad, por si fue un fallo puntual
// (disco externo con hipos, GPU ocupada...).
//
// Compartido entre el botón manual "Resolver fallidos" (routes/queue.js) y
// el arranque del servidor (server/index.js, UNA SOLA VEZ ahí, nunca en
// bucle): un fallo persistente de verdad (archivo realmente corrupto,
// códec no soportado) no debe reintentarse para siempre en segundo plano
// sin que nadie se entere - este proyecto ya sufrió antes por ffmpeg
// descontrolado (#48/#49/#67). Reintentar una vez por reinicio es un buen
// punto medio: cubre fallos transitorios sin esconder uno persistente.
async function resolveFailed() {
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

  return { retried, missing };
}

module.exports = { resolveFailed };
