const express = require('express');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');
const transcode = require('../transcode');

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
    processing: transcode.peekStatus(video) === 'processing',
  };
}

router.get('/videos', (req, res) => {
  const videos = catalog.getCatalog().map(toPublicVideo);
  res.json(videos);
});

router.get('/videos/browse', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const { parent, folders, videos } = catalog.listDir(dir);

  // Metadatos ya cacheados (si los hay); nunca bloquea esperando a fuentes
  // externas, así el catálogo carga al instante aunque haya miles de vídeos.
  res.json({
    dir,
    parent,
    folders: folders.map((folder) => {
      const meta = metadata.getCached(folder.name);
      const processing = catalog
        .listDir(folder.path)
        .videos.some((v) => transcode.peekStatus(v) === 'processing');
      return {
        ...folder,
        genres: meta.genres,
        cleanName: meta.cleanName,
        poster: meta.poster,
        type: resolveType(meta),
        processing,
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
    // Generar carátulas y precalentar géneros en segundo plano, sin bloquear la respuesta.
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    transcode.warmAll(videos);
    res.json({ count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
