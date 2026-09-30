const express = require('express');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PORT, HTTPS_PORT, DATA_PATH, HLS_PATH, getVideosPath } = require('./config');
console.log(`HLS en: ${HLS_PATH}${HLS_PATH.startsWith(DATA_PATH) ? ' (local a este PC)' : ''}`);

// Aviso in-situ para quien vaya a "liberar espacio" borrando carpetas a
// mano: esta carpeta NO es toda caché desechable (ver README.md, "Cuidado
// al liberar espacio en disco") - ya pasó una vez (~180 episodios perdidos
// sin forma de recuperarlos).
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
const moveOriginal = require('./moveOriginal');
const upscale = require('./upscale');
const normalize = require('./normalize');
const localSubtitles = require('./localSubtitles');
const { resolveFailed } = require('./resolveFailed');
const watcher = require('./watcher');
const videosRouter = require('./routes/videos');
const thumbnailRouter = require('./routes/thumbnail');
const settingsRouter = require('./routes/settings');
const browseRouter = require('./routes/browse');
const tracksRouter = require('./routes/tracks');
const trickplayRouter = require('./routes/trickplay');
const profilesRouter = require('./routes/profiles');
const queueRouter = require('./routes/queue');
const moveQueueRouter = require('./routes/moveQueue');
const upscaleQueueRouter = require('./routes/upscaleQueue');
const metadataRouter = require('./routes/metadata');
const analyticsRouter = require('./routes/analytics');
const hlsRouter = require('./routes/hls');
const purgeRouter = require('./routes/purge');
const normalizeRouter = require('./routes/normalize');
const subdlRouter = require('./routes/subdl');
const healthRouter = require('./routes/health');
const dlnaRouter = require('./routes/dlna');
const chromecastRouter = require('./routes/chromecast');
const adminRouter = require('./routes/admin');

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

