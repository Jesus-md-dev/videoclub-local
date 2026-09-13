const express = require('express');
const os = require('os');
const path = require('path');
const { PORT, VIDEOS_PATH } = require('./config');
const catalog = require('./catalog');
const thumbnails = require('./thumbnails');
const videosRouter = require('./routes/videos');
const streamRouter = require('./routes/stream');
const thumbnailRouter = require('./routes/thumbnail');

const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', videosRouter);
app.use('/api', streamRouter);
app.use('/api', thumbnailRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
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

function start() {
  if (!VIDEOS_PATH) {
    console.error('Falta VIDEOS_PATH en .env. Copia .env.example a .env y configúralo.');
    process.exit(1);
  }

  try {
    const videos = catalog.scan();
    console.log(`Catálogo inicial: ${videos.length} vídeo(s) encontrados en ${VIDEOS_PATH}`);
    thumbnails.generateMissingThumbnails(videos);
  } catch (err) {
    console.error(`Error al escanear VIDEOS_PATH: ${err.message}`);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Videoclub local escuchando en el puerto ${PORT}`);
    console.log(`  Local:    http://localhost:${PORT}`);
    for (const ip of localIps()) {
      console.log(`  Red:      http://${ip}:${PORT}`);
    }
  });
}

start();
