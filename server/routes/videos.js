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
  };
}

router.get('/videos', (req, res) => {
  const videos = catalog.getCatalog().map(toPublicVideo);
  res.json(videos);
});

router.get('/videos/browse', async (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const { parent, folders, videos } = catalog.listDir(dir);

  // Metadatos (géneros) por carpeta: una consulta por serie/película, no por episodio.
  const folderGenres = await Promise.all(
    folders.map((folder) => metadata.getMetadata(folder.name, true))
  );
  const videoGenres = await Promise.all(
    videos.map((video) => {
      const { key, isSeries } = catalog.metadataKeyFor(video);
      return metadata.getMetadata(key, isSeries);
    })
  );

  res.json({
    dir,
    parent,
    folders: folders.map((folder, i) => ({ ...folder, genres: folderGenres[i].genres })),
    videos: videos.map((video, i) => ({ ...toPublicVideo(video), genres: videoGenres[i].genres })),
  });
});

router.get('/genres', (req, res) => {
  res.json(metadata.allGenres());
});

router.post('/scan', async (req, res) => {
  try {
    const videos = catalog.scan();
    // Generar carátulas en segundo plano, sin bloquear la respuesta.
    thumbnails.generateMissingThumbnails(videos);
    res.json({ count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
