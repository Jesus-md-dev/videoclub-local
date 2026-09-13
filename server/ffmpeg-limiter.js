// Límite global de cuántos procesos ffmpeg pueden estar en marcha a la vez
// en TODA la app (conversión, trickplay, carátulas...), no solo dentro de
// cada subsistema por separado. Hace falta porque un fallo real dejó
// arrancar 217 procesos ffmpeg simultáneos (trickplay generaba una hoja de
// miniaturas por vídeo bajo demanda sin ningún tope entre vídeos distintos)
// y eso saturó la máquina hasta dejar el servidor entero sin responder.
const MAX_CONCURRENT_FFMPEG = 10;

let running = 0;
const queue = [];

function runNext() {
  if (running >= MAX_CONCURRENT_FFMPEG || queue.length === 0) return;
  running += 1;
  const { fn, resolve, reject } = queue.shift();
  fn().then(
    (value) => {
      running -= 1;
      resolve(value);
      runNext();
    },
    (err) => {
      running -= 1;
      reject(err);
      runNext();
    }
  );
}

// Encola `fn` (una función que devuelve una promesa, normalmente lanzando
// un proceso ffmpeg) y la ejecuta en cuanto haya hueco libre.
function runLimited(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

module.exports = { runLimited, MAX_CONCURRENT_FFMPEG };
