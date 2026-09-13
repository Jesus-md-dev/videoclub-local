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

function outputFile(key, ext = '.mp4') {
  return path.join(TRANSCODED_PATH, `${key.replace('#', '__')}${ext}`);
}

const CONTAINER_FORMATS = {
  '.mkv': 'matroska',
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.avi': 'avi',
  '.mov': 'mov',
  '.webm': 'webm',
};

// Al arrancar, cualquier ".tmp.*" que quede en la carpeta de convertidos es
// forzosamente de una conversión que no llegó a terminar (murió con el
// proceso anterior: solo hay una conversión de ffmpeg a la vez y este
// proceso acaba de empezar). Sin limpiarlos se quedan acumulando para
// siempre, aunque nunca se sirvan ni se retomen.
function cleanupStaleTmpFiles() {
  let entries;
  try {
    entries = fs.readdirSync(TRANSCODED_PATH);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.includes('.tmp.')) continue;
    const full = path.join(TRANSCODED_PATH, name);
    fs.rm(full, { force: true }, (err) => {
      if (err) console.warn(`No se pudo borrar el archivo temporal "${name}": ${err.message}`);
      else console.log(`Conversión sin terminar (proceso anterior interrumpido), borrado: ${name}`);
    });
  }
}
cleanupStaleTmpFiles();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Un archivo puede fallar en ffprobe de forma transitoria (bloqueado un
// instante por el antivirus, otro proceso leyéndolo a la vez, un recurso de
// red que tarda en responder...), no solo por estar realmente corrupto.
// Reintentar unas pocas veces con espera evita marcar como "fallido" para
// siempre algo que un segundo después ya se puede leer sin problema.
async function getMediaInfoWithRetries(video, attempts = 3, delayMs = 1200) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await getMediaInfo(video);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // eslint-disable-next-line no-await-in-loop
        await wait(delayMs);
      }
    }
  }
  throw lastErr;
}

