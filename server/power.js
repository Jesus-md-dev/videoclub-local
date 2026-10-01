const { execFile } = require('child_process');

// Apagar a distancia el PC donde corre el servidor (solo Windows). Se deja
// un margen de SHUTDOWN_DELAY_SECONDS para poder cancelarlo desde la web
// (o con "shutdown /a" en el propio PC); Windows muestra su aviso mientras.

const SHUTDOWN_DELAY_SECONDS = 60;

// Solo para que la web sepa que hay una cuenta atrás en marcha: si se
// cancela desde fuera (shutdown /a en el PC), esto no se entera hasta que
// se pulse "Cancelar" aquí, que lo arregla.
let scheduledFor = null;

function isSupported() {
  return process.platform === 'win32';
}

function runShutdown(args) {
  return new Promise((resolve, reject) => {
    execFile('shutdown', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error((stderr || stdout).trim() || err.message), { code: err.code }));
      else resolve();
    });
  });
}

function getStatus() {
  if (scheduledFor && scheduledFor <= Date.now()) scheduledFor = null;
  return {
    supported: isSupported(),
    delaySeconds: SHUTDOWN_DELAY_SECONDS,
    scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
  };
}

async function scheduleShutdown() {
  if (!isSupported()) throw new Error('Apagar el PC solo está disponible con el servidor en Windows.');
  await runShutdown([
    '/s',
    '/t',
    String(SHUTDOWN_DELAY_SECONDS),
    '/c',
    'Videoclub Local: apagado pedido desde la web. Para cancelarlo: shutdown /a',
  ]);
  scheduledFor = Date.now() + SHUTDOWN_DELAY_SECONDS * 1000;
  return getStatus();
}

async function cancelShutdown() {
  if (!isSupported()) throw new Error('Apagar el PC solo está disponible con el servidor en Windows.');
  try {
    await runShutdown(['/a']);
  } catch (err) {
    // 1116 = no había ningún apagado en curso: para la web eso ya es "cancelado".
    if (err.code !== 1116) throw err;
  }
  scheduledFor = null;
  return getStatus();
}

module.exports = { getStatus, scheduleShutdown, cancelShutdown };
