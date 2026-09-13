const fs = require('fs');
const path = require('path');
const { ffmpeg, getMediaInfo, inputPathFor } = require('./mediaInfo');
const { DATA_PATH } = require('./config');

const TRANSCODED_PATH = path.join(DATA_PATH, 'transcoded');

const COMPATIBLE_VIDEO_CODECS = ['h264'];
const COMPATIBLE_AUDIO_CODECS = ['aac', 'mp3'];
const COMPATIBLE_CONTAINERS = ['.mp4', '.m4v'];

// Estado por clave ('<id>' para la pista de audio por defecto, o '<id>#a<index>'
// para una pista de audio concreta): 'checking' | 'compatible' | 'processing' | 'ready' | 'failed'
const status = new Map();
const progress = new Map(); // key -> { percent: 0-100 | null, startedAt: number }
const defaultAudioCache = new Map(); // video.id -> índice de la pista de audio por defecto

function outputFile(key) {
  return path.join(TRANSCODED_PATH, `${key.replace('#', '__')}.mp4`);
}

async function defaultAudioIndex(video) {
  if (defaultAudioCache.has(video.id)) return defaultAudioCache.get(video.id);
  const info = await getMediaInfo(video);
  const audioStreams = info.streams.filter((s) => s.codec_type === 'audio');
  const chosen = audioStreams.find((s) => s.disposition?.default === 1) || audioStreams[0];
  const index = chosen ? chosen.index : null;
  defaultAudioCache.set(video.id, index);
  return index;
}

async function resolveKey(video, audioIndex) {
  const defaultAudio = await defaultAudioIndex(video);
  const effectiveAudio = audioIndex != null ? Number(audioIndex) : defaultAudio;
  return effectiveAudio === defaultAudio ? video.id : `${video.id}#a${effectiveAudio}`;
}

// Se detecta una sola vez si la GPU (NVENC) funciona de verdad en este
// equipo probando una codificación mínima; si algo falla (sin GPU NVIDIA,
// controlador antiguo, etc.) se usa libx264 (CPU) para todo, sin más aviso.
let gpuAvailable = null;
function checkGpuAvailable() {
  if (gpuAvailable !== null) return Promise.resolve(gpuAvailable);
  return new Promise((resolve) => {
    fs.mkdirSync(TRANSCODED_PATH, { recursive: true });
    const checkFile = path.join(TRANSCODED_PATH, '.gpu-check.mp4');
    ffmpeg()
      .input('color=black:s=320x240:d=0.1')
      .inputFormat('lavfi')
      .videoCodec('h264_nvenc')
      .outputOptions(['-frames:v 1'])
      .format('mp4')
      .on('error', () => {
        gpuAvailable = false;
        fs.rm(checkFile, { force: true }, () => {});
        console.warn('GPU (NVENC) no disponible en este equipo: las conversiones usarán la CPU (más lentas).');
        resolve(false);
      })
      .on('end', () => {
        gpuAvailable = true;
        fs.rm(checkFile, { force: true }, () => {});
        console.log('GPU (NVENC) disponible: las conversiones que necesiten recodificar usarán la GPU.');
        resolve(true);
      })
      .save(checkFile);
  });
}

function buildOutputOptions({ videoCopy, audioCopy, audioMapIndex }, useGpu) {
  const outputOptions = [
    '-map 0:v:0',
    audioMapIndex != null ? `-map 0:${audioMapIndex}` : '-map 0:a:0?',
    `-c:v ${videoCopy ? 'copy' : useGpu ? 'h264_nvenc' : 'libx264'}`,
    `-c:a ${audioCopy ? 'copy' : 'aac'}`,
    '-movflags +faststart',
  ];
  if (!videoCopy) {
    // Fuentes de 10 bits (HDR/HEVC) deben bajarse a 8 bits: h264_nvenc no
    // codifica H.264 en 10 bits, y da igual mantenerlos para este uso.
    outputOptions.push('-pix_fmt yuv420p');
    outputOptions.push(...(useGpu ? ['-preset p4', '-rc vbr', '-cq 23'] : ['-preset veryfast', '-crf 23']));
  }
  return outputOptions;
}

