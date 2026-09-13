const express = require('express');
const catalog = require('../catalog');
const transcode = require('../transcode');

const router = express.Router();

// Para una clave de transcode.js (video.id, video.id#aN, o
// video.id__rawaudio_aN) recupera el vídeo original del catálogo.
function videoForKey(key) {
  const id = key.split('#')[0].split('__')[0];
  return catalog.getVideoById(id);
}

router.get('/queue', (req, res) => {
  const videos = catalog.getCatalog();
  const summary = { total: videos.length, ready: 0, compatible: 0, active: 0, queued: 0, failed: 0, unknown: 0 };
  for (const video of videos) {
    const procState = transcode.peekProcessingState(video);
    if (procState === 'active') {
      summary.active += 1;
      continue;
    }
    if (procState === 'queued') {
      summary.queued += 1;
      continue;
    }
    const st = transcode.peekStatus(video);
    if (st === 'ready' || st === 'compatible' || st === 'failed') summary[st] += 1;
    else summary.unknown += 1;
  }

  const { active, queued } = transcode.getQueueSnapshot();
  const failed = transcode
    .getFailedKeys()
    .map((key) => {
      const video = videoForKey(key);
      return video ? { key, id: video.id, title: video.title, size: video.size } : { key, title: key };
    })
    .slice(0, 200);

  res.json({ summary, active, queued, failed, maxConcurrent: transcode.MAX_CONCURRENT_JOBS });
});

module.exports = router;
