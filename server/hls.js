const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ffmpeg, getMediaInfo, inputPathFor } = require('./mediaInfo');
const { HLS_PATH } = require('./config');
const { runLimited } = require('./ffmpeg-limiter');

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

function labelFor(stream, fallbackIndex) {
  const lang = stream.tags?.language;
  return (lang && LANGUAGE_NAMES[lang]) || stream.tags?.title || lang || `Pista ${fallbackIndex + 1}`;
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
    if (stream.tags?.language) attrs.push(`language:${stream.tags.language}`);
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

function getProgress(video) {
  return progress.get(video.id) || null;
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
    fs.rmSync(tmpDir, { recursive: true, force: true });

    try {
      await runLimited(
        () => runFfmpegHls(inputPathFor(video), tmpDir, { audioStreams, defaultIndex, videoCopy, useGpu, durationSeconds, onProgress }),
        priority
      );
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (!useGpu) throw err;
      console.warn(`HLS: fallo con GPU para "${video.title}", reintentando con CPU: ${err.message}`);
      await runLimited(
        () => runFfmpegHls(inputPathFor(video), tmpDir, { audioStreams, defaultIndex, videoCopy, useGpu: false, durationSeconds, onProgress }),
        priority
      );
    }

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, outDir);
    status.set(video.id, 'ready');
    progress.delete(video.id);
    return master;
  } catch (err) {
    console.warn(`HLS: no se pudo generar "${video.title}": ${err.message}`);
    status.set(video.id, 'failed');
    progress.delete(video.id);
    throw err;
  }
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

module.exports = { generateHls, ensureGenerating, getStatus, getProgress, outDirFor, masterPlaylistFor };
