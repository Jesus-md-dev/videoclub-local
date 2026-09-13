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

router.get('/stream/:id/status', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }
  const audioIndex = parseAudioIndex(req);
  // 'high': esto lo pide un usuario viendo el reproductor ahora mismo, así
  // que adelanta al precalentamiento en segundo plano en la cola de ffmpeg.
  const status = await transcode.ensureChecked(video, audioIndex, 'high');
  const progress = status === 'processing' ? await transcode.getProgress(video, audioIndex) : null;
  res.json({ status, progress });
});

router.get('/stream/:id', async (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }

  const audioIndex = parseAudioIndex(req);
  const status = await transcode.getStatus(video, audioIndex);

  if (status === 'processing' || status === 'checking' || status === 'unknown') {
    res.status(503).json({ error: 'El vídeo se está preparando', preparing: true });
    return;
  }
  if (status === 'failed') {
    res.status(500).json({ error: 'No se pudo preparar este vídeo para reproducirlo' });
    return;
  }

  if (status === 'ready') {
    const transcodedFile = await transcode.playableFile(video, audioIndex);
    sendFileWithRange(req, res, transcodedFile, 'video/mp4');
    return;
  }

  // status === 'compatible': el original ya es reproducible tal cual.
  const videosPath = getVideosPath();
  const filePath = path.join(videosPath, video.relativePath);
  const resolved = path.resolve(filePath);

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
});

module.exports = router;
