const express = require('express');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PORT, HTTPS_PORT, DATA_PATH, TRANSCODED_PATH, HLS_PATH, getVideosPath } = require('./config');
console.log(`Convertidos en: ${TRANSCODED_PATH}${TRANSCODED_PATH.startsWith(DATA_PATH) ? ' (local a este PC)' : ''}`);
console.log(`HLS en: ${HLS_PATH}${HLS_PATH.startsWith(DATA_PATH) ? ' (local a este PC)' : ''}`);

// Aviso in-situ para quien vaya a "liberar espacio" borrando carpetas a
// mano: a diferencia de TRANSCODED_PATH, esta carpeta NO es toda caché
// desechable (ver README.md, "Cuidado al liberar espacio en disco") - ya
// pasó una vez (~180 episodios perdidos sin forma de recuperarlos).
try {
  fs.mkdirSync(HLS_PATH, { recursive: true });
  fs.writeFileSync(
    path.join(HLS_PATH, 'NO_BORRAR_SIN_LEER.txt'),
    'AVISO: esta carpeta no siempre es caché desechable.\n\n' +
      'Para los vídeos que aparecen en data/hls-archived.json, el original ya se\n' +
      'borró automáticamente (porque el HLS aquí era el mismo vídeo, sin\n' +
      'recodificar): la carpeta de ese id dentro de este directorio es la UNICA\n' +
      'copia que queda. Borrarla los pierde para siempre.\n\n' +
      'Los vídeos que SÍ se pueden borrar sin miedo son los que NO aparecen en\n' +
      'data/hls-archived.json: se regeneran solos la próxima vez que se reproduzcan.\n\n' +
      'Ver README.md, sección "Cuidado al liberar espacio en disco".\n'
  );
} catch {
  // No es crítico: si falla (permisos, disco lleno...), no debe impedir arrancar.
}
const backup = require('./backup');
// Antes de que cualquier otro módulo lea sus ficheros de data/ (algunos,
// como la caché de géneros, los cargan en memoria nada más arrancar), se
// recupera lo que falte desde la copia guardada en la carpeta de vídeos.
backup.restoreIfNeeded();
const { getOrCreateCert, CERT_FILE } = require('./https-cert');
const catalog = require('./catalog');
const mediaInfo = require('./mediaInfo');
const thumbnails = require('./thumbnails');
const metadata = require('./metadata');
const hls = require('./hls');
const watcher = require('./watcher');
const videosRouter = require('./routes/videos');
const streamRouter = require('./routes/stream');
const thumbnailRouter = require('./routes/thumbnail');
const settingsRouter = require('./routes/settings');
const browseRouter = require('./routes/browse');
const tracksRouter = require('./routes/tracks');
const trickplayRouter = require('./routes/trickplay');
const profilesRouter = require('./routes/profiles');
const queueRouter = require('./routes/queue');
const metadataRouter = require('./routes/metadata');
const analyticsRouter = require('./routes/analytics');
const hlsRouter = require('./routes/hls');
const purgeRouter = require('./routes/purge');
const normalizeRouter = require('./routes/normalize');
const subdlRouter = require('./routes/subdl');
const healthRouter = require('./routes/health');

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

// Sin caché en el navegador para el frontend: en una app que se
// actualiza a menudo (git pull + reiniciar), un "el botón no hace nada"
// podía ser en realidad el navegador sirviendo JS de una versión
// anterior desde su propia caché, sin que recargar la página (ni F5)
// lo notara siempre. Prioriza tener siempre lo último sin ambigüedad
// por encima del ahorro de ancho de banda, irrelevante en LAN.
app.use(
  express.static(CLIENT_DIST, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);
app.use('/api', videosRouter);
app.use('/api', streamRouter);
app.use('/api', thumbnailRouter);
app.use('/api', settingsRouter);
app.use('/api', browseRouter);
app.use('/api', tracksRouter);
app.use('/api', trickplayRouter);
app.use('/api', profilesRouter);
app.use('/api', queueRouter);
app.use('/api', metadataRouter);
app.use('/api', analyticsRouter);
app.use('/api', hlsRouter);
app.use('/api', purgeRouter);
app.use('/api', normalizeRouter);
app.use('/api', subdlRouter);
app.use('/api', healthRouter);

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

async function scanIfConfigured() {
  const videosPath = getVideosPath();
  if (!videosPath) {
    console.warn('No hay carpeta de vídeos configurada todavía. Ajústala en /config');
    return;
  }
  try {
    const videos = await catalog.scan();
    console.log(`Catálogo: ${videos.length} vídeo(s) encontrados en ${videosPath}`);
    mediaInfo.pruneStore(videos.map((v) => v.id));
    thumbnails.generateMissingThumbnails(videos);
    // Precalienta la caché de géneros en segundo plano (puede tardar si hay
    // muchas series/películas); el catálogo funciona igual mientras tanto.
    metadata.warmAll(catalog.getAllGroupKeys());
    // Precalienta HLS en segundo plano (prioridad baja: quien le da a play
    // ahora mismo sigue adelantando en la cola, ver #61/ffmpeg-limiter.js).
    // El pipeline antiguo de transcode.js ya no se usa para esto.
    hls.warmAll(videos);
    watcher.start();
  } catch (err) {
    console.error(`Error al escanear la carpeta de vídeos: ${err.message}`);
  }
}

// Copia de seguridad periódica (por si algo se escribe sin pasar por una
// ruta que ya la programa) y al cerrar el servidor, para no perder los
// últimos cambios (progreso de vídeo, etc.) si se apaga el PC.
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
function scheduleShutdownBackup() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      backup.backupNow();
      process.exit(0);
    });
  }
}

async function start() {
  await scanIfConfigured();
  backup.backupNow();
  setInterval(backup.backupNow, BACKUP_INTERVAL_MS).unref();
  scheduleShutdownBackup();

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
