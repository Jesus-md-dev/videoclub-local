const express = require('express');
const os = require('os');
const path = require('path');
const { PORT, getVideosPath } = require('./config');
const catalog = require('./catalog');
const thumbnails = require('./thumbnails');
const metadata = require('./metadata');
const transcode = require('./transcode');
const watcher = require('./watcher');
const videosRouter = require('./routes/videos');
const streamRouter = require('./routes/stream');
const thumbnailRouter = require('./routes/thumbnail');
const settingsRouter = require('./routes/settings');
const browseRouter = require('./routes/browse');
const tracksRouter = require('./routes/tracks');
const trickplayRouter = require('./routes/trickplay');

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

const app = express();

app.use(express.static(CLIENT_DIST));
app.use('/api', videosRouter);
app.use('/api', streamRouter);
app.use('/api', thumbnailRouter);
app.use('/api', settingsRouter);
app.use('/api', browseRouter);
app.use('/api', tracksRouter);
app.use('/api', trickplayRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Fallback para las rutas de React Router (recarga directa de /watch/:id, /config, ...).
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});

function localIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function scanIfConfigured() {
  const videosPath = getVideosPath();
  if (!videosPath) {
    console.warn('No hay carpeta de vídeos configurada todavía. Ajústala en /config');
    return;
  }
  try {
    const videos = catalog.scan();
    console.log(`Catálogo: ${videos.length} vídeo(s) encontrados en ${videosPath}`);
    thumbnails.generateMissingThumbnails(videos);
    // Precalienta la caché de géneros en segundo plano (puede tardar si hay
    // muchas series/películas); el catálogo funciona igual mientras tanto.
    metadata.warmAll(catalog.getAllGroupKeys());
    // Convierte en segundo plano (uno a uno) los vídeos que lo necesiten,
    // para que al reproducirlos ya estén listos en vez de esperar entonces.
    transcode.warmAll(videos);
    watcher.start();
  } catch (err) {
    console.error(`Error al escanear la carpeta de vídeos: ${err.message}`);
  }
}

function start() {
  scanIfConfigured();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Videoclub local escuchando en el puerto ${PORT}`);
    console.log(`  Local:    http://localhost:${PORT}`);
    for (const ip of localIps()) {
      console.log(`  Red:      http://${ip}:${PORT}`);
    }
  });
}

start();