async function defaultAudioIndex(video) {
  if (defaultAudioCache.has(video.id)) return defaultAudioCache.get(video.id);
  // Se llama sin try/catch desde varios sitios (ensureChecked, resolveKey,
  // ensureRawAudio...); un archivo corrupto o con datos inválidos hace que
  // ffprobe falle, y sin capturarlo aquí esa excepción no cogida tumbaba
  // todo el proceso de Node (ffprobe exited with code 1).
  let index = null;
  try {
    const info = await getMediaInfoWithRetries(video);
    const audioStreams = info.streams.filter((s) => s.codec_type === 'audio');
    const chosen = audioStreams.find((s) => s.disposition?.default === 1) || audioStreams[0];
    index = chosen ? chosen.index : null;
  } catch (err) {
    console.warn(`No se pudo analizar "${video.title}": ${err.message}`);
  }
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

// PQ (HDR10) o HLG: sin esto, un vídeo HDR recodificado a 8 bits SDR sale
// oscuro/apagado, porque el rango dinámico no se reduce, solo los bits.
function isHdrSource(videoStream) {
  const transfer = videoStream?.color_transfer;
  return transfer === 'smpte2084' || transfer === 'arib-std-b67';
}

function buildOutputOptions({ videoCopy, audioCopy, audioMapIndex, hdr }, useGpu, format = 'mp4') {
  const outputOptions = [
    '-map 0:v:0',
    audioMapIndex != null ? `-map 0:${audioMapIndex}` : '-map 0:a:0?',
    `-c:v ${videoCopy ? 'copy' : useGpu ? 'h264_nvenc' : 'libx264'}`,
    `-c:a ${audioCopy ? 'copy' : 'aac'}`,
  ];
  // +faststart es una opción propia del muxer mov/mp4; con otros
  // contenedores (matroska, etc.) ffmpeg la rechaza.
  if (format === 'mp4') outputOptions.push('-movflags +faststart');
  if (!videoCopy) {
    if (hdr) {
      outputOptions.push(
        '-vf zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'
      );
    } else {
      // Fuentes de 10 bits sin HDR deben bajarse a 8 bits igualmente:
      // h264_nvenc no codifica H.264 en 10 bits.
      outputOptions.push('-pix_fmt yuv420p');
    }
    outputOptions.push(...(useGpu ? ['-preset p4', '-rc vbr', '-cq 23'] : ['-preset veryfast', '-crf 23']));
  }
  return outputOptions;
}

// La conversión de ffmpeg actualmente en marcha (si hay alguna), para poder
// interrumpirla a propósito desde forcePriority().
let activeJob = null; // { key, command, meta }

function runOnce(inputPath, tmpOutput, key, opts, useGpu, format = 'mp4', meta = null) {
  return new Promise((resolve, reject) => {
    progress.set(key, { percent: null, startedAt: Date.now() });

    const command = ffmpeg(inputPath);
    if (useGpu) {
      // Descodifica también por GPU (no solo codifica): sin esto, un origen
      // pesado (AV1/HEVC 4K) se descodifica por CPU y ese es el cuello de
      // botella real, aunque la codificación ya use NVENC. Con NVDEC en la
      // descodificación también, la conversión completa va ~3-4x más rápido.
      command.inputOptions(['-hwaccel cuda']);
    }
    command
      .outputOptions(buildOutputOptions(opts, useGpu, format))
      .format(format)
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

    activeJob = { key, command, interrupted: false, meta };
    command.save(tmpOutput);
  });
}

async function runFfmpegNow(inputPath, key, opts, meta) {
  fs.mkdirSync(TRANSCODED_PATH, { recursive: true });
  const ext = opts.outputExt || '.mp4';
  const format = opts.outputFormat || 'mp4';
  const tmpOutput = `${outputFile(key, ext)}.tmp${ext}`;
  const useGpu = !opts.videoCopy && (await checkGpuAvailable());

  try {
    await runOnce(inputPath, tmpOutput, key, opts, useGpu, format, meta);
  } catch (err) {
    fs.rm(tmpOutput, { force: true }, () => {});
    if (err.interrupted) throw err;
    if (!useGpu) throw err;
    // La GPU ha fallado para este archivo en concreto (a menudo por tener ya
    // otra sesión NVENC abierta): reintenta con CPU en vez de fallar del todo.
    console.warn(`Fallo con GPU, reintentando con CPU: ${err.message}`);
    await runOnce(inputPath, tmpOutput, key, opts, false, format, meta);
  }

  fs.renameSync(tmpOutput, outputFile(key, ext));
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

function runFfmpeg(inputPath, key, opts, priority = 'low', meta = null) {
  return new Promise((resolve, reject) => {
    const task = { key, meta, run: () => runFfmpegNow(inputPath, key, opts, meta).then(resolve, reject) };
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
  // Atajo para el caso más común (pista por defecto): si el archivo ya
  // convertido sigue en disco, no hace falta ni ffprobe ni resolver el
  // índice de audio por defecto. Sin esto, cada reinicio del servidor (el
  // estado en memoria se pierde, pero los archivos convertidos no)
  // obligaba a repetir ffprobe en TODA la biblioteca, incluidos los vídeos
  // que ya estaban listos desde hace tiempo.
  if (audioIndex == null) {
    const quickKey = video.id;
    const quickCurrent = status.get(quickKey);
    if (quickCurrent) return quickCurrent;
    if (fs.existsSync(outputFile(quickKey))) {
      status.set(quickKey, 'ready');
      return 'ready';
    }
  }

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
    info = await getMediaInfoWithRetries(video);
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
      hdr: isHdrSource(videoStream),
    },
    priority,
    { id: video.id, title: video.title, size: video.size }
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

// Igual que getStatus pero sin comprobar nada nuevo (para pintar el catálogo
// al instante): la pista por defecto siempre usa `video.id` como clave, así
// que no hace falta resolver de forma asíncrona.
function peekStatus(video) {
  return status.get(video.id) || 'unknown';
}

// Para el catálogo: distingue entre "convirtiéndose ahora mismo" (el único
// trabajo de ffmpeg activo) y "en cola, pendiente de conversión" (ya se sabe
// que la necesita, pero le toca esperar su turno porque solo hay una
// conversión a la vez). 'unknown'/'checking' significa que aún no se sabe
// (warmAll no ha llegado a comprobarlo todavía).
function peekProcessingState(video) {
  const key = video.id;
  if (status.get(key) !== 'processing') return null;
  return activeJob && activeJob.key === key ? 'active' : 'queued';
}

// Porcentaje (0-100) de la conversión en curso ahora mismo para esta pista
// por defecto, o null si no está activa (en cola pero sin empezar, o no
// necesita conversión). Para pintar el catálogo sin bloquear.
function peekProgressPercent(video) {
  const entry = progress.get(video.id);
  return entry && typeof entry.percent === 'number' ? entry.percent : null;
}

// Foto instantánea de la cola de conversión real (para una página de
// estado): el trabajo activo ahora mismo y el resto en el orden exacto en
// que les tocará su turno (alta prioridad primero, luego baja).
function getQueueSnapshot() {
  const active = activeJob
    ? {
        key: activeJob.key,
        ...activeJob.meta,
        percent: progress.get(activeJob.key)?.percent ?? null,
      }
    : null;
  const queued = [...ffmpegHighQueue, ...ffmpegLowQueue].map((task, index) => ({
    key: task.key,
    ...task.meta,
    position: index + 1,
  }));
  return { active, queued };
}

// Claves marcadas como 'failed' (no se pudieron analizar o convertir), para
// poder revisarlas desde la página de estado.
function getFailedKeys() {
  return [...status.entries()].filter(([, value]) => value === 'failed').map(([key]) => key);
}

// En modo "sin convertir" (?raw=1) se sirve el archivo tal cual, así que el
// navegador solo reproduce la pista de audio que trae por defecto: cambiar
// de idioma no tiene ningún efecto (la mayoría de navegadores no exponen las
// demás pistas embebidas de un contenedor como .mkv para elegir entre
// ellas). Para que el selector de idioma funcione también en este modo, se
// hace un remux rápido (solo copia, sin recodificar nada) que se queda
// únicamente con la pista de audio elegida.
function rawAudioKey(video, audioIndex) {
  return `${video.id}__rawaudio_a${audioIndex}`;
}

function rawAudioExt(video) {
  return path.extname(video.relativePath).toLowerCase() || '.mkv';
}

async function ensureRawAudio(video, audioIndex) {
  const defaultAudio = await defaultAudioIndex(video);
  const effectiveAudio = audioIndex != null ? Number(audioIndex) : defaultAudio;
  if (effectiveAudio === defaultAudio) return 'original';

  const key = rawAudioKey(video, effectiveAudio);
  const current = status.get(key);
  if (current) return current;

  const ext = rawAudioExt(video);
  if (fs.existsSync(outputFile(key, ext))) {
    status.set(key, 'ready');
    return 'ready';
  }

  status.set(key, 'processing');
  runFfmpeg(
    inputPathFor(video),
    key,
    {
      videoCopy: true,
      audioCopy: true,
      audioMapIndex: effectiveAudio,
      hdr: false,
      outputExt: ext,
      outputFormat: CONTAINER_FORMATS[ext] || 'matroska',
    },
    'high',
    { id: video.id, title: video.title, size: video.size }
  )
    .then(() => status.set(key, 'ready'))
    .catch((err) => {
      if (err.interrupted) {
        status.delete(key);
        return;
      }
      console.warn(`No se pudo cambiar de idioma (remux) para "${video.title}": ${err.message}`);
      status.set(key, 'failed');
    });

  return 'processing';
}

function rawAudioProgress(video, audioIndex) {
  const key = rawAudioKey(video, Number(audioIndex));
  const entry = progress.get(key);
  if (!entry) return null;
  return { percent: entry.percent, elapsedMs: Date.now() - entry.startedAt };
}

function rawAudioFile(video, audioIndex) {
  const key = rawAudioKey(video, Number(audioIndex));
  const file = outputFile(key, rawAudioExt(video));
  return fs.existsSync(file) ? file : null;
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

// Comprueba (pista de audio por defecto) todos los vídeos del catálogo en
// segundo plano, para que el catálogo pueda marcar cuanto antes cuáles
// necesitan conversión. La comprobación en sí (ffprobe) es rápida: no espera
// a que cada conversión real termine antes de pasar al siguiente vídeo, eso
// ya lo serializa la cola de ffmpeg (ensureChecked encola el trabajo y
// vuelve al momento). Antes esta función sí esperaba a que cada conversión
// acabase antes de comprobar el siguiente, así que con una cola de miles de
// vídeos casi ninguno llegaba a comprobarse de verdad.
async function warmAll(videos) {
  // Sin nada forzado explícitamente (forcePriorityFor, al abrir un vídeo
  // concreto), el precalentamiento en segundo plano prioriza los archivos
  // más ligeros primero: se terminan muchos antes y hay más contenido listo
  // para ver cuanto antes, en vez de tardar mucho en el primero.
  const ordered = [...videos].sort((a, b) => (a.size || 0) - (b.size || 0));
  for (const video of ordered) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await ensureChecked(video);
    } catch (err) {
      // No debería llegar aquí (ensureChecked ya captura sus propios
      // errores), pero un fallo inesperado en un vídeo no debe impedir
      // comprobar el resto de la biblioteca.
      console.warn(`Error al precalentar "${video.title}": ${err.message}`);
    }
  }
}

module.exports = {
  ensureChecked,
  getStatus,
  peekStatus,
  peekProcessingState,
  peekProgressPercent,
  getProgress,
  playableFile,
  warmAll,
  forcePriorityFor,
  ensureRawAudio,
  rawAudioProgress,
  rawAudioFile,
  getQueueSnapshot,
  getFailedKeys,
};
