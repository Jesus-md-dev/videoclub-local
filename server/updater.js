// Aplicar actualizaciones sin reiniciar a mano (issue #140).
//
// Cada minuto se mira si hay un commit nuevo (un "git pull" de
// actualizar.bat, o cambios hechos y confirmados en este mismo PC). Se usa
// el commit y no los archivos sueltos a propósito: un commit es un estado
// completo, mientras que los archivos pueden estar a medio editar.
// - Si cambió algo de client/: se recompila la web. No hace falta reiniciar,
//   el servidor ya sirve client/dist tal cual.
// - Si cambió algo del servidor (server/, package.json...): se pide un
//   reinicio "cuando esté libre" (restartManager.js).
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const restartManager = require('./restartManager');

const ROOT = path.join(__dirname, '..');
const POLL_INTERVAL_MS = 60 * 1000;
const CLIENT_INPUTS = ['client/src', 'client/public', 'client/index.html', 'client/package.json', 'client/package-lock.json', 'client/vite.config.js'];
const DIST_INDEX = path.join(ROOT, 'client', 'dist', 'index.html');
// Lo que, si cambia, solo se aplica reiniciando el proceso.
const SERVER_PATTERNS = [/^server\//, /^package(-lock)?\.json$/, /^patches\//];
const DEPS_PATTERNS = [/^package(-lock)?\.json$/, /^patches\//];

let startCommit = null;
let lastSeenHead = null;
let build = { running: false, lastResult: null };
let lastUpdate = null;

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

// npm en Windows es npm.cmd: hace falta la shell. Los argumentos son fijos
// (nada que venga de la petición), así que no hay nada que escapar.
function npm(args, logFile) {
  return new Promise((resolve, reject) => {
    const out = fs.openSync(path.join(ROOT, logFile), 'w');
    const proc = spawn('npm', args, { cwd: ROOT, shell: true, windowsHide: true, stdio: ['ignore', out, out] });
    proc.on('exit', (code) => {
      fs.closeSync(out);
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} salió con código ${code} (ver ${logFile})`));
    });
    proc.on('error', (err) => {
      fs.closeSync(out);
      reject(err);
    });
  });
}

function newestMtime(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const name of fs.readdirSync(target)) newest = Math.max(newest, newestMtime(path.join(target, name)));
  return newest;
}

// La misma regla que iniciar.bat: hay que recompilar si algo de client/ es
// más nuevo que la última compilación.
function isClientStale() {
  let built;
  try {
    built = fs.statSync(DIST_INDEX).mtimeMs;
  } catch {
    return true;
  }
  return CLIENT_INPUTS.some((input) => newestMtime(path.join(ROOT, input)) > built);
}

async function changedFilesSinceStart() {
  if (!startCommit) return [];
  const head = await git(['rev-parse', 'HEAD']);
  if (head === startCommit) return [];
  const out = await git(['diff', '--name-only', startCommit, head]);
  return out.split(/\r?\n/).filter(Boolean);
}

async function rebuildClient() {
  if (build.running) return build;
  build = { running: true, startedAt: new Date().toISOString(), lastResult: build.lastResult };
  console.log('Actualización: recompilando la web…');
  try {
    await npm(['run', 'build'], 'build.log');
    build.lastResult = { ok: true, finishedAt: new Date().toISOString() };
    console.log('Actualización: web recompilada (sin reiniciar)');
  } catch (err) {
    build.lastResult = { ok: false, error: err.message, finishedAt: new Date().toISOString() };
    console.error(`Actualización: no se pudo recompilar la web: ${err.message}`);
  } finally {
    build.running = false;
  }
  return build;
}

// pull: true para traer antes la última versión de GitHub (lo que hacía
// actualizar.bat). Si hay cambios locales sin confirmar, "--ff-only" falla
// y no se toca nada.
async function applyUpdates({ pull = false, reason = 'actualización' } = {}) {
  const result = { pulled: null, depsInstalled: false, clientRebuilt: false, restart: null, changedFiles: [] };
  if (pull) result.pulled = await git(['pull', '--ff-only']);
  result.changedFiles = await changedFilesSinceStart();
  const changed = (patterns) => result.changedFiles.some((file) => patterns.some((re) => re.test(file)));

  if (changed(DEPS_PATTERNS)) {
    console.log('Actualización: cambiaron las dependencias, npm install…');
    await npm(['install'], 'install.log');
    result.depsInstalled = true;
  }
  if (isClientStale()) {
    const done = await rebuildClient();
    result.clientRebuilt = Boolean(done.lastResult?.ok);
  }
  if (changed(SERVER_PATTERNS)) {
    result.restart = restartManager.isSupervised()
      ? restartManager.requestRestart('idle', `${reason}: cambió el código del servidor`)
      : { error: 'Hay cambios del servidor, pero sin el vigilante hay que reiniciar a mano (iniciar.bat).' };
  }
  lastUpdate = { ...result, reason, at: new Date().toISOString() };
  return result;
}

async function poll() {
  let head;
  try {
    head = await git(['rev-parse', 'HEAD']);
  } catch {
    return; // Sin git (copia sin repositorio): no hay nada que vigilar.
  }
  if (head === lastSeenHead) return;
  lastSeenHead = head;
  try {
    await applyUpdates({ reason: `commit nuevo ${head.slice(0, 7)}` });
  } catch (err) {
    console.error(`Actualización automática: ${err.message}`);
  }
}

async function start() {
  try {
    startCommit = await git(['rev-parse', 'HEAD']);
    lastSeenHead = startCommit;
  } catch (err) {
    console.warn(`Actualizaciones automáticas desactivadas (git no disponible): ${err.message}`);
    return;
  }
  setInterval(poll, POLL_INTERVAL_MS).unref();
}

async function getState() {
  let head = null;
  let changedFiles = [];
  try {
    head = await git(['rev-parse', 'HEAD']);
    changedFiles = await changedFilesSinceStart();
  } catch {
    // Sin git: se informa solo de lo que se sabe.
  }
  return {
    runningCommit: startCommit,
    head,
    serverChanged: changedFiles.some((file) => SERVER_PATTERNS.some((re) => re.test(file))),
    changedFiles,
    clientStale: isClientStale(),
    build,
    lastUpdate,
  };
}

module.exports = { start, applyUpdates, rebuildClient, getState };
