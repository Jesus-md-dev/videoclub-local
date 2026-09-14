const express = require('express');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');
const transcode = require('../transcode');
const hls = require('../hls');
const profiles = require('../profiles');

const router = express.Router();

// El "type" que devuelven las fuentes (tv/anime/movie) es poco fiable para
// distinguir anime: TVmaze indexa muchos animes como series de TV normales
// y solo a veces los etiqueta también con el género "Anime". Se usa esa
// etiqueta de género (más consistente) como señal real.
function resolveType(meta) {
  if (meta.type === 'anime' || meta.genres?.includes('Anime')) return 'anime';
  return meta.type;
}

function toPublicVideo(video) {
  return {
    id: video.id,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    hasThumbnail: thumbnails.hasThumbnail(video.id),
    seriesKey: catalog.getShowKeyFor(video),
    // 'active': convirtiéndose ahora mismo. 'queued': ya se sabe que hace
    // falta convertirlo, pero espera su turno (solo hay una conversión a la
    // vez). null: no hace falta, o aún no se ha comprobado.
    processingState: transcode.peekProcessingState(video),
    processingPercent: transcode.peekProgressPercent(video),
  };
}

// Para una carpeta de serie: si algún episodio se está convirtiendo ahora
// mismo eso manda (con su porcentaje real); si no, pero alguno está en
// cola, se marca como en cola.
function folderProcessingState(videosInFolder) {
  let queued = false;
  for (const v of videosInFolder) {
    const state = transcode.peekProcessingState(v);
    if (state === 'active') return { processingState: 'active', processingPercent: transcode.peekProgressPercent(v) };
    if (state === 'queued') queued = true;
  }
  return { processingState: queued ? 'queued' : null, processingPercent: null };
}

router.get('/videos', (req, res) => {
  const videos = catalog.getCatalog().map(toPublicVideo);
  res.json(videos);
});

// Fracción (0-1) de episodios ya vistos (>=95%) de una carpeta de serie,
// para pintar una barra de progreso de la serie completa en su carátula
// (no solo del episodio suelto, como "Continuar viendo"). null si no hay
// perfil activo o la carpeta no tiene vídeos.
function seriesProgressFor(videosInFolder, profileProgress) {
  if (!profileProgress || videosInFolder.length === 0) return null;
  const watched = videosInFolder.filter((v) => (profileProgress[v.id]?.ratio || 0) >= 0.95).length;
  return { ratio: watched / videosInFolder.length, watched, total: videosInFolder.length };
}

router.get('/videos/browse', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const { parent, folders, videos } = catalog.listDir(dir);
  const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : null;
  const profileProgress = profileId && profiles.profileExists(profileId) ? profiles.getProgress(profileId) : null;

  // Metadatos ya cacheados (si los hay); nunca bloquea esperando a fuentes
  // externas, así el catálogo carga al instante aunque haya miles de vídeos.
  res.json({
    dir,
    parent,
    folders: folders.map((folder) => {
      const meta = metadata.getCached(folder.name);
      const folderVideos = catalog.listDir(folder.path).videos;
      const { processingState, processingPercent } = folderProcessingState(folderVideos);
      return {
        ...folder,
        genres: meta.genres,
        cleanName: meta.cleanName,
        poster: meta.poster,
        type: resolveType(meta),
        processingState,
        processingPercent,
        seriesProgress: seriesProgressFor(folderVideos, profileProgress),
      };
    }),
    videos: videos.map((video) => {
      const meta = metadata.getCached(catalog.metadataKeyFor(video));
      return {
        ...toPublicVideo(video),
        genres: meta.genres,
        cleanName: meta.cleanName,
        poster: meta.poster,
        type: resolveType(meta),
      };
    }),
  });
});

router.get('/genres', (req, res) => {
  res.json(metadata.allGenres());
});

router.post('/scan', async (req, res) => {
  try {
    const videos = catalog.scan();
    // Generar carátulas, precalentar géneros y HLS en segundo plano, sin bloquear la respuesta.
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    hls.warmAll(videos);
    res.json({ count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
