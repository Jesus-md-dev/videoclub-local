const fs = require('fs');
const path = require('path');
const { getMediaInfo } = require('./mediaInfo');
const { HLS_PATH, DATA_PATH } = require('./config');
const subdl = require('./subdl');

const SUBTITLES_DIR = path.join(DATA_PATH, 'subtitles');

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

// Sin el ffprobe original no se sabe el idioma de un subtítulo ya
// extraído (eso solo lo tenía el análisis perdido), pero sí que existe:
// se listan los "<id>-<índice>.vtt" ya generados (ver subtitles.js, que
// los extrae ANTES de archivar el vídeo) con una etiqueta genérica, mejor
// que no ofrecerlos en absoluto. Se excluyen los "ext<hash>" (subtítulos
// descargados de SubDL, ver subdl.js): esos ya los añade listDownloaded
// con su idioma/nombre de verdad, no hace falta adivinarlos aquí también.
function readSubtitlesFromDisk(video) {
  let files;
  try {
    files = fs.readdirSync(SUBTITLES_DIR);
  } catch {
    return [];
  }
  const prefix = `${video.id}-`;
  return files
    .filter(
      (f) => f.startsWith(prefix) && f.endsWith('.vtt') && !f.startsWith(`${prefix}ext`) && !f.startsWith(`${prefix}os`)
    )
    .map((f, i) => ({
      index: f.slice(prefix.length, -4),
      codec: 'vtt',
      language: null,
      languageLabel: null,
      title: `Subtítulo ${i + 1}`,
      default: false,
    }));
}

async function getTracks(video) {
  const downloaded = subdl.listDownloaded(video.id);
  try {
    const info = await getMediaInfo(video);
    const audio = info.streams.filter((s) => s.codec_type === 'audio').map(describeTrack);
    const subtitles = info.streams.filter((s) => s.codec_type === 'subtitle').map(describeTrack);
    return { audio, subtitles: [...subtitles, ...downloaded] };
  } catch (err) {
    const audio = readAudioTracksFromMaster(video);
    const subtitles = [...readSubtitlesFromDisk(video), ...downloaded];
    if (audio.length === 0 && subtitles.length === 0) throw err;
    return { audio, subtitles };
  }
}

module.exports = { getTracks };
