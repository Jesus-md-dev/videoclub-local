const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { UPSCALE_PATH, REALESRGAN_PATH, HLS_PATH } = require('./config');
const { inputPathFor, probeRaw } = require('./mediaInfo');
const { checkGpuAvailable } = require('./gpu');

// Reescalado con IA (Real-ESRGAN, modelo realesr-animevideov3) de todo lo
// que se sirve por debajo de 720p: visto con Medabots, 51 episodios a
// 320x240 y ~450kbps (grabaciones de la tele) que a pantalla completa eran
// un borrón. El reescalado normal no aporta nada (el navegador ya amplía
// igual); la IA limpia bordes y artefactos de compresión, que en dibujos de
// colores planos es justo lo que más se nota.
//
// Qué se reescala: se mira la RESOLUTION del master.m3u8 ya generado (lo
// que de verdad se está sirviendo), no un registro aparte - así un HLS
// regenerado desde el original bajo (p.ej. si se borra la carpeta HLS) se
// vuelve a detectar y reescalar solo, y uno ya reescalado (720 de alto)
// nunca se repite. Los anchos >= 1280 no cuentan aunque la altura sea
// menor (1280x536 es HD panorámico, no SD).
//
// Cómo: por tramos de CHUNK_FRAMES fotogramas (extraer -> Real-ESRGAN ->
// codificar un segmento), para que el espacio temporal no pase de 1-2GB
// aunque sea una película entera; al final se unen los segmentos, se añade
// el audio del ORIGINAL (copia, sin tocar) y se regenera el HLS desde ese
// archivo (hls.js: regenerateFromSource). El HLS antiguo sigue sirviéndose
// hasta que el nuevo está verificado; después se borra el temporal. El
// original no se toca nunca (ni se modifica ni se borra, ver #97).
//
// Uno a la vez: Real-ESRGAN satura la GPU entera; varios a la vez solo
// competirían por ella sin terminar antes.
const TARGET_HEIGHT = 720;
const CHUNK_FRAMES = 3000;
const MODEL = 'realesr-animevideov3';
// Fotogramas temporales + el vídeo reescalado + el HLS nuevo (que ocupa más
// que el de baja resolución al que sustituye): con menos de esto se para la
// cola en vez de arriesgarse a llenar el disco de la biblioteca (ver el
// umbral parecido de hls.js, MIN_FREE_BYTES_TO_GENERATE).
const MIN_FREE_BYTES = 30 * 1024 * 1024 * 1024;

const queue = [];
let processing = false;
// video.id -> { state: 'queued'|'processing'|'done'|'failed', phase, percent, title, fromHeight, error }
const status = new Map();

function isEnabled() {
  return Boolean(UPSCALE_PATH && REALESRGAN_PATH);
}

function workDirFor(video) {
  return path.join(UPSCALE_PATH, '.work', video.id);
}

// Alto de la pista de vídeo que declara el master.m3u8 del HLS listo, o null
// si no hay HLS o no la declara.
function servedResolution(video) {
  try {
    const text = fs.readFileSync(path.join(HLS_PATH, video.id, 'master.m3u8'), 'utf-8');
    const match = text.match(/RESOLUTION=(\d+)x(\d+)/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  } catch {
    return null;
  }
}

function needsUpscale(res) {
  return Boolean(res) && res.height < TARGET_HEIGHT && res.width < 1280;
}

function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(path.parse(dir).root);
    return stats.bavail * stats.bsize;
  } catch {
    return Infinity;
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} salió con código ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

function parseRate(rate) {
  const [num, den] = String(rate || '').split('/').map(Number);
  return num > 0 && den > 0 ? { text: `${num}/${den}`, value: num / den } : null;
}

function parseRatio(ratio) {
  const [a, b] = String(ratio || '').split(':').map(Number);
  return a > 0 && b > 0 ? a / b : 1;
}

function listFrames(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
}

