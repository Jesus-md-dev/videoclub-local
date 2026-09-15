const fs = require('fs');
const path = require('path');
const { getMediaInfo } = require('./mediaInfo');
const { HLS_PATH } = require('./config');

const LANGUAGE_NAMES = {
  spa: 'Español',
  eng: 'Inglés',
  jpn: 'Japonés',
  fre: 'Francés',
  fra: 'Francés',
  ger: 'Alemán',
  deu: 'Alemán',
  ita: 'Italiano',
  por: 'Portugués',
  und: 'Desconocido',
};

function describeTrack(stream) {
  const lang = stream.tags?.language || null;
  return {
    index: stream.index,
    codec: stream.codec_name,
    language: lang,
    languageLabel: lang ? LANGUAGE_NAMES[lang] || lang : null,
    title: stream.tags?.title || null,
    default: stream.disposition?.default === 1,
  };
}

// Analiza los atributos CLAVE=valor (o CLAVE="valor, con comas") de una
// línea #EXT-X-MEDIA del manifiesto HLS.
function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m = re.exec(line);
  while (m) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    m = re.exec(line);
  }
  return attrs;
}

// Reconstruye la lista de pistas de audio a partir del propio master.m3u8
// ya generado, para cuando no se puede volver a analizar el archivo
// original con ffprobe (típicamente un vídeo archivado: ver hls.js -
// su original se borró tras generar el HLS, así que un fallo de ffprobe
// ahí es definitivo, no algo que reintentar). El manifiesto ya lleva el
// idioma de cada pista (hls.js lo escribe al generarlo), así que basta con
// leerlo de vuelta.
function readAudioTracksFromMaster(video) {
  const masterFile = path.join(HLS_PATH, video.id, 'master.m3u8');
  let content;
  try {
    content = fs.readFileSync(masterFile, 'utf-8');
  } catch {
    return [];
  }
  const audio = [];
  let index = 0;
  for (const line of content.split('\n')) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !line.includes('TYPE=AUDIO')) continue;
    const attrs = parseAttributes(line);
    const lang = attrs.LANGUAGE || null;
    audio.push({
      index,
      codec: null,
      language: lang,
      languageLabel: lang ? LANGUAGE_NAMES[lang] || lang : null,
      title: attrs.NAME || null,
      default: attrs.DEFAULT === 'YES',
    });
    index += 1;
  }
  return audio;
}

async function getTracks(video) {
  try {
    const info = await getMediaInfo(video);
    const audio = info.streams.filter((s) => s.codec_type === 'audio').map(describeTrack);
    const subtitles = info.streams.filter((s) => s.codec_type === 'subtitle').map(describeTrack);
    return { audio, subtitles };
  } catch (err) {
    // Los subtítulos (si los había) ya se habrían extraído aparte al
    // archivar (ver subtitles.js) - aquí solo se puede recuperar el audio,
    // que sí queda descrito en el manifiesto.
    const audio = readAudioTracksFromMaster(video);
    if (audio.length === 0) throw err;
    return { audio, subtitles: [] };
  }
}

module.exports = { getTracks };
