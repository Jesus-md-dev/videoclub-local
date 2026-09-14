const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ffmpeg, getMediaInfo, inputPathFor } = require('./mediaInfo');
const { HLS_PATH } = require('./config');
const { runLimited } = require('./ffmpeg-limiter');
const subtitles = require('./subtitles');
const trickplay = require('./trickplay');
const archivedVideos = require('./archivedVideos');

// Issue #58/#59/#61 del plan HLS: generación + estado/progreso/prioridad.
// Las rutas HTTP están en routes/hls.js, el reproductor (#60) en el cliente.

const COMPATIBLE_VIDEO_CODECS = ['h264'];
const SEGMENT_SECONDS = 6;

function isTenBit(videoStream) {
  return Boolean(videoStream?.pix_fmt?.includes('10')) || videoStream?.profile === 'High 10';
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function outDirFor(video) {
  return path.join(HLS_PATH, video.id);
}

function masterPlaylistFor(video) {
  return path.join(outDirFor(video), 'master.m3u8');
}

const LANGUAGE_NAMES = {
  spa: 'Español',
  eng: 'Inglés',
  jpn: 'Japonés',
  fre: 'Francés',
  fra: 'Francés',
  ger: 'Alemán',
  deu: 'Alemán',
  ita: 'Italiano',
  por: 'Portugués',
};

// El nombre de variante acaba tal cual dentro de "-var_stream_map" (que usa
// espacios para separar variantes y comas para separar atributos dentro de
// cada una) y, vía %v, como nombre de carpeta. Un título de pista con
// espacio, coma o comilla (metadatos del propio archivo, no de fiar: p.ej.
// el respaldo "Pista 1" cuando no hay idioma, o un título así puesto por
// quien codificó el archivo) rompía el parseo de ffmpeg y hacía fallar la
// generación entera con un error opaco ("Nothing was written..."), sin
// relación aparente con la causa real - visto en directo con una película
// sin idioma en su única pista de audio.
function sanitizeLabel(text) {
  return text.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'audio';
}

function labelFor(stream, fallbackIndex) {
  const lang = stream.tags?.language;
  const raw = (lang && LANGUAGE_NAMES[lang]) || stream.tags?.title || lang || `Pista${fallbackIndex + 1}`;
  return sanitizeLabel(raw);
}

// Detección de GPU (NVENC) igual que transcode.js: se prueba una vez y se
// reutiliza el resultado; si falla, todas las codificaciones caen a CPU.
let gpuAvailable = null;
let gpuCheckPromise = null;
function checkGpuAvailable() {
  if (gpuAvailable !== null) return Promise.resolve(gpuAvailable);
  if (gpuCheckPromise) return gpuCheckPromise;
  gpuCheckPromise = new Promise((resolve) => {
    fs.mkdirSync(HLS_PATH, { recursive: true });
    const checkFile = path.join(HLS_PATH, '.gpu-check.mp4');
    ffmpeg()
      .input('color=black:s=320x240:d=0.1')
      .inputFormat('lavfi')
      .videoCodec('h264_nvenc')
      .outputOptions(['-frames:v 1'])
      .format('mp4')
      .on('error', () => {
        gpuAvailable = false;
        fs.rm(checkFile, { force: true }, () => {});
        resolve(false);
      })
      .on('end', () => {
        gpuAvailable = true;
        fs.rm(checkFile, { force: true }, () => {});
        resolve(true);
      })
      .save(checkFile);
  });
  return gpuCheckPromise;
}

// Construye el "-var_stream_map" que le dice al muxer HLS de ffmpeg cómo
// agrupar las salidas: una variante de vídeo (sin audio) + una variante de
// solo-audio por cada pista, todas en el mismo grupo "aud" para que el
// reproductor las ofrezca como pistas de audio alternativas del mismo vídeo.
// Importante: este valor lleva espacios DENTRO de un único argumento de
// ffmpeg (uno por cada variante) — ver la nota en runFfmpegHls sobre por
// qué esto no se puede montar con fluent-ffmpeg.
function buildVarStreamMap(audioStreams, defaultIndex) {
  const parts = ['v:0,agroup:aud'];
  audioStreams.forEach((stream, i) => {
    const attrs = [`a:${i}`, 'agroup:aud', `name:${labelFor(stream, i)}`];
    const lang = stream.tags?.language;
    if (lang) attrs.push(`language:${sanitizeLabel(lang)}`);
    if (i === defaultIndex) attrs.push('default:yes');
    parts.push(attrs.join(','));
  });
  return parts.join(' ');
}

// "time=01:23:45.67" en la salida de ffmpeg -> segundos.
const TIME_RE = /time=(\d+):(\d+):(\d+\.\d+)/;
function parseProgressSeconds(chunk) {
  const match = TIME_RE.exec(chunk);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// Se usa child_process.spawn directamente (no fluent-ffmpeg) para este
// comando en concreto: fluent-ffmpeg parte cada opción por espacios de
// forma poco fiable (con arreglos, no shell), y el valor de
// "-var_stream_map" necesita viajar como un único argumento aunque
// contenga espacios (uno separando cada variante). Con spawn + un array de
// argumentos no hay ambigüedad: cada elemento es un argv exacto.
function runFfmpegHls(inputPath, outDir, { audioStreams, defaultIndex, videoCopy, useGpu, durationSeconds, onProgress }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });

    const args = ['-y', '-i', inputPath, '-map', '0:v:0'];
    audioStreams.forEach((stream) => {
      args.push('-map', `0:${stream.index}`);
    });

    args.push('-c:v', videoCopy ? 'copy' : useGpu ? 'h264_nvenc' : 'libx264');
    if (!videoCopy) {
      if (useGpu) {
        args.push('-preset', 'p4', '-rc', 'vbr', '-cq', '23');
      } else {
        args.push('-preset', 'veryfast', '-crf', '23');
      }
      args.push('-pix_fmt', 'yuv420p');
    }
    args.push(
      '-c:a', 'aac',
      '-b:a', '160k',
      '-f', 'hls',
      '-hls_time', String(SEGMENT_SECONDS),
      '-hls_playlist_type', 'vod',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', buildVarStreamMap(audioStreams, defaultIndex),
      // Con "/" a propósito, no path.join: ffmpeg calcula a partir de estas
      // rutas las URIs relativas que escribe dentro del .m3u8, y esas son
      // URLs (las sirve el navegador), no rutas de Windows — con "\" el
      // manifiesto queda inválido (el reproductor no encuentra el archivo).
      '-hls_segment_filename', `${toPosix(outDir)}/%v/seg_%03d.ts`,
      `${toPosix(outDir)}/%v/prog.m3u8`
    );

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 8000) stderr = stderr.slice(-8000); // no acumular sin límite
      if (onProgress && durationSeconds) {
        const seconds = parseProgressSeconds(text);
        if (seconds != null) onProgress(Math.min(99, Math.max(0, Math.round((seconds / durationSeconds) * 100))));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (HLS) salió con código ${code}: ${stderr.split('\n').slice(-5).join(' ')}`));
    });
  });
}

// Estado por video.id: 'checking' | 'processing' | 'ready' | 'failed'.
// 'ready' también se puede inferir de que exista master.m3u8 en disco
// (p.ej. tras un reinicio del servidor, sin pasar otra vez por 'processing').
const status = new Map();
const progress = new Map(); // video.id -> { percent: 0-99 | null, startedAt }

function getStatus(video) {
  if (fs.existsSync(masterPlaylistFor(video))) return 'ready';
  return status.get(video.id) || 'unknown';
}

// El cliente (WatchPage.jsx, formatRemaining) calcula el tiempo restante a
// partir de "elapsedMs" (mismo formato que ya usaba el pipeline antiguo):
// sin esto, la resta salía NaN y el mensaje "preparando..." mostraba
// "~NaNm NaNs restantes" en vez del tiempo estimado.
function getProgress(video) {
  const entry = progress.get(video.id);
  if (!entry) return null;
  return { percent: entry.percent, elapsedMs: Date.now() - entry.startedAt };
}

// Arranca la generación si hace falta (no bloquea: se lanza en segundo
// plano) y devuelve el estado actual al instante, para poder ofrecer una
// pantalla de "preparando..." igual que ya hace /api/stream/:id/status con
// el pipeline antiguo. 'priority': 'high' para quien le ha dado a play
// ahora mismo (adelanta en la cola compartida de ffmpeg al precalentamiento
// en segundo plano), 'low' en caso contrario.
function ensureGenerating(video, priority = 'low') {
  if (fs.existsSync(masterPlaylistFor(video))) {
    status.set(video.id, 'ready');
    return 'ready';
  }

  const current = status.get(video.id);
  if (current === 'checking' || current === 'processing' || current === 'failed') return current;

  status.set(video.id, 'checking');
  runGeneration(video, priority).catch(() => {}); // el estado ya queda registrado dentro
  return 'checking';
}

async function runGeneration(video, priority) {
  const outDir = outDirFor(video);
  const master = masterPlaylistFor(video);

  try {
    const info = await getMediaInfo(video);
    const videoStream = info.streams.find((s) => s.codec_type === 'video');
    const audioStreams = info.streams.filter((s) => s.codec_type === 'audio');
    if (!videoStream) throw new Error('El archivo no tiene pista de vídeo.');
    if (audioStreams.length === 0) throw new Error('El archivo no tiene ninguna pista de audio.');

    const defaultIndex = Math.max(
      0,
      audioStreams.findIndex((s) => s.disposition?.default === 1)
    );
    const durationSeconds = Number(info.format?.duration) || null;

    const videoCopy = COMPATIBLE_VIDEO_CODECS.includes(videoStream.codec_name) && !isTenBit(videoStream);
    const useGpu = !videoCopy && (await checkGpuAvailable());

    status.set(video.id, 'processing');
    progress.set(video.id, { percent: videoCopy ? null : 0, startedAt: Date.now() });
    const onProgress = (percent) => {
      const entry = progress.get(video.id);
      progress.set(video.id, { ...entry, percent });
    };

    const tmpDir = `${outDir}.tmp`;

    // Un archivo grande en un disco externo puede fallar de forma puntual
    // (contención de E/S, la GPU ya saturada por otra sesión NVENC a la
    // vez...), no solo por estar realmente mal formado - visto en directo
    // con una película 4K que falló así y, al repetir el mismo comando
    // suelto un momento después, funcionó sin cambiar nada. GPU una vez (si
    // hay) y CPU hasta dos veces más antes de darse por vencido, en vez de
    // marcarlo como fallido para siempre a la primera.
    const attempts = useGpu ? [true, false, false] : [false, false, false];
    let lastErr;
    for (let i = 0; i < attempts.length; i += 1) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      try {
        // eslint-disable-next-line no-await-in-loop
        await runLimited(
          () => runFfmpegHls(inputPathFor(video), tmpDir, { audioStreams, defaultIndex, videoCopy, useGpu: attempts[i], durationSeconds, onProgress }),
          priority
        );
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(
          `HLS: fallo con ${attempts[i] ? 'GPU' : 'CPU'} para "${video.title}" (intento ${i + 1}/${attempts.length}): ${err.message}`
        );
        if (i < attempts.length - 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    if (lastErr) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw lastErr;
    }

    // ffmpeg puede terminar con éxito (código 0) y aun así el rename
    // fallar con ENOENT justo después - visto en directo en un disco
    // externo, sin relación con nada del comando en sí (el tmpDir estaba
    // vacío/no existía ya en el momento del rename, probablemente por un
    // hueco de E/S del propio disco). Un par de reintentos cortos antes de
    // darse por vencido, en vez de tirar todo el trabajo de ffmpeg ya
    // hecho por un fallo de mover la carpeta.
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, outDir);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        console.warn(`HLS: fallo moviendo el resultado de "${video.title}" (intento ${attempt}/3): ${err.message}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    status.set(video.id, 'ready');
    progress.delete(video.id);

    // Solo cuando el original ya era H.264 compatible: ahí el HLS es un
    // simple remux, el mismo vídeo dos veces en disco. En segundo plano
    // (no bloquea el "ready", ya se puede reproducir) para no hacer
    // esperar al primer play por esto.
    if (videoCopy) {
      archiveIfCompatible(video).catch((err) => {
        console.warn(`HLS: no se pudo archivar "${video.title}": ${err.message}`);
      });
    }

    return master;
  } catch (err) {
    console.warn(`HLS: no se pudo generar "${video.title}": ${err.message}`);
    status.set(video.id, 'failed');
    progress.delete(video.id);
    throw err;
  }
}