// La conversión de ffmpeg actualmente en marcha (si hay alguna), para poder
// interrumpirla a propósito desde forcePriority().
let activeJob = null; // { key, command }

function runOnce(inputPath, tmpOutput, key, opts, useGpu) {
  return new Promise((resolve, reject) => {
    progress.set(key, { percent: null, startedAt: Date.now() });

    const command = ffmpeg(inputPath)
      .outputOptions(buildOutputOptions(opts, useGpu))
      .format('mp4')
      .on('progress', (p) => {
        if (typeof p.percent === 'number' && !Number.isNaN(p.percent)) {
          const entry = progress.get(key);
          progress.set(key, { ...entry, percent: Math.min(99, Math.max(0, Math.round(p.percent))) });
        }
      })
      .on('error', (err) => {
        progress.delete(key);
        const interrupted = activeJob?.key === key && activeJob.interrupted;
        activeJob = null;
        if (interrupted) {
          const tagged = new Error('Interrumpido para priorizar otro vídeo');
          tagged.interrupted = true;
          reject(tagged);
          return;
        }
        reject(err);
      })
      .on('end', () => {
        progress.delete(key);
        activeJob = null;
        resolve();
      });

    activeJob = { key, command, interrupted: false };
    command.save(tmpOutput);
  });
}

async function runFfmpegNow(inputPath, key, opts) {
  fs.mkdirSync(TRANSCODED_PATH, { recursive: true });
  const tmpOutput = `${outputFile(key)}.tmp.mp4`;
  const useGpu = !opts.videoCopy && (await checkGpuAvailable());

  try {
    await runOnce(inputPath, tmpOutput, key, opts, useGpu);
  } catch (err) {
    fs.rm(tmpOutput, { force: true }, () => {});
    if (err.interrupted) throw err;
    if (!useGpu) throw err;
    // La GPU ha fallado para este archivo en concreto (a menudo por tener ya
    // otra sesión NVENC abierta): reintenta con CPU en vez de fallar del todo.
    console.warn(`Fallo con GPU, reintentando con CPU: ${err.message}`);
    await runOnce(inputPath, tmpOutput, key, opts, false);
  }

  fs.renameSync(tmpOutput, outputFile(key));
}

// Cola global con dos carriles: como mucho una conversión de ffmpeg a la
// vez (para no agotar las sesiones NVENC de la GPU ni saturar CPU/disco),
// pero lo que el usuario está pidiendo ver AHORA ("high") adelanta a lo que
// el precalentamiento en segundo plano ("low") aún no ha empezado. Si ya
// hay una conversión en marcha, sigue su curso salvo que se pida
// explícitamente interrumpirla con forcePriority().
const ffmpegHighQueue = [];
const ffmpegLowQueue = [];
let ffmpegDraining = false;

async function drainFfmpegQueue() {
  if (ffmpegDraining) return;
  ffmpegDraining = true;
  while (ffmpegHighQueue.length || ffmpegLowQueue.length) {
    const task = ffmpegHighQueue.length ? ffmpegHighQueue.shift() : ffmpegLowQueue.shift();
    // eslint-disable-next-line no-await-in-loop
    await task.run();
  }
  ffmpegDraining = false;
}

function runFfmpeg(inputPath, key, opts, priority = 'low') {
  return new Promise((resolve, reject) => {
    const task = { key, run: () => runFfmpegNow(inputPath, key, opts).then(resolve, reject) };
    (priority === 'high' ? ffmpegHighQueue : ffmpegLowQueue).push(task);
    drainFfmpegQueue();
  });
}

// Interrumpe la conversión en marcha (si es de otro vídeo) y adelanta esta
// clave al principio de la cola, para que le toque el turno justo después.
function forcePriority(key) {
  if (activeJob && activeJob.key !== key) {
    activeJob.interrupted = true;
    activeJob.command.kill('SIGKILL');
  }

  const highIdx = ffmpegHighQueue.findIndex((t) => t.key === key);
  if (highIdx > 0) {
    const [task] = ffmpegHighQueue.splice(highIdx, 1);
    ffmpegHighQueue.unshift(task);
    return true;
  }

  const lowIdx = ffmpegLowQueue.findIndex((t) => t.key === key);
  if (lowIdx >= 0) {
    const [task] = ffmpegLowQueue.splice(lowIdx, 1);
    ffmpegHighQueue.unshift(task);
    return true;
  }

  return Boolean(activeJob) && activeJob.key === key;
}

