const express = require('express');
const { getVideosPath, setVideosPath } = require('../config');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');
const watcher = require('../watcher');

const router = express.Router();

router.use(express.json());

router.get('/settings', (req, res) => {
  res.json({ videosPath: getVideosPath() });
});

router.post('/settings', async (req, res) => {
  const { videosPath } = req.body;
  if (!videosPath || typeof videosPath !== 'string') {
    res.status(400).json({ error: 'Falta el campo "videosPath"' });
    return;
  }

  try {
    setVideosPath(videosPath);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  try {
    const videos = catalog.scan();
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    watcher.start();
    res.json({ videosPath: getVideosPath(), count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
