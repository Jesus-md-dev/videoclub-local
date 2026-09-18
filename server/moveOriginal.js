const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MOVED_ORIGINALS_PATH } = require('./config');
const { inputPathFor } = require('./mediaInfo');
const movedOriginals = require('./movedOriginals');

// Traslada automáticamente a MOVED_ORIGINALS_PATH (si hay una carpeta
// configurada) el original de cada vídeo, justo después de que su HLS quede
// listo (ver hls.js: se llama ahí, igual que pregenerateExtras) - y también
// para lo que ya estaba listo de antes de activar esto (ver server/index.js:
// scanIfConfigured encola aquí todo lo ya "ready" tras el escaneo inicial,
// así el traslado automático absorbe también el trabajo que antes hacía a
// mano scripts/mover-originales-a-d.js). Es la versión con cola visible
// (/api/move-queue, página /move-queue) de ese mismo script manual: mismo
// registro (movedOriginals.js), mismo motivo (liberar espacio en el disco de
// la biblioteca sin perder el original).
//
// El original SOLO se borra de su sitio después de comprobar que la copia en
// el destino tiene el mismo tamaño exacto - igual que el resto del proyecto
// desde que se perdieron ~180 episodios por un borrado sin verificar (ver
// hls.js, comentario junto a donde se llama esto). Si algo falla en
// cualquier paso (el disco destino no está conectado ahora mismo, se queda
// sin espacio, la verificación no cuadra...), se deja el original tal cual
// donde estaba y queda marcado como "fallido" en la cola, sin reintentar
// solo (evita un bucle de reintentos contra un disco desconectado): un
// próximo reinicio del servidor (scanIfConfigured) sí lo vuelve a intentar.
//
// Un solo traslado a la vez: copiar de un disco externo USB ya ocupado con
// lecturas/escrituras de HLS en curso, varios robocopy a la vez solo
// competirían por el mismo cabezal/ancho de banda sin ganar nada - igual de
// conservador que ffmpeg-limiter.js con los procesos ffmpeg.
const queue = [];
let processing = false;

// video.id -> { state: 'queued'|'moving'|'done'|'failed', percent, title, size, error }
const status = new Map();

function destPathFor(video) {
  return path.join(MOVED_ORIGINALS_PATH, video.relativePath);
}

// robocopy, sin /MT, imprime líneas de progreso del archivo en curso como
// "  47.3%": basta con quedarse con el último porcentaje visto en cada
// trozo de salida para tener un progreso en vivo sin tener que sondear el
// tamaño del archivo destino a mano.
function runRobocopyAsync(sourceDir, destDir, fileName, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('robocopy', [sourceDir, destDir, fileName, '/COPY:DAT', '/R:3', '/W:2'], {
      windowsHide: true,
    });
    let output = '';
    const onChunk = (chunk) => {
      const text = chunk.toString();
      output += text;
      const matches = text.match(/(\d{1,3}(?:\.\d)?)%/g);
      if (matches && matches.length > 0) {
        const percent = parseFloat(matches[matches.length - 1]);
        if (!Number.isNaN(percent)) onProgress(percent);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (code) => {
      // Códigos de robocopy: bitmask de éxito (0-7), no un booleano normal -
      // >= 8 es el único caso real de fallo.
      if (code >= 8) reject(new Error(`robocopy falló (código ${code}): ${output}`));
      else resolve();
    });
  });
}

