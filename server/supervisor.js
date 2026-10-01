// Vigilante del servidor (issue #140). iniciar.bat arranca esto en vez de
// server/index.js directamente:
//
// - Si el servidor se cae, lo vuelve a arrancar (antes la web se quedaba
//   caída hasta que alguien lo notaba y lo relanzaba a mano).
// - Si deja de responder a /health durante HANG_FAILURES comprobaciones
//   seguidas (colgado, no caído), lo mata con sus ffmpeg y lo relanza.
// - Si el servidor sale con RESTART_EXIT_CODE es un reinicio pedido por él
//   mismo (restartManager.js: "reiniciar cuando esté libre", aplicar una
//   actualización...): se relanza al momento.
//
// No recarga código en caliente (ver #90): siempre es un proceso nuevo.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = parseInt(process.env.PORT, 10) || 3000;
const RESTART_EXIT_CODE = 75;
const PID_FILE = path.join(__dirname, '..', 'supervisor.pid');
const HEALTH_INTERVAL_MS = 30 * 1000;
const HEALTH_TIMEOUT_MS = 10 * 1000;
const HANG_FAILURES = 4; // 4 x 30 s = 2 min sin responder
// Si se cae muchas veces seguidas (p.ej. un error al cargar), no se relanza
// en bucle: se espera un rato entre intento e intento.
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const CRASH_LIMIT = 5;
const CRASH_BACKOFF_MS = 5 * 60 * 1000;

let child = null;
let stopping = false;
let healthyOnce = false;
let failures = 0;
const crashes = [];

function log(message) {
  console.log(`[vigilante ${new Date().toLocaleString('es-ES')}] ${message}`);
}

// Al morir el servidor, sus ffmpeg hijos siguen vivos en Windows (no hay
// "process group"): se buscan por el PID del padre y se terminan, para que
// el servidor nuevo no se pise con conversiones huérfanas a medio escribir.
function killOrphans(parentPid) {
  return new Promise((resolve) => {
    const script =
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | ` +
      'ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null; $_.Name }';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (err, stdout) => {
      const names = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (names.length) log(`Terminados ${names.length} proceso(s) hijo(s) huérfanos: ${names.join(', ')}`);
      resolve();
    });
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

function start() {
  if (stopping) return;
  healthyOnce = false;
  failures = 0;
  child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, VC_SUPERVISED: '1' },
    windowsHide: true,
  });
  log(`Servidor arrancado (PID ${child.pid})`);
  const { pid } = child;
  child.on('exit', async (code, signal) => {
    child = null;
    await killOrphans(pid);
    if (stopping) return;
    if (code === RESTART_EXIT_CODE) {
      log('El servidor ha pedido reiniciarse: se relanza');
      start();
      return;
    }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    const wait = crashes.length >= CRASH_LIMIT ? CRASH_BACKOFF_MS : 3000;
    log(
      `El servidor se ha detenido (código ${code}${signal ? `, señal ${signal}` : ''}); ` +
        `se relanza en ${Math.round(wait / 1000)} s` +
        (crashes.length >= CRASH_LIMIT ? ` (${crashes.length} caídas en 10 min: revisa server-error.log)` : '')
    );
    setTimeout(start, wait);
  });
}

function checkHealth() {
  if (!child) return;
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: HEALTH_TIMEOUT_MS }, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      healthyOnce = true;
      failures = 0;
    } else {
      onHealthFailure(`respondió ${res.statusCode}`);
    }
  });
  req.on('timeout', () => req.destroy(new Error('sin respuesta')));
  req.on('error', (err) => onHealthFailure(err.message));
}

async function onHealthFailure(reason) {
  // Mientras arranca todavía no escucha: no cuenta hasta haber respondido
  // al menos una vez.
  if (!healthyOnce || !child) return;
  failures += 1;
  if (failures < HANG_FAILURES) return;
  const { pid } = child;
  log(`El servidor no responde desde hace ${(failures * HEALTH_INTERVAL_MS) / 1000} s (${reason}): se reinicia`);
  failures = 0;
  // Al terminar el árbol, el evento "exit" de arriba lo relanza.
  await killTree(pid);
}

async function stop() {
  stopping = true;
  if (child) await killTree(child.pid);
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ya no estaba.
  }
  process.exit(0);
}

fs.writeFileSync(PID_FILE, String(process.pid));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, stop);
setInterval(checkHealth, HEALTH_INTERVAL_MS);
log(`Vigilante en marcha (PID ${process.pid})`);
start();
