const path = require('path');
const { localIp } = require('./localIp');
const { PORT } = require('./config');

// Mismo mapa que server/routes/stream.js: hay que declarar el tipo MIME real
// del archivo (no asumir "video/mp4" siempre) - un dispositivo DLNA puede
// rechazar la reproducción si el contenido declarado no coincide con lo que
// de verdad recibe (visto en directo: un .mkv anunciado como video/mp4
// provocaba un rechazo inmediato del receptor DLNA de Windows). Chromecast
// (server/chromecast.js) reutiliza exactamente la misma lógica: el origen
// que necesita (URL http + tipo MIME real) es idéntico en los dos casos.
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

// URL de origen que se le pasa al dispositivo (DLNA o Chromecast): en HTTP
// (no HTTPS, ninguno de los dos acepta nuestro certificado autofirmado). Un
// vídeo con su original todavía en disco reutiliza /api/stream/:id tal cual
// (Range completo, ya soporta elegir pista de audio); uno archivado (sin
// original, solo quedan los segmentos de HLS) usa el remux en directo (ver
// dlna.js:remuxStream, reutilizado también por chromecast.js).
function buildSource(video, audioIndex) {
  const ip = localIp();
  const base = `http://${ip}:${PORT}`;
  if (video.archived) {
    return { url: `${base}/api/dlna/remux/${video.id}`, type: 'video/mp4' };
  }
  const query = audioIndex != null ? `?audio=${audioIndex}` : '';
  const type = MIME_TYPES[path.extname(video.relativePath).toLowerCase()] || 'video/mp4';
  return { url: `${base}/api/stream/${video.id}${query}`, type };
}

module.exports = { buildSource };
