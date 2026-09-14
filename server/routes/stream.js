const express = require('express');
const fs = require('fs');
const path = require('path');
const catalog = require('../catalog');
const { getVideosPath } = require('../config');
const transcode = require('../transcode');

const router = express.Router();

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

function parseAudioIndex(req) {
  return req.query.audio != null ? Number(req.query.audio) : null;
}

// Conecta el stream de lectura a la respuesta, cerrando limpiamente en
// cualquier caso anómalo (error de disco, cliente que corta la conexión al
// buscar en la barra de progreso, ...) en vez de dejar la petición colgada
// esperando datos que nunca van a llegar (lo que obliga a recargar).
function pipeWithCleanup(req, res, readStream) {
  readStream.on('error', (err) => {
    console.warn(`Error leyendo el vídeo: ${err.message}`);
    readStream.destroy();
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });

  req.on('close', () => {
    readStream.destroy();
  });

  readStream.pipe(res);
}

function sendFileWithRange(req, res, filePath, contentType) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.status(404).json({ error: 'Archivo no encontrado en disco' });
    return;
  }
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    pipeWithCleanup(req, res, fs.createReadStream(filePath));
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) {
    res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });
  pipeWithCleanup(req, res, fs.createReadStream(filePath, { start, end }));
}

// Sirve el archivo tal cual está en disco, sin pasar por transcode.js. Solo
// para el modo "reproducir sin convertir": el usuario asume que puede no
// funcionar en su dispositivo/navegador concreto.
function serveOriginal(req, res, video) {
  const videosPath = getVideosPath();
  const resolved = path.resolve(path.join(videosPath, video.relativePath));

  // El id proviene del catálogo ya escaneado dentro de la carpeta configurada,
  // pero se valida igualmente que la ruta resuelta no se haya salido de ella.
  if (!resolved.startsWith(path.resolve(videosPath))) {
    res.status(400).json({ error: 'Ruta inválida' });
    return;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Archivo no encontrado en disco' });
    return;
  }
  const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  sendFileWithRange(req, res, resolved, contentType);
}

// Solo para el modo "Reproducir sin convertir" (#62): el reproductor
// normal usa HLS (/api/hls/:id/status, server/hls.js). El pipeline antiguo
// de comprobación/conversión completa (transcode.ensureChecked/getStatus/
// playableFile/forcePriorityFor) ya no lo llama nada, así que se ha
// quitado de aquí junto con la ruta /priority que lo controlaba.
router.get('/stream/:id/status', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  const audioIndex = parseAudioIndex(req);

  // El archivo original se sirve tal cual (pista de audio por defecto).
  // Si se pide un idioma distinto, la mayoría de navegadores no permiten
  // elegir entre las demás pistas embebidas de un vídeo servido así, así
  // que se prepara un remux rápido (solo copia, sin recodificar) con
  // únicamente esa pista de audio.
  const remux = await transcode.ensureRawAudio(video, audioIndex);
  if (remux === 'original' || remux === 'ready') {
    res.json({ status: 'compatible', progress: null });
    return;
  }
  if (remux === 'failed') {
    res.json({ status: 'failed', progress: null });
    return;
  }
  res.json({ status: 'processing', progress: transcode.rawAudioProgress(video, audioIndex) });
});

router.get('/stream/:id', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }

  const audioIndex = parseAudioIndex(req);

  const remux = await transcode.ensureRawAudio(video, audioIndex);
  if (remux === 'ready') {
    const file = transcode.rawAudioFile(video, audioIndex);
    const contentType = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    sendFileWithRange(req, res, file, contentType);
    return;
  }
  if (remux === 'processing' || remux === 'checking') {
    res.status(503).json({ error: 'Cambiando de idioma, un momento', preparing: true });
    return;
  }
  // 'original' (mismo idioma que el de por defecto) o 'failed' (el remux
  // ha fallado): se sirve el archivo tal cual, con su audio por defecto.
  serveOriginal(req, res, video);
});

module.exports = router;
