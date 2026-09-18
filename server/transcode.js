const fs = require('fs');
const path = require('path');
const { ffmpeg, getMediaInfo, inputPathFor } = require('./mediaInfo');
const { TRANSCODED_PATH } = require('./config');
const { runLimited } = require('./ffmpeg-limiter');
const { checkGpuAvailable } = require('./gpu');

// Estado por clave ('<id>' para la pista de audio por defecto, o '<id>#a<index>'
// para una pista de audio concreta): 'checking' | 'processing' | 'ready' | 'failed'
//
// El pipeline completo de conversión/sustitución del original (que usaba
// más estados aquí, como 'compatible') ya no se usa: la reproducción va
// toda por HLS (ver hls.js). Lo único vivo de este archivo es el remux
// rápido para poder elegir pista de audio en el modo "sin convertir"
// (?raw=1, ver routes/stream.js: ensureRawAudio/rawAudioProgress/rawAudioFile),
// que comparte la cola/ejecución de ffmpeg de abajo.
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
  // Se llama sin try/catch desde ensureRawAudio; un archivo corrupto o con
  // datos inválidos hace que ffprobe falle, y sin capturarlo aquí esa
  // excepción no cogida tumbaba todo el proceso de Node (ffprobe exited
  // with code 1).
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

// PQ (HDR10) o HLG: sin esto, un vídeo HDR recodificado a 8 bits SDR sale
// oscuro/apagado, porque el rango dinámico no se reduce, solo los bits.
function isHdrSource(videoStream) {
  const transfer = videoStream?.color_transfer;
  return transfer === 'smpte2084' || transfer === 'arib-std-b67';
}

// Un VBR sin techo puede meter picos de bitrate muy altos en escenas
// complejas; con un dispositivo de decodificación floja o una red Wi-Fi de
// por medio (Fire TV, sobre todo), eso es justo lo que provoca que se quede
// esperando datos/tirones, aunque la media del archivo sea razonable. Se
// pone un techo (maxrate/bufsize) según la resolución de origen, generoso
// pero acotado, en vez de dejarlo sin límite.
function bitrateCapFor(sourceHeight) {
  if (!sourceHeight || sourceHeight <= 480) return { maxrate: '2500k', bufsize: '5000k' };
  if (sourceHeight <= 720) return { maxrate: '4500k', bufsize: '9000k' };
  if (sourceHeight <= 1080) return { maxrate: '8000k', bufsize: '16000k' };
  if (sourceHeight <= 1440) return { maxrate: '12000k', bufsize: '24000k' };
  return { maxrate: '20000k', bufsize: '40000k' };
}

function buildOutputOptions({ videoCopy, audioCopy, audioMapIndex, hdr, sourceHeight }, useGpu, format = 'mp4') {
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
    // p2 (rápido) en vez de p4 (medio): esto es una conversión de
    // compatibilidad puntual para reproducir en el dispositivo, no un
    // archivo para archivar, así que merece la pena priorizar velocidad
    // sobre exprimir la máxima calidad/tamaño por bit.
    if (useGpu) {
      const { maxrate, bufsize } = bitrateCapFor(sourceHeight);
      outputOptions.push('-preset p2', '-rc vbr', '-cq 23', `-maxrate ${maxrate}`, `-bufsize ${bufsize}`);
    } else {
      outputOptions.push('-preset veryfast', '-crf 23');
    }
  }
  return outputOptions;
}

// Se probó con 3 conversiones a la vez asumiendo que los drivers NVENC
// actuales lo permiten en GPUs de consumo (cierto en general), pero en la
// práctica esta GPU en concreto no aguantaba 3 sesiones NVENC reales a la
// vez: fallaba en cascada ("Generic error in an external library") y, al
// caer TODAS a la CPU (libx264) al mismo tiempo, saturaba la máquina entera
// hasta dejar el servidor sin responder. Vuelta a 1 por estabilidad: es un
// límite real del hardware/driver de esta GPU, no algo que se pueda ajustar
// solo con código.
const MAX_CONCURRENT_JOBS = 1;

// Los trabajos de ffmpeg en marcha ahora mismo (puede haber varios a la
// vez), por clave.
const activeJobs = new Map(); // key -> { key, command, interrupted, meta, priority }

function runOnce(inputPath, tmpOutput, key, opts, useGpu, format = 'mp4', meta = null, priority = 'low') {
  // Además del propio tope interno (MAX_CONCURRENT_JOBS), pasa también por
  // el límite global compartido con trickplay/carátulas: así el techo real
  // de procesos ffmpeg a la vez en toda la app nunca se puede superar,
  // aunque en el futuro se vuelva a subir MAX_CONCURRENT_JOBS.
  return runLimited(() => runOnceUnthrottled(inputPath, tmpOutput, key, opts, useGpu, format, meta, priority));
}

function runOnceUnthrottled(inputPath, tmpOutput, key, opts, useGpu, format, meta, priority) {
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
        const interrupted = activeJobs.get(key)?.interrupted;
        activeJobs.delete(key);
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
        activeJobs.delete(key);
        resolve();
      });

    activeJobs.set(key, { key, command, interrupted: false, meta, priority });
    command.save(tmpOutput);
  });
}

async function runFfmpegNow(inputPath, key, opts, meta, priority) {
  fs.mkdirSync(TRANSCODED_PATH, { recursive: true });
  const ext = opts.outputExt || '.mp4';
  const format = opts.outputFormat || 'mp4';
  const tmpOutput = `${outputFile(key, ext)}.tmp${ext}`;
  const useGpu = !opts.videoCopy && (await checkGpuAvailable(TRANSCODED_PATH));

  try {
    await runOnce(inputPath, tmpOutput, key, opts, useGpu, format, meta, priority);
  } catch (err) {
    fs.rm(tmpOutput, { force: true }, () => {});
    if (err.interrupted) throw err;
    if (!useGpu) throw err;
    // La GPU ha fallado para este archivo en concreto (a menudo por tener ya
    // demasiadas sesiones NVENC abiertas a la vez): reintenta con CPU en vez
    // de fallar del todo.
    console.warn(`Fallo con GPU, reintentando con CPU: ${err.message}`);
    await runOnce(inputPath, tmpOutput, key, opts, false, format, meta, priority);
  }

  fs.renameSync(tmpOutput, outputFile(key, ext));
}

// Cola con dos carriles: lo que el usuario está pidiendo ver AHORA ("high")
// adelanta a lo que el precalentamiento en segundo plano ("low") aún no ha
// empezado. Hasta MAX_CONCURRENT_JOBS conversiones a la vez en vez de una
// sola.
const ffmpegHighQueue = [];
const ffmpegLowQueue = [];

function drainFfmpegQueue() {
  while (activeJobs.size < MAX_CONCURRENT_JOBS && (ffmpegHighQueue.length || ffmpegLowQueue.length)) {
    const task = ffmpegHighQueue.length ? ffmpegHighQueue.shift() : ffmpegLowQueue.shift();
    task.run().finally(() => drainFfmpegQueue());
  }
}

function runFfmpeg(inputPath, key, opts, priority = 'low', meta = null) {
  return new Promise((resolve, reject) => {
    const task = {
      key,
      meta,
      priority,
      run: () => runFfmpegNow(inputPath, key, opts, meta, priority).then(resolve, reject),
    };
    (priority === 'high' ? ffmpegHighQueue : ffmpegLowQueue).push(task);
    drainFfmpegQueue();
  });
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

module.exports = {
  ensureRawAudio,
  rawAudioProgress,
  rawAudioFile,
};