async function ensureChecked(video, audioIndex = null, priority = 'low') {
  const defaultAudio = await defaultAudioIndex(video);
  const effectiveAudio = audioIndex != null ? Number(audioIndex) : defaultAudio;
  const useDefault = effectiveAudio === defaultAudio;
  const key = useDefault ? video.id : `${video.id}#a${effectiveAudio}`;

  const current = status.get(key);
  if (current) return current;

  if (fs.existsSync(outputFile(key))) {
    status.set(key, 'ready');
    return 'ready';
  }

  status.set(key, 'checking');

  const ext = path.extname(video.relativePath).toLowerCase();
  let info;
  try {
    info = await getMediaInfo(video);
  } catch (err) {
    console.warn(`No se pudo analizar "${video.title}": ${err.message}`);
    status.set(key, 'failed');
    return 'failed';
  }

  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.index === effectiveAudio);

  const videoOk = Boolean(videoStream) && COMPATIBLE_VIDEO_CODECS.includes(videoStream.codec_name);
  const audioOk = !audioStream || COMPATIBLE_AUDIO_CODECS.includes(audioStream.codec_name);
  const containerOk = COMPATIBLE_CONTAINERS.includes(ext);

  if (useDefault && videoOk && audioOk && containerOk) {
    status.set(key, 'compatible');
    return 'compatible';
  }

  status.set(key, 'processing');
  runFfmpeg(
    inputPathFor(video),
    key,
    {
      videoCopy: videoOk,
      audioCopy: audioOk,
      audioMapIndex: useDefault ? null : effectiveAudio,
    },
    priority
  )
    .then(() => status.set(key, 'ready'))
    .catch((err) => {
      if (err.interrupted) {
        // No se marca como fallida: se ha interrumpido a propósito para dar
        // paso a otro vídeo. Se reintenta sola en segundo plano (baja
        // prioridad) en vez de quedarse a medias para siempre.
        status.delete(key);
        ensureChecked(video, audioIndex, 'low');
        return;
      }
      console.warn(`No se pudo convertir "${video.title}": ${err.message}`);
      status.set(key, 'failed');
    });

  return 'processing';
}

// Interrumpe la conversión en marcha (si es de otro vídeo distinto) y
// adelanta este vídeo al principio de la cola. Solo tiene efecto si el
// vídeo ya está en curso de conversión ('processing'); si aún no se ha
// pedido, primero hay que llamar a ensureChecked.
async function forcePriorityFor(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  if (status.get(key) !== 'processing') return false;
  return forcePriority(key);
}

async function getStatus(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  return status.get(key) || 'unknown';
}

// Progreso de la conversión en curso (0-100, o null si aún no se puede
// estimar) y el tiempo transcurrido, para mostrar una barra de carga real.
async function getProgress(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  const entry = progress.get(key);
  if (!entry) return null;
  return { percent: entry.percent, elapsedMs: Date.now() - entry.startedAt };
}

async function playableFile(video, audioIndex = null) {
  const key = await resolveKey(video, audioIndex);
  const file = outputFile(key);
  return fs.existsSync(file) ? file : null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Precalienta en segundo plano los vídeos que necesiten conversión (pista de
// audio por defecto), de uno en uno para no saturar la CPU con varios
// ffmpeg a la vez. Así, cuando el usuario le da a play, muchos ya están
// listos en vez de tener que esperar la conversión en ese momento.
async function warmAll(videos) {
  for (const video of videos) {
    // eslint-disable-next-line no-await-in-loop
    const initial = await ensureChecked(video);
    if (initial === 'processing') {
      // eslint-disable-next-line no-await-in-loop
      while ((await getStatus(video)) === 'processing') {
        // eslint-disable-next-line no-await-in-loop
        await wait(2000);
      }
    }
  }
}

module.exports = { ensureChecked, getStatus, getProgress, playableFile, warmAll, forcePriorityFor };