async function moveOne(video, onProgress) {
  const sourceAbs = inputPathFor(video);
  const destAbs = destPathFor(video);

  if (fs.existsSync(destAbs)) {
    // Un traslado anterior puede haberse quedado a medias (el servidor se
    // reinició justo después de copiar pero antes de verificar/borrar/
    // registrar - visto de verdad al reiniciar varias veces seguidas con la
    // cola aún larga): si el tamaño ya coincide, se retoma desde ahí en vez
    // de fallar sin más cada vez que se vuelve a intentar.
    const destSize = fs.statSync(destAbs).size;
    const sourceSize = fs.statSync(sourceAbs).size;
    if (destSize !== sourceSize) {
      throw new Error(`ya existe "${destAbs}" con un tamaño distinto, se omite por seguridad`);
    }
    onProgress(100);
  } else {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    await runRobocopyAsync(path.dirname(sourceAbs), path.dirname(destAbs), path.basename(sourceAbs), onProgress);

    const sourceSize = fs.statSync(sourceAbs).size;
    const destSize = fs.statSync(destAbs).size;
    if (sourceSize !== destSize) {
      throw new Error(`verificación fallida: ${sourceSize} bytes en origen, ${destSize} en destino`);
    }
  }

  fs.rmSync(sourceAbs, { force: true });
  movedOriginals.register(video, destAbs);
  console.log(`Traslado automático: "${video.relativePath}" -> "${destAbs}"`);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  let movedAnything = false;
  while (queue.length > 0) {
    const video = queue.shift();
    const entry = status.get(video.id);
    entry.state = 'moving';
    try {
      // eslint-disable-next-line no-await-in-loop
      await moveOne(video, (percent) => {
        entry.percent = percent;
      });
      entry.state = 'done';
      entry.percent = 100;
      movedAnything = true;
    } catch (err) {
      entry.state = 'failed';
      entry.error = err.message;
      console.warn(`Traslado automático fallido para "${video.relativePath}" (se deja el original donde estaba): ${err.message}`);
    }
  }
  processing = false;

  // El catálogo en memoria (catalog.js: cache/byId) no se entera solo de
  // que estos vídeos ya tienen "movedTo" hasta el próximo escaneo completo
  // (el registro se actualiza en disco, pero buildLibrary() reconstruye
  // desde cero a partir del último escaneo, no observa este registro en
  // vivo). Se reutiliza el reescaneo con antirrebote de watcher.js (30s, ya
  // pensado para no solapar varios reescaneos seguidos contra el disco
  // externo - ver su propio comentario) en vez de escanear aquí mismo cada
  // vez: fs.rmSync ya deja el original borrado antes de esto, así que el
  // propio vigilante de la carpeta también se habría enterado solo, pero
  // llamarlo aquí explícitamente no depende de que fs.watch llegue a
  // disparar a tiempo. Una racha de traslados seguidos (como al arrancar,
  // con el backlog entero) solo dispara UN reescaneo al asentarse, no uno
  // por cada vez que la cola toca fondo. Require perezoso porque catalog.js
  // -> hls.js -> este módulo -> watcher.js -> catalog.js formarían un
  // ciclo si se pidiera al cargar el módulo.
  if (movedAnything) {
    // eslint-disable-next-line global-require
    const watcher = require('./watcher');
    watcher.scheduleRescan();
  }
}

async function maybeMoveOriginal(video) {
  if (!MOVED_ORIGINALS_PATH) return; // sin carpeta configurada: desactivado
  if (video.archived === true || video.movedTo) return;
  if (status.has(video.id)) return; // ya en cola, movido o fallido antes

  const sourceAbs = inputPathFor(video);
  if (!fs.existsSync(sourceAbs)) return;

  status.set(video.id, { state: 'queued', percent: 0, title: video.title, size: video.size, error: null });
  queue.push(video);
  processQueue();
}

// Para la página /move-queue (ver server/routes/moveQueue.js).
function getQueueStatus() {
  const items = [...status.entries()].map(([id, info]) => ({ id, ...info }));
  return {
    configured: Boolean(MOVED_ORIGINALS_PATH),
    destination: MOVED_ORIGINALS_PATH,
    moving: items.filter((i) => i.state === 'moving'),
    queued: items.filter((i) => i.state === 'queued'),
    done: items.filter((i) => i.state === 'done'),
    failed: items.filter((i) => i.state === 'failed'),
  };
}

module.exports = { maybeMoveOriginal, getQueueStatus };
