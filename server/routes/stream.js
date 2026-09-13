const express = require('express');
const fs = require('fs');
const path = require('path');
const catalog = require('../catalog');
const { getVideosPath } = require('../config');

const router = express.Router();

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

router.get('/stream/:id', (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).json({ error: 'Vídeo no encontrado' });
    return;
  }

  const videosPath = getVideosPath();
  const filePath = path.join(videosPath, video.relativePath);
  const resolved = path.resolve(filePath);

  // El id proviene del catálogo ya escaneado dentro de la carpeta configurada,
  // pero se valida igualmente que la ruta resuelta no se haya salido de ella.
  if (!resolved.startsWith(path.resolve(videosPath))) {
    res.status(400).json({ error: 'Ruta inválida' });
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    res.status(404).json({ error: 'Archivo no encontrado en disco' });
    return;
  }

  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(resolved).pipe(res);
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

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': contentType,
  });
  fs.createReadStream(resolved, { start, end }).pipe(res);
});

module.exports = router;