// Antes de borrar el original: guarda aparte, de forma permanente (no
// caché de sesión), lo que depende de él y que si no se perdería para
// siempre - subtítulos y la vista previa de arrastre en la barra de
// progreso. El listado de pistas (audio/subtítulos) no hace falta
// pre-generarlo: ya queda cacheado el análisis de ffprobe (codec-checks.json,
// ver mediaInfo.js) desde la generación del HLS.
async function archiveIfCompatible(video) {
  const info = await getMediaInfo(video);
  const subtitleStreams = info.streams.filter((s) => s.codec_type === 'subtitle');
  for (const stream of subtitleStreams) {
    // eslint-disable-next-line no-await-in-loop
    await subtitles.extractSubtitle(video, stream.index).catch((err) => {
      console.warn(`HLS: no se pudo extraer el subtítulo ${stream.index} de "${video.title}" antes de archivar: ${err.message}`);
    });
  }
  await trickplay.ensureTrickplay(video);

  const originalPath = inputPathFor(video);
  // El disco externo puede tener hipos puntuales (visto en directo: un
  // fs.rm que no dio error pero el archivo seguía ahí después). No basta
  // con fiarse de que fs.rm no fallara: hay que comprobar que el original
  // ha desaparecido de verdad antes de registrarlo como archivado - si no,
  // se pierde el rastro de un original que en realidad sigue ahí, con el
  // espacio sin liberar y el catálogo sin saberlo.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      fs.rmSync(originalPath, { force: true });
    } catch (err) {
      console.warn(`HLS: fallo borrando el original de "${video.title}" (intento ${attempt}/3): ${err.message}`);
    }
    if (!fs.existsSync(originalPath)) {
      archivedVideos.archive(video);
      console.log(`HLS: original de "${video.title}" borrado (el HLS ya es el mismo vídeo, sin duplicarlo)`);
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn(`HLS: no se pudo confirmar el borrado del original de "${video.title}" tras varios intentos; se deja tal cual (con los dos)`);
}

