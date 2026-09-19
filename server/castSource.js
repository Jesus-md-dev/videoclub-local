const { localIp } = require('./localIp');
const { PORT } = require('./config');

// URL de origen que se le pasa a un dispositivo DLNA (server/dlna.js): en
// HTTP (no HTTPS, un reproductor DLNA no acepta nuestro certificado
// autofirmado), y siempre el remux en directo del HLS ya generado (ver
// dlna.js:remuxStream) - ningún reproductor DLNA entiende manifiestos HLS
// directamente. Antes había una segunda vía sirviendo el archivo original
// tal cual (más rápida, sin remuxear) para vídeos con original todavía en
// disco, pero dependía de /api/stream/:id ("Reproducir sin convertir"),
// eliminado del todo a petición del usuario - ahora todo pasa por aquí,
// tenga o no original el vídeo.
function buildSource(video) {
  const ip = localIp();
  return { url: `http://${ip}:${PORT}/api/dlna/remux/${video.id}`, type: 'video/mp4' };
}

module.exports = { buildSource };
