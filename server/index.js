const express = require('express');
const https = require('https');
const os = require('os');
const path = require('path');
const { PORT, HTTPS_PORT, getVideosPath } = require('./config');
const { getOrCreateCert, CERT_FILE } = require('./https-cert');
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
const profilesRouter = require('./routes/profiles');

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

// Red de seguridad: un archivo corrupto (ffprobe fallando) u otro error
// inesperado en tareas de fondo (precalentamiento, watcher...) no debe poder
// tumbar todo el servidor. Node mata el proceso por defecto ante una
// promesa rechazada sin capturar; aquí solo se registra y se sigue.
process.on('unhandledRejection', (err) => {
  console.error(`Error no capturado (la app sigue en marcha): ${err?.message || err}`);
});
process.on('uncaughtException', (err) => {
  console.error(`Excepción no capturada (la app sigue en marcha): ${err?.message || err}`);
});

const app = express();

app.use(express.static(CLIENT_DIST));
app.use('/api', videosRouter);
app.use('/api', streamRouter);
app.use('/api', thumbnailRouter);
app.use('/api', settingsRouter);
app.use('/api', browseRouter);
app.use('/api', tracksRouter);
app.use('/api', trickplayRouter);
app.use('/api', profilesRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Descarga del certificado autofirmado, para instalarlo como "de confianza"
// en un dispositivo y que deje de avisar de conexión no privada al usar
// HTTPS. Servido también por HTTP a propósito: hace falta poder bajarlo
// antes de que el dispositivo confíe todavía en el HTTPS de este servidor.
app.get('/cert', (req, res) => {
  res.download(CERT_FILE, 'videoclub-local.crt', {
    headers: { 'Content-Type': 'application/x-x509-ca-cert' },
  });
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

async function start() {
  scanIfConfigured();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Videoclub local escuchando en el puerto ${PORT}`);
    console.log(`  Local:    http://localhost:${PORT}`);
    for (const ip of localIps()) {
      console.log(`  Red:      http://${ip}:${PORT}`);
    }
  });

  try {
    const cert = await getOrCreateCert();
    https.createServer(cert, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`También disponible por HTTPS en el puerto ${HTTPS_PORT} (certificado autofirmado):`);
      console.log(`  Local:    https://localhost:${HTTPS_PORT}`);
      for (const ip of localIps()) {
        console.log(`  Red:      https://${ip}:${HTTPS_PORT}`);
      }
      console.log('  El navegador avisará de que el certificado no es de confianza (es autofirmado, sin dominio real): hay que aceptarlo manualmente la primera vez en cada dispositivo.');
    });
  } catch (err) {
    console.warn(`No se pudo iniciar HTTPS (se sigue sirviendo por HTTP): ${err.message}`);
  }
}

start();
