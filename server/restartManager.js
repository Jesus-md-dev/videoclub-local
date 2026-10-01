// Reinicios controlados del servidor (issue #140). Reiniciar corta lo que
// esté en marcha: reproducciones, conversiones que alguien espera, traslados
// de originales a otro disco... Hasta ahora eso obligaba a preguntar "¿puedo
// reiniciar?" cada vez. Esto espera solo a que no haya nada de eso y
// entonces sale con RESTART_EXIT_CODE para que el vigilante
// (supervisor.js) lo relance con el código nuevo.
//
// El precalentado de HLS en segundo plano NO cuenta como ocupado: es casi
// continuo con una biblioteca grande y se retoma solo tras reiniciar.
const backup = require('./backup');
const ffmpegLimiter = require('./ffmpeg-limiter');
const moveOriginal = require('./moveOriginal');
const normalize = require('./normalize');

const RESTART_EXIT_CODE = 75;
// Una reproducción pide segmentos cada pocos segundos; en pausa deja de
// pedirlos. Con este margen, una pausa corta tampoco se corta.
const PLAYBACK_GRACE_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;

let lastStreamAt = 0;
let pending = null;
let timer = null;

function isSupervised() {
  return process.env.VC_SUPERVISED === '1';
}

// Middleware: cualquier petición de vídeo (segmentos HLS, envío a la tele
// por DLNA/Chromecast) cuenta como "alguien está viendo algo".
function trackStreamActivity(req, res, next) {
  if (/^\/api\/(hls\/[^/]+\/[^/]+\/|dlna\/remux\/|chromecast\/)/.test(req.path)) lastStreamAt = Date.now();
  next();
}

function busyReasons() {
  const reasons = [];
  const sinceStream = Date.now() - lastStreamAt;
  if (sinceStream < PLAYBACK_GRACE_MS) {
    reasons.push(`se está viendo algo (último vídeo pedido hace ${Math.round(sinceStream / 1000)} s)`);
  }
  const ffmpeg = ffmpegLimiter.getStats();
  if (ffmpeg.runningHigh || ffmpeg.queuedHigh) {
    reasons.push(`${ffmpeg.runningHigh + ffmpeg.queuedHigh} conversión(es) que alguien está esperando`);
  }
  const moves = moveOriginal.getQueueStatus();
  if (moves.moving.length) reasons.push(`${moves.moving.length} traslado(s) de originales en curso`);
  if (normalize.getProgress().running) reasons.push('renombrando archivos');
  return reasons;
}

function restartNow(reason) {
  console.log(`Reinicio: ${reason}`);
  clearInterval(timer);
  // Lo pequeño e importante (progreso, perfiles...) en síncrono: la copia
  // asíncrona no llegaría a terminar.
  backup.backupEssentialsSync();
  // Un momento para que la respuesta HTTP que lo pidió llegue a salir.
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
}

function check() {
  if (!pending) return;
  if (busyReasons().length) return;
  restartNow(`${pending.reason} (servidor libre)`);
}

// mode: 'idle' (cuando esté libre) o 'now'.
function requestRestart(mode, reason) {
  if (!isSupervised()) {
    throw new Error('El servidor no está arrancado con el vigilante (iniciar.bat): no se volvería a levantar solo.');
  }
  if (mode === 'now') {
    restartNow(reason);
    return getState();
  }
  if (!pending) {
    pending = { reason, requestedAt: new Date().toISOString() };
    console.log(`Reinicio programado para cuando el servidor esté libre: ${reason}`);
    timer = setInterval(check, CHECK_INTERVAL_MS);
    timer.unref();
    setImmediate(check);
  } else if (!pending.reason.includes(reason)) {
    pending.reason += `; ${reason}`;
  }
  return getState();
}

function cancelRestart() {
  if (pending) console.log('Reinicio programado cancelado');
  pending = null;
  clearInterval(timer);
  return getState();
}

function getState() {
  return {
    supervised: isSupervised(),
    pending,
    busy: busyReasons(),
    lastStreamAt: lastStreamAt ? new Date(lastStreamAt).toISOString() : null,
  };
}

module.exports = { trackStreamActivity, requestRestart, cancelRestart, getState, isSupervised };
