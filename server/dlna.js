const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const dlnacastsFactory = require('dlnacasts2');
const hls = require('./hls');
const profiles = require('./profiles');
const { getMediaInfo } = require('./mediaInfo');
const { buildSource } = require('./castSource');

// Descubrimiento de dispositivos DLNA/UPnP en la LAN (Fire TV, smart TVs con
// receptor DLNA activo...) - ver issue #99. dlnacasts2 hace SSDP por debajo y
// va emitiendo 'update' según encuentra reproductores; that.players se queda
// con todos los vistos hasta ahora (no hay "desconexión" activa, mismo
// comportamiento simplista de la librería).
const dlnacasts = dlnacastsFactory();

const STATUS_POLL_MS = 5000;

// Solo una emisión activa a la vez (uso personal, un único "mando" - mismo
// espíritu que el resto de estado global en memoria de este proyecto, ver
// hls.js). null si no hay nada emitiéndose ahora mismo.
let session = null;

function getDevices() {
  return dlnacasts.players.map((p) => ({ id: p.name, name: p.name }));
}

function findPlayer(deviceId) {
  return dlnacasts.players.find((p) => p.name === deviceId) || null;
}

function clearStatusTimer() {
  if (session?.timer) clearInterval(session.timer);
}

// Reenvía la posición de reproducción de la TV al mismo sistema de progreso
// por perfil que ya usa el reproductor normal (server/profiles.js, sin
// tocarlo) - así "Continuar viendo" se mantiene al día viendo en la TV.
function startStatusPolling() {
  clearStatusTimer();
  session.timer = setInterval(() => {
    if (!session) return;
    session.player.status((err, status) => {
      if (err || !session) return;
      session.lastStatus = status;
      if (status.currentTime != null && session.durationSeconds) {
        const ratio = Math.min(1, status.currentTime / session.durationSeconds);
        profiles.setProgress(session.profileId, session.videoId, { time: status.currentTime, ratio });
      }
    });
  }, STATUS_POLL_MS);
}

async function cast({ deviceId, video, profileId, audioIndex }) {
  const player = findPlayer(deviceId);
  if (!player) {
    throw new Error('Dispositivo no encontrado (puede que se haya desconectado, prueba a refrescar la lista).');
  }
  // Para poder calcular el "ratio" de progreso (necesario para "Continuar
  // viendo") a partir del segundo actual que devuelve la TV. Ya analizado y
  // cacheado de antes (para generar el HLS), así que no vuelve a llamar a
  // ffprobe de verdad salvo la primera vez.
  let durationSeconds = null;
  try {
    const info = await getMediaInfo(video);
    durationSeconds = Number(info.format?.duration) || null;
  } catch {
    // Sin duración no se puede calcular el ratio de progreso, pero la
    // emisión en sí no depende de esto - no es motivo para fallar.
  }

  clearStatusTimer();
  const { url, type } = buildSource(video, audioIndex);
  await new Promise((resolve, reject) => {
    player.play(url, { title: video.title, type }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  session = { deviceId, videoId: video.id, profileId, player, durationSeconds, lastStatus: null, timer: null };
  startStatusPolling();
}

function requireSession() {
  if (!session) throw new Error('No hay ninguna emisión activa.');
  return session;
}

function pause() {
  return new Promise((resolve, reject) => {
    const { player } = requireSession();
    player.pause((err) => (err ? reject(err) : resolve()));
  });
}

function resume() {
  return new Promise((resolve, reject) => {
    const { player } = requireSession();
    player.resume((err) => (err ? reject(err) : resolve()));
  });
}

function seek(seconds) {
  return new Promise((resolve, reject) => {
    const { player } = requireSession();
    player.seek(seconds, (err) => (err ? reject(err) : resolve()));
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!session) {
      resolve();
      return;
    }
    const { player } = session;
    clearStatusTimer();
    session = null;
    player.stop(() => resolve());
  });
}

function getStatus() {
  if (!session) return { active: false };
  return {
    active: true,
    deviceId: session.deviceId,
    videoId: session.videoId,
    currentTime: session.lastStatus?.currentTime ?? null,
    playerState: session.lastStatus?.playerState ?? null,
  };
}

// Remux en directo (solo copia, sin recodificar - el HLS de un vídeo
// archivado ya es H.264/AAC, ver hls.js:COMPATIBLE_VIDEO_CODECS) del HLS ya
// generado a un único MP4 fragmentado, para dispositivos DLNA que no
// entienden manifiestos HLS. No pasa por ffmpeg-limiter.js (pensado para
// conversiones cortas; esto dura toda la emisión) - límite propio y pequeño
// aquí mismo, porque solo hay una emisión activa a la vez por diseño.
const MAX_CONCURRENT_REMUX = 2;
let activeRemuxCount = 0;

function remuxStream(req, res, video) {
  if (activeRemuxCount >= MAX_CONCURRENT_REMUX) {
    res.status(503).json({ error: 'Ya hay demasiadas emisiones en marcha, inténtalo en un momento.' });
    return;
  }
  const master = hls.masterPlaylistFor(video);
  const args = [
    '-i', master,
    '-c', 'copy',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov',
    'pipe:1',
  ];
  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  activeRemuxCount += 1;

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    activeRemuxCount -= 1;
  };

  proc.on('error', (err) => {
    finish();
    console.warn(`DLNA: fallo lanzando el remux de "${video.title}": ${err.message}`);
    if (!res.headersSent) res.status(500).end();
  });
  proc.on('close', (code) => {
    finish();
    if (code !== 0 && code !== null) {
      console.warn(`DLNA: el remux de "${video.title}" salió con código ${code}: ${stderr.split('\n').slice(-5).join(' ')}`);
    }
  });

  // Si el dispositivo DLNA corta la conexión (deja de reproducir, cambia de
  // fuente...) se mata el proceso ffmpeg - sin esto se quedaría corriendo
  // para siempre en segundo plano, sin nadie leyendo su salida.
  req.on('close', () => {
    if (!finished) proc.kill();
  });

  res.status(200).set('Content-Type', 'video/mp4');
  proc.stdout.pipe(res);
}

module.exports = {
  getDevices,
  cast,
  pause,
  resume,
  seek,
  stop,
  getStatus,
  remuxStream,
};
