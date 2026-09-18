// Conversión de subtítulos que llegan de fuera (descargados de SubDL,
// importados a mano o detectados junto al vídeo) al formato que sirve el
// reproductor (WebVTT) - compartido por subdl.js y localSubtitles.js.

// Muchos .srt antiguos (sobre todo en español) no están en UTF-8 sino en
// Windows-1252/ISO-8859-1 - decodificarlos como UTF-8 sin más deja tildes y
// "ñ" como el carácter de reemplazo "�". Se decodifica primero como UTF-8
// y, si aparece ese carácter (señal de que no lo era), se decodifica de
// nuevo como latin1 (mismo rango de acentuadas que Windows-1252 en la
// práctica para subtítulos).
function decodeSubtitleBuffer(buf) {
  const utf8 = buf.toString('utf-8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

function srtToVtt(raw) {
  if (/^\uFEFF?WEBVTT/i.test(raw.trim())) return raw;
  return `WEBVTT\n\n${raw.replace(/\r+/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`;
}

const SUPPORTED_EXTENSIONS = new Set(['.srt', '.vtt']);

// Decodifica y convierte a WebVTT el contenido de un .srt/.vtt según su
// extensión. Lanza si la extensión no está soportada (de momento solo
// .srt/.vtt - .ass/.ssa necesitarían parsear su propio formato de estilos,
// no solo las marcas de tiempo).
function toVtt(ext, buffer) {
  const lower = ext.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(lower)) {
    throw new Error(`Formato "${ext}" no soportado (de momento solo .srt y .vtt).`);
  }
  const raw = decodeSubtitleBuffer(buffer);
  return lower === '.vtt' ? srtToVtt(raw) : srtToVtt(raw);
}

module.exports = { decodeSubtitleBuffer, srtToVtt, toVtt, SUPPORTED_EXTENSIONS };
