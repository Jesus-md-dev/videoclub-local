const express = require('express');
const { getVideosPath, setVideosPath } = require('../config');
const catalog = require('../catalog');
const mediaInfo = require('../mediaInfo');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');
const hls = require('../hls');
const watcher = require('../watcher');
const backup = require('../backup');
const asyncHandler = require('../asyncHandler');

const router = express.Router();

router.get('/settings', (req, res) => {
  res.json({ videosPath: getVideosPath() });
});

router.post(
  '/settings',
  asyncHandler(async (req, res) => {
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
    backup.backupNow();

    const videos = await catalog.scan();
    mediaInfo.pruneStore(videos.map((v) => v.id));
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    hls.warmAll(videos);
    watcher.start();
    res.json({ videosPath: getVideosPath(), count: videos.length });
  })
);

module.exports = router;