async function upscaleOne(video, entry) {
  const source = inputPathFor(video);
  if (!fs.existsSync(source)) throw new Error(`no se encuentra el original en "${source}"`);
  if (freeBytes(UPSCALE_PATH) < MIN_FREE_BYTES) {
    throw new Error('menos de 30GB libres en el disco de trabajo: se deja para el próximo reinicio');
  }

  const info = await probeRaw(source);
  const vs = info.streams.find((s) => s.codec_type === 'video');
  if (!vs) throw new Error('el original no tiene pista de vídeo');
  if (!info.streams.some((s) => s.codec_type === 'audio')) throw new Error('el original no tiene audio');
  // Algunos MKV no declaran avg_frame_rate (0/0) - visto con Medabots, que
  // es de verdad a 18fps (r_frame_rate): se usa ese como respaldo.
  const fps = parseRate(vs.avg_frame_rate) || parseRate(vs.r_frame_rate);
  if (!fps) throw new Error('no se pudo saber la cadencia de fotogramas del original');
  const duration = Number(info.format?.duration) || 0;
  if (!duration) throw new Error('no se pudo saber la duración del original');

  // Ancho final respetando el aspecto real (DVD anamórfico: 720x480 con
  // píxeles no cuadrados), siempre par para H.264.
  const displayWidth = vs.width * parseRatio(vs.sample_aspect_ratio);
  const outWidth = Math.round((TARGET_HEIGHT * displayWidth) / vs.height / 2) * 2;
  // El factor más pequeño del modelo (x2/x3/x4) que llega a 720 de alto; lo
  // que sobre lo ajusta lanczos al codificar.
  const scale = [2, 3, 4].find((s) => vs.height * s >= TARGET_HEIGHT) || 4;
  const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(vs.field_order);
  const totalFrames = Math.max(1, Math.round(duration * fps.value));
  const useGpu = await checkGpuAvailable(UPSCALE_PATH);
  const videoCodecArgs = useGpu
    ? ['-c:v', 'h264_nvenc', '-preset', 'p7', '-rc', 'vbr', '-cq', '19', '-b:v', '0']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18'];

  const work = workDirFor(video);
  const inDir = path.join(work, 'in');
  const outDir = path.join(work, 'out');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  entry.fromHeight = vs.height;

  const segments = [];
  let framesDone = 0;
  for (let chunk = 0; ; chunk += 1) {
    const start = (chunk * CHUNK_FRAMES) / fps.value;
    if (start >= duration) break;
    entry.phase = 'extrayendo';
    // -ss antes de -i: salto rápido, y exacto porque se decodifica; con
    // -fps_mode cfr cada tramo tiene exactamente CHUNK_FRAMES fotogramas a
    // la misma cadencia, así que los segmentos unidos siguen cuadrando con
    // el audio del original. JPG a calidad máxima en vez de PNG: escribir
    // miles de PNG en el disco USB era más lento que la propia IA.
    // eslint-disable-next-line no-await-in-loop
    await run(ffmpegPath, [
      '-v', 'error', '-y', '-ss', start.toFixed(6), '-i', source,
      '-map', '0:v:0', ...(interlaced ? ['-vf', 'yadif'] : []),
      '-fps_mode', 'cfr', '-r', fps.text, '-frames:v', String(CHUNK_FRAMES),
      '-q:v', '1', path.join(inDir, '%06d.jpg'),
    ]);
    const extracted = listFrames(inDir).length;
    if (extracted === 0) break;

    entry.phase = 'reescalando';
    // eslint-disable-next-line no-await-in-loop
    await run(REALESRGAN_PATH, [
      '-i', inDir, '-o', outDir, '-n', MODEL, '-s', String(scale),
      '-g', '0', '-j', '2:4:4', '-f', 'jpg',
      '-m', path.join(path.dirname(REALESRGAN_PATH), 'models'),
    ]);
    // Real-ESRGAN puede salir con 0 aunque se haya dejado fotogramas sin
    // procesar (p.ej. sin memoria de vídeo): un hueco aquí desincronizaría
    // el audio de todo lo que viene detrás.
    const upscaled = listFrames(outDir).length;
    if (upscaled !== extracted) {
      throw new Error(`Real-ESRGAN solo ha procesado ${upscaled} de ${extracted} fotogramas del tramo ${chunk + 1}`);
    }

    entry.phase = 'codificando';
    const segment = path.join(work, `seg_${String(chunk).padStart(4, '0')}.mkv`);
    // eslint-disable-next-line no-await-in-loop
    await run(ffmpegPath, [
      '-v', 'error', '-y', '-framerate', fps.text, '-i', path.join(outDir, '%06d.jpg'),
      '-vf', `scale=${outWidth}:${TARGET_HEIGHT}:flags=lanczos,format=yuv420p,setsar=1`,
      ...videoCodecArgs, segment,
    ]);
    segments.push(segment);
    for (const dir of [inDir, outDir]) {
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
    }
    framesDone += extracted;
    entry.percent = Math.min(99, (framesDone / totalFrames) * 100);
    if (extracted < CHUNK_FRAMES) break;
  }
  if (segments.length === 0) throw new Error('no se ha extraído ningún fotograma del original');

  entry.phase = 'uniendo';
  const listFile = path.join(work, 'segments.txt');
  fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const result = path.join(work, 'upscaled.mkv');
  await run(ffmpegPath, [
    '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-i', source,
    '-map', '0:v:0', '-map', '1:a', '-c', 'copy', '-map_metadata', '1', '-map_chapters', '1',
    result,
  ]);
  for (const s of segments) fs.rmSync(s, { force: true });

  const check = await probeRaw(result);
  const outStream = check.streams.find((s) => s.codec_type === 'video');
  const outDuration = Number(check.format?.duration) || 0;
  if (!outStream || outStream.height !== TARGET_HEIGHT || Math.abs(outDuration - duration) > Math.max(2, duration * 0.01)) {
    throw new Error(`el resultado no cuadra (${outStream?.width}x${outStream?.height}, ${outDuration.toFixed(1)}s frente a ${duration.toFixed(1)}s)`);
  }

  entry.phase = 'regenerando HLS';
  // Require perezoso: hls.js también requiere este módulo (para encolar al
  // terminar un HLS), y pedirlo al cargar formaría un ciclo.
  // eslint-disable-next-line global-require
  const hls = require('./hls');
  await hls.regenerateFromSource(video, result);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Reescalado: "${video.relativePath}" ${vs.width}x${vs.height} -> ${outWidth}x${TARGET_HEIGHT}`);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const video = queue.shift();
    const entry = status.get(video.id);
    entry.state = 'processing';
    entry.percent = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      await upscaleOne(video, entry);
      entry.state = 'done';
      entry.percent = 100;
      entry.phase = null;
    } catch (err) {
      entry.state = 'failed';
      entry.error = err.message;
      entry.phase = null;
      console.warn(`Reescalado fallido para "${video.relativePath}": ${err.message}`);
      // El trabajo a medias no sirve para nada (se empieza de cero la
      // próxima vez) y pueden ser varios GB en el disco de la biblioteca.
      fs.rmSync(workDirFor(video), { recursive: true, force: true });
    }
  }
  processing = false;
}

// Se llama al quedar listo un HLS (hls.js) y, al arrancar, para todo lo ya
// listo (index.js). Barato si no hace falta: solo lee el master.m3u8.
function maybeUpscale(video) {
  if (!isEnabled()) return;
  if (status.has(video.id)) return; // ya en cola, hecho o fallido (se reintenta al reiniciar)
  if (!needsUpscale(servedResolution(video))) return;
  if (!fs.existsSync(inputPathFor(video))) return; // sin original (archivado): nada que reescalar

  status.set(video.id, { state: 'queued', phase: null, percent: 0, title: video.title, fromHeight: servedResolution(video).height, error: null });
  queue.push(video);
  processQueue();
}

// Para la página /upscale-queue (ver server/routes/upscaleQueue.js).
function getQueueStatus() {
  const items = [...status.entries()].map(([id, info]) => ({ id, ...info }));
  return {
    configured: isEnabled(),
    workPath: UPSCALE_PATH,
    tool: REALESRGAN_PATH,
    processing: items.filter((i) => i.state === 'processing'),
    queued: items.filter((i) => i.state === 'queued'),
    done: items.filter((i) => i.state === 'done'),
    failed: items.filter((i) => i.state === 'failed'),
  };
}

module.exports = { maybeUpscale, getQueueStatus };