// Genera (si hace falta, esperando a que termine) y devuelve la ruta al
// master.m3u8. Para servirlo bajo demanda cuando ya se sabe que está listo
// (o se está dispuesto a esperar); las rutas normales usan ensureGenerating
// + getStatus para no bloquear la petición mientras tanto.
async function generateHls(video, priority = 'low') {
  const master = masterPlaylistFor(video);
  if (fs.existsSync(master)) return master;
  ensureGenerating(video, priority);
  // Reutiliza el mismo runGeneration en marcha en vez de lanzar otro.
  while (getStatus(video) !== 'ready') {
    if (getStatus(video) === 'failed') throw new Error('No se pudo generar el HLS de este vídeo.');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
  return master;
}

// Precalienta en segundo plano toda la biblioteca, uno detrás de otro (no
// todos a la vez), en prioridad 'low': si alguien le da a play mientras
// tanto, esa petición 'high' adelanta en la cola compartida de ffmpeg (ver
// ffmpeg-limiter.js) y se sirve antes, sin esperar a que termine el
// precalentamiento. Así lo ya generado está listo al momento y lo demás se
// va poniendo al día solo, sin perder la prioridad de "quien está viendo
// ahora" que tenía sentido quitarle al pipeline antiguo (#61).
// Un reescaneo automático puede llamar a esto mientras la pasada anterior
// sigue en marcha (mismo motivo que el guard de metadata.js): sin esto, se
// acumulaban pasadas paralelas todas recorriendo la biblioteca entera
// detrás de la primera sin aportar nada.
let warming = false;
async function warmAll(videos) {
  if (warming) return;
  warming = true;
  const ordered = [...videos].sort((a, b) => (a.size || 0) - (b.size || 0));
  try {
    for (const video of ordered) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await generateHls(video, 'low');
      } catch (err) {
        console.warn(`HLS: no se pudo precalentar "${video.title}": ${err.message}`);
      }
    }
  } finally {
    warming = false;
  }
}

module.exports = { generateHls, ensureGenerating, getStatus, getProgress, warmAll, outDirFor, masterPlaylistFor };
