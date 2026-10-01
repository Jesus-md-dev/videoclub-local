// Límite global de cuántos procesos ffmpeg pueden estar en marcha a la vez
// en TODA la app (conversión, trickplay, carátulas, HLS...), no solo dentro
// de cada subsistema por separado. Hace falta porque un fallo real dejó
// arrancar 217 procesos ffmpeg simultáneos (trickplay generaba una hoja de
// miniaturas por vídeo bajo demanda sin ningún tope entre vídeos distintos)
// y eso saturó la máquina hasta dejar el servidor entero sin responder.
const MAX_CONCURRENT_FFMPEG = 10;

let running = 0;
// Cuántos de los que corren son de prioridad alta (alguien esperando para
// verlo): restartManager.js no reinicia mientras haya alguno.
let runningHigh = 0;
// Dos carriles: lo que el usuario está pidiendo ver AHORA ('high') adelanta
// en la cola a lo que el precalentamiento en segundo plano ('low') aún no
// ha empezado. No interrumpe nada ya en marcha, solo decide qué entra
// primero en el siguiente hueco libre.
const highQueue = [];
const lowQueue = [];

function runNext() {
  if (running >= MAX_CONCURRENT_FFMPEG) return;
  const queue = highQueue.length ? highQueue : lowQueue;
  if (queue.length === 0) return;
  const high = queue === highQueue;
  running += 1;
  if (high) runningHigh += 1;
  const { fn, resolve, reject } = queue.shift();
  const done = () => {
    running -= 1;
    if (high) runningHigh -= 1;
  };
  fn().then(
    (value) => {
      done();
      resolve(value);
      runNext();
    },
    (err) => {
      done();
      reject(err);
      runNext();
    }
  );
}

// Encola `fn` (una función que devuelve una promesa, normalmente lanzando
// un proceso ffmpeg) y la ejecuta en cuanto haya hueco libre. `priority`:
// 'high' para lo que pide un usuario viendo el reproductor ahora mismo,
// 'low' (por defecto) para precalentamiento en segundo plano.
function runLimited(fn, priority = 'low') {
  return new Promise((resolve, reject) => {
    (priority === 'high' ? highQueue : lowQueue).push({ fn, resolve, reject });
    runNext();
  });
}

function getStats() {
  return { running, runningHigh, queuedHigh: highQueue.length, queuedLow: lowQueue.length };
}

module.exports = { runLimited, getStats, MAX_CONCURRENT_FFMPEG };