// Red de seguridad: un archivo corrupto (ffprobe fallando) u otro error
// inesperado en tareas de fondo (precalentamiento, watcher...) no debe poder
// tumbar todo el servidor. Node mata el proceso por defecto ante una
// promesa rechazada sin capturar; aquí solo se registra y se sigue.
process.on('unhandledRejection', (err) => {
  console.error(`Error no capturado (la app sigue en marcha): ${err?.message || err}`);
});
process.on('uncaughtException', (err) => {
  console.error(`Excepción no capturada (la app sigue en marcha): ${err?.stack || err?.message || err}`);
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
// Una sola vez aquí para toda la app, en vez de que cada router que lee
// req.body lo repitiera con su propio `router.use(express.json())`.
// Límite más generoso que el 100kb por defecto: un subtítulo importado a
// mano (routes/tracks.js: POST /subtitle/import) viaja aquí como texto en
// base64 dentro del JSON (evita añadir una dependencia de subida de
// archivos solo para esto), y eso puede pasar de 100kb con un .srt largo.
// Sin esto, un Chromecast (o cualquier receptor "de navegador", como el
// Default Media Receiver que usa server/chromecast.js) rechaza la carga del
// vídeo sin más ni un solo aviso claro: pasa un buen rato "cargando" y acaba
// en IDLE/ERROR, todo por CORS - visto de verdad probando contra una TV
// real (issue #109): fallaba igual con HLS, con MP4 progresivo y con el
// remux, los tres formatos distintos, la MISMA causa. Como este servidor es
// LAN-only por diseño (ver SECURITY.md, nunca expuesto a internet), un
// origen abierto aquí no añade riesgo real.
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use('/api', videosRouter);
app.use('/api', thumbnailRouter);
app.use('/api', settingsRouter);
app.use('/api', browseRouter);
app.use('/api', tracksRouter);
app.use('/api', trickplayRouter);
app.use('/api', profilesRouter);
app.use('/api', queueRouter);
app.use('/api', moveQueueRouter);
app.use('/api', upscaleQueueRouter);
app.use('/api', metadataRouter);
app.use('/api', analyticsRouter);
app.use('/api', hlsRouter);
app.use('/api', purgeRouter);
app.use('/api', normalizeRouter);
app.use('/api', subdlRouter);
app.use('/api', healthRouter);
app.use('/api', dlnaRouter);
app.use('/api', chromecastRouter);
app.use('/api', adminRouter);

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

// Middleware de error centralizado: antes cada ruta hacía su propio
// try/catch + res.status(500).json({error: err.message}) (o directamente no
// capturaba nada, dejando la petición colgada - ver asyncHandler.js). Los
// handlers envueltos con asyncHandler llegan aquí vía next(err); los que
// necesitan un código concreto (400/404/409...) lo siguen marcando ellos
// mismos con `err.status` antes de relanzar, o responden directamente sin
// pasar por aquí. Tiene que ir DESPUÉS de todas las rutas (así es como
// Express reconoce un middleware de error: 4 parámetros).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Error en ${req.method} ${req.path}: ${err.message}`);
  res.status(err.status || 500).json({ error: err.message });
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

// Todo lo que puede tardar de verdad (normalizar nombres, precalentar HLS,
// traslado automático, subtítulos...) va aquí, SIN que scanIfConfigured lo
// espere - si no, el servidor entero no respondería ni una sola petición
// hasta que todo esto terminara, a veces varios minutos con un catálogo
// grande. "initialVideos" es el escaneo ya hecho al arrancar; se vuelve a
// escanear tras normalizar porque los renombrados lo dejan desactualizado.
async function warmUpInBackground(initialVideos) {
  let videos = initialVideos;
  // Precalienta la caché de géneros en segundo plano (puede tardar si hay
  // muchas series/películas); el catálogo funciona igual mientras tanto.
  metadata.warmAll(catalog.getAllGroupKeys());

  // Pasada completa de normalización de nombres ANTES de precalentar HLS,
  // no en paralelo (issue #112): runNormalizeAll() renombra archivos de
  // verdad en disco, y hls.warmAll() de abajo recorre una lista de vídeos
  // tomada de ESTE escaneo - si los dos corrían a la vez, warmAll podía
  // llegar tarde a un vídeo que normalize.js ya había renombrado mientras
  // tanto, e intentar generar su HLS con una ruta que ya no existía
  // ("No such file or directory" para archivos que en realidad seguían
  // ahí, solo que con otro nombre). Verificado en producción con varios
  // episodios de Galactik Football que fallaban así en cada reinicio, uno
  // detrás de otro, saturando el disco externo justo cuando alguien podía
  // estar viendo algo a la vez. Es idempotente (no toca lo que ya está
  // bien), así que en el caso normal (nada que renombrar) esto añade poco
  // retraso real antes de empezar a precalentar - y como esta función entera
  // ya no bloquea el arranque del servidor (ver más arriba), ese retraso
  // tampoco deja el sitio sin responder mientras tanto.
  try {
    // runNormalizeAll() no espera a que los renombrados terminen de verdad:
    // arranca el trabajo en segundo plano y devuelve el control al momento
    // (pensado para el botón manual de /config, que sondea su progreso con
    // getProgress() en vez de esperar la promesa). Aquí SÍ hace falta
    // esperar a que termine de verdad antes de seguir, o el arreglo de
    // arriba no sirve de nada - se sondea igual que ya hace ese botón.
    await normalize.runNormalizeAll();
    while (normalize.getProgress().running) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    videos = await catalog.scan();
  } catch (err) {
    console.warn(`Normalización al arrancar: ${err.message}`);
  }

  // Precalienta HLS en segundo plano (prioridad baja: quien le da a play
  // ahora mismo sigue adelantando en la cola, ver #61/ffmpeg-limiter.js).
  hls.warmAll(videos);
  // Encola para traslado (ver moveOriginal.js) todo lo que ya estaba con
  // el HLS listo de antes de tener esto activado - si no, el gancho
  // automático (hls.js, justo cuando termina de generarse) nunca se
  // dispararía para ellos, y el ahorro de espacio solo aplicaría a vídeos
  // nuevos a partir de ahora. Sin carpeta configurada, no hace nada.
  for (const video of videos) {
    if (video.archived || video.movedTo) continue;
    if (hls.getStatus(video) === 'ready') {
      moveOriginal.maybeMoveOriginal(video).catch(() => {});
      // Igual para el reescalado (upscale.js): lo ya listo por debajo de
      // 720p de antes de tener esto, o que falló la vez anterior.
      upscale.maybeUpscale(video);
    }
  }
  // Reintenta lo fallido UNA SOLA VEZ al arrancar (no en bucle: un fallo
  // persistente de verdad no debe reintentarse para siempre sin que nadie
  // se entere, ver server/resolveFailed.js).
  resolveFailed().catch((err) => console.warn(`Resolver fallidos al arrancar: ${err.message}`));
  // Detecta solos los subtítulos (.srt/.vtt) que ya vivieran junto a un
  // vídeo en su carpeta, sin tener que abrir cada uno para que se note (ver
  // localSubtitles.js). También pasa una vez al día (abajo).
  try {
    await localSubtitles.autoImportAllSidecars(videos);
  } catch (err) {
    console.warn(`Importación de subtítulos al arrancar: ${err.message}`);
  }
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
    watcher.start();
    // No se espera (ver el comentario de warmUpInBackground): el servidor
    // ya puede empezar a responder peticiones con lo que hay del catálogo
    // mientras esto sigue en marcha detrás.
    warmUpInBackground(videos).catch((err) => console.error(`Precalentamiento en segundo plano: ${err.message}`));
  } catch (err) {
    console.error(`Error al escanear la carpeta de vídeos: ${err.message}`);
  }
}

// Mantenimiento periódico de bajo riesgo (ver conversación que decidió
// automatizar esto: normalizar nombres es idempotente, y forzar TMDB
// respeta los overrides manuales - applyStoredOverrideIfAny los reaplica en
// vez de sobrescribirlos). Una vez al día basta: ni los nombres ni los
// metadatos de TMDB cambian con tanta frecuencia como para justificar más.
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
function runPeriodicMaintenance() {
  normalize.runNormalizeAll().catch((err) => console.warn(`Normalización periódica: ${err.message}`));
  metadata
    .forceTmdbRefreshAll(catalog.getAllGroupKeys())
    .catch((err) => console.warn(`Actualización TMDB periódica: ${err.message}`));
  Promise.resolve()
    .then(() => localSubtitles.autoImportAllSidecars(catalog.getCatalog()))
    .catch((err) => console.warn(`Importación de subtítulos periódica: ${err.message}`));
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
  setInterval(runPeriodicMaintenance, MAINTENANCE_INTERVAL_MS).unref();
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
