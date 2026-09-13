const { getMediaInfo } = require('./mediaInfo');

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

async function getTracks(video) {
  const info = await getMediaInfo(video);
  const audio = info.streams.filter((s) => s.codec_type === 'audio').map(describeTrack);
  const subtitles = info.streams.filter((s) => s.codec_type === 'subtitle').map(describeTrack);
  return { audio, subtitles };
}

module.exports = { getTracks };
