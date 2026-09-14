const express = require('express');
const { getVideosPath, setVideosPath } = require('../config');
const catalog = require('../catalog');
const mediaInfo = require('../mediaInfo');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');
const transcode = require('../transcode');
const watcher = require('../watcher');
const backup = require('../backup');

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
    backup.backupNow();
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  try {
    const videos = catalog.scan();
    mediaInfo.pruneStore(videos.map((v) => v.id));
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    transcode.warmAll(videos);
    watcher.start();
    res.json({ videosPath: getVideosPath(), count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
