const express = require('express');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');

const router = express.Router();

function toPublicVideo(video) {
  return {
    id: video.id,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    hasThumbnail: thumbnails.hasThumbnail(video.id),
    seriesKey: catalog.getShowKeyFor(video),
  };
}

router.get('/videos', (req, res) => {
  const videos = catalog.getCatalog().map(toPublicVideo);
  res.json(videos);
});

router.get('/videos/browse', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const { parent, folders, videos } = catalog.listDir(dir);

  // Géneros ya cacheados (si los hay); nunca bloquea esperando a fuentes
  // externas, así el catálogo carga al instante aunque haya miles de vídeos.
  res.json({
    dir,
    parent,
    folders: folders.map((folder) => ({ ...folder, genres: metadata.getCached(folder.name).genres })),
    videos: videos.map((video) => ({
      ...toPublicVideo(video),
      genres: metadata.getCached(catalog.metadataKeyFor(video)).genres,
    })),
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
    res.json({ count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
