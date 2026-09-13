const express = require('express');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');

const router = express.Router();

router.get('/thumbnail/:id', (req, res) => {
  const video = catalog.getVideoById(req.params.id);
  if (!video) {
    res.status(404).end();
    return;
  }

  if (thumbnails.hasThumbnail(video.id)) {
    res.sendFile(thumbnails.thumbnailFile(video.id));
    return;
  }

  res.redirect('/placeholder.svg');
});

module.exports = router;
