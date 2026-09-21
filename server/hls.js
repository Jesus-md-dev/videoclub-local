const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { getMediaInfo, inputPathFor, ffprobePath, forgetAnalysis } = require('./mediaInfo');
const { HLS_PATH } = require('./config');
const { runLimited } = require('./ffmpeg-limiter');
const subtitles = require('./subtitles');
const trickplay = require('./trickplay');
const archivedVideos = require('./archivedVideos');
const lostVideos = require('./lostVideos');
const moveOriginal = require('./moveOriginal');
const { isTenBit, isHdr, checkGpuAvailable } = require('./gpu');

// Issue #58/#59/#61 del plan HLS: generación + estado/progreso/prioridad.
// Las rutas HTTP están en routes/hls.js, el reproductor (#60) en el cliente.

const COMPATIBLE_VIDEO_CODECS = ['h264'];
const SEGMENT_SECONDS = 6;

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

// Construye el "-var_stream_map" que le dice al muxer HLS de ffmpeg cómo
// agrupar las salidas: una variante de vídeo (sin audio) + una variante de
// solo-audio por cada pista, todas en el mismo grupo "aud" para que el
// reproductor las ofrezca como pistas de audio alternativas del mismo vídeo.
// Importante: este valor lleva espacios DENTRO de un único argumento de
// ffmpeg (uno por cada variante) — ver la nota en runFfmpegHls sobre por
// qué esto no se puede montar con fluent-ffmpeg.
// Dos pistas del mismo idioma pero doblajes distintos (p.ej. "Latino" y
// "Castellano", ambas con tags.language="spa") se quedaban con el MISMO
// nombre de variante ("Español" las dos, labelFor prioriza el idioma sobre
// el título) - ffmpeg intentaba escribir dos variantes de audio en la
// misma carpeta a la vez, corrompiendo los segmentos de una de ellas.
// Síntoma con el que se detectó: el manifiesto salía sin #EXT-X-STREAM-INF
// (ver fixStreamInfBandwidth) y, aun reparado a mano, ffprobe no podía
// leer esa variante después. Aquí se desambiguan los nombres repetidos
// usando el título real de la pista si lo distingue, o un sufijo numérico
// si tampoco eso basta.
function dedupeLabels(audioStreams) {
  const labels = audioStreams.map((s, i) => labelFor(s, i));
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);

  const seen = new Map();
  return labels.map((label, i) => {
    if (counts.get(label) === 1) return label;
    const stream = audioStreams[i];
    const titleLabel = stream.tags?.title ? sanitizeLabel(stream.tags.title) : null;
    let candidate = titleLabel && titleLabel !== label ? titleLabel : label;
    const usedCount = (seen.get(candidate) || 0) + 1;
    seen.set(candidate, usedCount);
    return usedCount > 1 ? `${candidate}_${usedCount}` : candidate;
  });
}

function buildVarStreamMap(audioStreams, defaultIndex) {
  const parts = ['v:0,agroup:aud'];
  const labels = dedupeLabels(audioStreams);
  audioStreams.forEach((stream, i) => {
    const attrs = [`a:${i}`, 'agroup:aud', `name:${labels[i]}`];
    const lang = stream.tags?.language;
    if (lang) attrs.push(`language:${sanitizeLabel(lang)}`);
    if (i === defaultIndex) attrs.push('default:yes');
    parts.push(attrs.join(','));
  });
  return parts.join(' ');
}

// Dos problemas distintos con la línea #EXT-X-STREAM-INF del manifiesto,
// los dos alrededor del BANDWIDTH declarado:
//
// 1. Falta la línea entera. ffmpeg puede terminar con código 0 (éxito) pero
//    sin escribirla, dejando los segmentos generados bien pero el
//    manifiesto inservible - visto repetidas veces en producción (~66
//    vídeos de golpe, y de nuevo con "Los Caballeros del Zodiaco: El Lienzo
//    Perdido"). Con "-c:v copy" (remux sin recodificar) ffmpeg avisa
//    "Bandwidth info not available, set audio and video bitrates" cuando no
//    logra calcular el bitrate y, en vez de usar un valor por defecto,
//    omite la línea entera.
//
// 2. La línea SÍ existe, pero con un BANDWIDTH muy por debajo del real -
//    visto con "Amasando Ja-Pan - S01E04" (recodificado, no remux): ffmpeg
//    estima el bandwidth EN MARCHA según el ritmo de codificación
//    observado hasta ese momento, no a partir del tamaño final real: para
//    contenido cuya complejidad varía a lo largo del vídeo, esa estimación
//    puede quedar muy corta (ahí, 7 veces menor que el real). Un bandwidth
//    mal declarado no rompe la sintaxis del manifiesto, así que nada lo
//    detectaba después - hls.js podía infravalorar drásticamente cuánto
//    tardaría en llegar cada segmento real, dando congelaciones
//    intermitentes en pleno visionado (no un fallo de generación).
//
// En ambos casos se usa el mismo ancho de banda "de verdad": el resumen
// final de ffmpeg ("video:1234kB..."), no leyendo los segmentos del disco -
// sumar bytes de archivos justo tras cerrar el proceso ffmpeg resultó ser
// además una condición de carrera real en un disco externo (el mismo
// "Amasando Ja-Pan": el disco no había terminado de sincronizar los
// últimos segmentos todavía). El resumen de ffmpeg es un valor que el
// propio proceso ya tiene calculado internamente, sin depender de leer
// nada del disco.
function fixStreamInfBandwidth(masterPath, videoStream, durationSeconds, ffmpegStderr) {
  const text = fs.readFileSync(masterPath, 'utf-8');
  const correctBandwidth = parseVideoBitrateFromSummary(ffmpegStderr || '', durationSeconds);

  const streamInfMatch = text.match(/^#EXT-X-STREAM-INF:.*$/m);
  if (streamInfMatch) {
    if (!correctBandwidth) return; // no hay con qué comparar/corregir, se deja como está
    const declaredMatch = streamInfMatch[0].match(/BANDWIDTH=(\d+)/);
    const declared = declaredMatch ? Number(declaredMatch[1]) : null;
    // Un factor de 2x separa "estimación algo conservadora" (normal, no se
    // toca) de "claramente mal calculada" (el caso real visto fue de 7x).
    if (declared && correctBandwidth <= declared * 2) return;
    const fixedLine = streamInfMatch[0].replace(/BANDWIDTH=\d+/, `BANDWIDTH=${correctBandwidth}`);
    fs.writeFileSync(masterPath, text.replace(streamInfMatch[0], fixedLine));
    return;
  }

  // Falta la línea entera: construirla desde cero.
  let bandwidth = correctBandwidth;
  if (!bandwidth) {
    // Respaldo si por lo que sea no se pudo leer el resumen de ffmpeg: mejor
    // un valor aproximado (con el riesgo de carrera ya conocido) que nada.
    let totalBytes = 0;
    const segDir = path.join(path.dirname(masterPath), '0');
    try {
      for (const name of fs.readdirSync(segDir)) {
        totalBytes += fs.statSync(path.join(segDir, name)).size;
      }
    } catch {
      return;
    }
    if (!totalBytes || !durationSeconds) return;
    bandwidth = Math.round((totalBytes * 8) / durationSeconds);
  }
  if (!bandwidth) return;

  bandwidth = Math.max(1, bandwidth);
  const width = videoStream.width || 1920;
  const height = videoStream.height || 1080;
  // avc1.640028 (H.264 High@4.0) es una aproximación válida para
  // cualquier H.264 a efectos de que el navegador decida si puede
  // reproducirlo - el valor exacto del profile/level real no es crítico
  // aquí, hls.js/el navegador ya negocian por el "avc1" base.
  const videoCodec = videoStream.codec_name === 'hevc' ? 'hvc1.1.6.L93.90' : 'avc1.640028';
  const line = `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},CODECS="${videoCodec},mp4a.40.2",AUDIO="group_aud"\n0/prog.m3u8\n`;
  fs.writeFileSync(masterPath, `${text.trimEnd()}\n${line}`);
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
// Confirmación real (no solo "el manifiesto tiene buena pinta") de que el
// HLS recién generado funciona antes de fiarse de él para nada más: se
// vuelve a analizar con ffprobe, leyendo los segmentos de verdad, y se
// exige encontrar una pista de vídeo y una duración parecida a la del
// original (más de un ~15% de diferencia, o directamente sin duración,
// es señal de segmentos truncados/incompletos aunque el manifiesto en sí
// pareciera correcto).
// Se invoca ffprobe con spawn directo (no ffmpeg.ffprobe de fluent-ffmpeg) y
// cwd fijado a la carpeta del propio manifiesto, pasando solo "master.m3u8"
// (ruta relativa): visto en producción que, dentro del proceso servidor de
// larga duración, ffmpeg.ffprobe fallaba de forma consistente con "No such
// file or directory" al intentar abrir una variante de audio cuyo nombre de
// carpeta lleva un carácter acentuado (p.ej. "Japonés"), aunque la misma
// llamada contra el mismo archivo funcionara bien ejecutada a mano en un
// proceso nuevo - apunta a un problema de cómo se resuelven ahí las rutas
// relativas del manifiesto (posiblemente ligado a la codificación del cwd
// real del proceso servidor), no a los datos generados en sí. Fijar el cwd
// a la propia carpeta del HLS y no pasar ninguna ruta con acentos como
// argumento evita depender de esa resolución.
function verifyGeneratedHls(masterPath, expectedDurationSeconds) {
  return new Promise((resolve, reject) => {
    if (!ffprobePath) {
      reject(new Error('No se encontró el binario de ffprobe'));
      return;
    }
    const args = ['-v', 'error', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'json', 'master.m3u8'];
    const proc = spawn(ffprobePath, args, { cwd: path.dirname(masterPath) });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe no pudo leer el HLS recién generado: ${stderr.split('\n').slice(-5).join(' ')}`));
        return;
      }
      let info;
      try {
        info = JSON.parse(stdout);
      } catch (err) {
        reject(new Error(`ffprobe devolvió una salida ilegible: ${err.message}`));
        return;
      }
      const videoStream = info.streams?.find((s) => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('El HLS recién generado no tiene ninguna pista de vídeo legible'));
        return;
      }
      const gotDuration = Number(info.format?.duration) || null;
      if (expectedDurationSeconds && gotDuration) {
        const diff = Math.abs(gotDuration - expectedDurationSeconds);
        const tolerance = Math.max(10, expectedDurationSeconds * 0.15);
        if (diff > tolerance) {
          reject(
            new Error(
              `La duración del HLS generado (${gotDuration.toFixed(1)}s) no se parece a la del original (${expectedDurationSeconds.toFixed(1)}s) - probablemente incompleto`
            )
          );
          return;
        }
      }
      resolve();
    });
  });
}

// Justo tras cerrar el proceso ffmpeg (código 0, éxito) los datos pueden no
// estar todavía sincronizados de verdad en un disco externo USB - el cierre
// de los file handles no garantiza el fsync físico. Visto en producción:
// verifyGeneratedHls fallaba con "ffprobe no pudo leer" justo después de
// generar, pero el mismo ffprobe sobre el mismo archivo, ejecutado a mano
// unos segundos más tarde, lo leía sin ningún problema - una condición de
// carrera de E/S, no un HLS realmente roto. Un par de reintentos cortos
// aquí (en vez de repetir todo el remux desde cero, que no soluciona esto
// y además es mucho más caro) le da al disco el margen que necesita.
async function verifyGeneratedHlsWithRetry(masterPath, expectedDurationSeconds) {
  const attempts = 3;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await verifyGeneratedHls(masterPath, expectedDurationSeconds);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function runFfmpegHls(inputPath, outDir, { audioStreams, defaultIndex, videoCopy, useGpu, hdr, durationSeconds, onProgress }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });

    const args = ['-y'];
    // Descodifica también por GPU, no solo codifica: sin esto, un origen
    // pesado (HEVC/10 bits) se descodifica por CPU y ese es el cuello de
    // botella real aunque la codificación ya use NVENC. Solo tiene sentido
    // si además se va a recodificar (videoCopy no decodifica ni un frame).
    // Con HDR se descodifica siempre por CPU (sin -hwaccel cuda): el filtro
    // de tone-mapping de abajo necesita fotogramas normales en RAM, no los
    // que quedan en memoria de la GPU tras una descodificación acelerada.
    if (useGpu && !videoCopy && !hdr) args.push('-hwaccel', 'cuda');
    args.push('-i', inputPath, '-map', '0:v:0');
    audioStreams.forEach((stream) => {
      args.push('-map', `0:${stream.index}`);
    });

    args.push('-c:v', videoCopy ? 'copy' : useGpu ? 'h264_nvenc' : 'libx264');
    if (!videoCopy) {
      // HDR de origen: decodificar+tonemapear+recodificar es una conversión
      // con pérdida en dos pasos (no un simple remux de contenedor), y encima
      // partiendo de un rango dinámico mucho más amplio que se está
      // comprimiendo a la fuerza - con la misma calidad de siempre (cq/crf
      // 23) el degradado de cielos/sombras que deja el tonemap se nota mucho
      // más (banding). Un poco más de calidad solo para este caso concreto,
      // no en todas las conversiones.
      if (useGpu) {
        args.push('-preset', 'p4', '-rc', 'vbr', '-cq', hdr ? '20' : '23');
      } else {
        args.push('-preset', 'veryfast', '-crf', hdr ? '18' : '23');
      }
      if (hdr) {
        // HDR (PQ/HLG o Dolby Vision, ver gpu.js:isHdr) a SDR de verdad, no
        // solo un cambio de formato de píxel: sin pasar antes por luz lineal
        // (zscale transfer=linear) y aplicar el propio tonemap (hable:
        // conserva mejor las luces altas que un simple recorte), la imagen
        // sale oscura y lavada de color - la curva PQ codifica mucho más
        // rango de luminancia que SDR en los mismos valores numéricos, así
        // que interpretarla directamente como si fuera BT.709 aplasta las
        // sombras. La segunda zscale ya deja declarado bt709 en la salida
        // (transferencia+matriz+primarios+rango "tv"/limited, no solo el
        // format=yuv420p): sin fijar el rango explícito, un reproductor
        // podría interpretar la salida como rango completo y deslavar los
        // negros otra vez, aunque el color en sí ya esté bien convertido.
        args.push(
          '-vf',
          'zscale=transfer=linear:npl=100,tonemap=tonemap=hable:desat=0,zscale=transfer=bt709:matrix=bt709:primaries=bt709:range=tv,format=yuv420p'
        );
      } else {
        args.push('-pix_fmt', 'yuv420p');
      }
    }
    // Por pista, no en bloque: si una pista ya es AAC (el caso normal en
    // esta biblioteca), copiarla es prácticamente instantáneo - antes se
    // recodificaban todas siempre, aunque ya fueran válidas, sin motivo.
    //
    // Las pistas que SÍ hay que recodificar se fuerzan a estéreo (-ac 2):
    // visto en directo con una edición de fans con audio 5.1 en una pista
    // (japonés) y estéreo en otra (castellano) - cambiar de pista en pleno
    // visionado hacía que Chrome fallara al añadir el nuevo audio al mismo
    // SourceBuffer (bufferFullError) y hls.js revertía solo a la pista
    // anterior sin avisar, dando la sensación de que el cambio de idioma
    // "no hacía nada". Las pistas HLS de un mismo grupo de audio deben
    // compartir formato para poder alternar entre ellas sin recargar nada.
    audioStreams.forEach((stream, i) => {
      // Una pista ya en AAC pero multicanal (5.1/7.1) también hay que
      // recodificarla: copiarla tal cual (channels > 2) es justo el caso
      // real que rompía Chrome al reproducir - visto con "Ted Lasso"
      // S01E02 (AAC 5.1 con distribución de canales ambigua): fallaba al
      // arrancar con "stream parsing failed" en el SourceBuffer de audio,
      // no solo al cambiar de pista. Nunca copiar audio con más de 2
      // canales, sea cual sea su códec de origen.
      if (stream.codec_name === 'aac' && stream.channels <= 2) {
        args.push(`-c:a:${i}`, 'copy');
      } else {
        args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, '160k', `-ac:a:${i}`, '2');
      }
    });
    // El audio AAC de un origen MKV/TS suele venir en formato ADTS, que
    // fMP4 no admite tal cual (error "Malformed AAC bitstream") - hace
    // falta convertirlo a ASC. No estorba a las pistas que se recodifican
    // (ffmpeg ya las genera en el formato correcto), así que se aplica a
    // todas por igual en vez de distinguir cuáles.
    args.push('-bsf:a', 'aac_adtstoasc');
    args.push(
      '-f', 'hls',
      '-hls_time', String(SEGMENT_SECONDS),
      '-hls_playlist_type', 'vod',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      // fMP4, no MPEG-TS: verificado en directo que el cambio de pista de
      // audio alternativa en pleno visionado no funcionaba de verdad con
      // TS (la pista "seleccionada" y las peticiones de red eran
      // correctas, pero el sonido seguía siendo el de la pista por
      // defecto sin importar cuál se eligiera) - un problema conocido de
      // compatibilidad de los navegadores con audio alternativo sobre TS.
      // fMP4 es el empaquetado que los navegadores soportan de forma
      // nativa para esto, sin conversión intermedia de por medio.
      '-hls_segment_type', 'fmp4',
      '-master_pl_name', 'master.m3u8',
      '-var_stream_map', buildVarStreamMap(audioStreams, defaultIndex),
      // Con "/" a propósito, no path.join: ffmpeg calcula a partir de estas
      // rutas las URIs relativas que escribe dentro del .m3u8, y esas son
      // URLs (las sirve el navegador), no rutas de Windows — con "\" el
      // manifiesto queda inválido (el reproductor no encuentra el archivo).
      '-hls_segment_filename', `${toPosix(outDir)}/%v/seg_%03d.m4s`,
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
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg (HLS) salió con código ${code}: ${stderr.split('\n').slice(-5).join(' ')}`));
    });
  });
}

// El resumen final de ffmpeg ("video:1234kB audio:56kB...") es el tamaño
// real que ffmpeg sabe que ha escrito, calculado internamente - a
// diferencia de sumar los bytes de los segmentos leyéndolos del disco justo
// después de cerrar el proceso (ver bug real de abajo), no depende de que
// el sistema de archivos ya haya terminado de sincronizar.
const SUMMARY_RE = /video:(\d+)kB/;
function parseVideoBitrateFromSummary(stderrText, durationSeconds) {
  const match = SUMMARY_RE.exec(stderrText);
  if (!match || !durationSeconds) return null;
  const videoKB = Number(match[1]);
  if (!videoKB) return null;
  return Math.round((videoKB * 1024 * 8) / durationSeconds);
}

// Estado por video.id: 'checking' | 'processing' | 'ready' | 'failed'.
// 'ready' también se puede inferir de que exista master.m3u8 en disco
// (p.ej. tras un reinicio del servidor, sin pasar otra vez por 'processing').
const status = new Map();
const progress = new Map(); // video.id -> { percent: 0-99 | null, startedAt }
// Por qué falló, para poder verlo en /queue en vez de tener que mirar el
// log del servidor a mano. Solo tiene sentido mientras status === 'failed'
// (se borra en cuanto se reintenta o se genera con éxito).
const lastError = new Map();

// Vídeos cuyo master.m3u8 ya se comprobó válido una vez. hasValidMasterPlaylist
// se llama por cada vídeo (dos veces) en cada carga de /api/videos: sin este
// caché, con 2000+ vídeos eso son miles de existsSync+readFileSync síncronos
// por request, y con el disco externo ocupado a la vez por varias
// generaciones ffmpeg en paralelo eso bastaba para bloquear el hilo principal
// de Node varios segundos (o más) - la web entera dejaba de responder aunque
// el proceso siguiera vivo. Un vídeo ya listo no deja de estarlo salvo que se
// purgue (ver purge.js, que llama a forget()).
const readyIds = new Set();

// Un master.m3u8 puede existir en disco y aun así estar incompleto: visto
// en producción, un ffmpeg que terminó con código 0 (éxito) pero sin
// escribir la línea que declara la pista de vídeo (STREAM-INF), con los
// segmentos de vídeo y audio ya generados bien de todas formas. Fiarse
// solo de que el archivo exista no bastaba para darlo por servible de
// verdad.
function hasValidMasterPlaylist(video) {
  if (readyIds.has(video.id)) return true;
  const file = masterPlaylistFor(video);
  if (!fs.existsSync(file)) return false;
  try {
    const valid = fs.readFileSync(file, 'utf-8').includes('#EXT-X-STREAM-INF');
    if (valid) readyIds.add(video.id);
    return valid;
  } catch {
    return false;
  }
}

// Llamado al purgar un vídeo (borra su carpeta HLS de disco): sin esto el
// caché seguiría diciendo "listo" para un vídeo cuyo master.m3u8 ya no existe.
function forget(videoId) {
  readyIds.delete(videoId);
}

function getStatus(video) {
  if (hasValidMasterPlaylist(video)) return 'ready';
  return status.get(video.id) || 'unknown';
}

function getLastError(video) {
  return lastError.get(video.id) || null;
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

// Un vídeo "archivado" (#61: original borrado porque el HLS ya era el mismo
// vídeo, sin duplicarlo) cuya carpeta de HLS ha desaparecido de todas formas
// no tiene ya ni original ni copia: no hay nada que (re)generar, a
// diferencia de un fallo puntual de ffmpeg. Pasó de verdad en producción
// (ver `E:\Volver a descargar\episodios-perdidos.txt`, ~180 episodios cuya
// carpeta data/hls se borró a mano para liberar espacio sin saber que para
// estos era la única copia que quedaba).
//
// Mismo trato para un vídeo que NUNCA se archivó ni se trasladó (issue
// #112): si el catálogo lo lista pero su archivo no está donde debería (ni
// en la carpeta de vídeos, ni en el registro de traslado), es un huérfano
// de verdad, no un fallo puntual - reintentarlo en cada reinicio para
// siempre no lo va a arreglar, solo desperdicia tiempo y satura el disco
// externo sin necesidad (visto de verdad con varios episodios de Galactik
// Football que llevaban así mucho tiempo). "video.movedTo" es la señal
// clave que distingue esto de un vídeo cuyo disco de traslado está
// simplemente desconectado ahora mismo (ver movedOriginals.js) - ESE caso
// SÍ debe seguir reintentándose, es temporal y conocido, no "perdido".
function isLost(video) {
  if (!hasValidMasterPlaylist(video) && !fs.existsSync(inputPathFor(video))) {
    if (archivedVideos.isArchived(video.id)) return true;
    if (!video.archived && !video.movedTo) return true;
  }
  return false;
}

// Arranca la generación si hace falta (no bloquea: se lanza en segundo
// plano) y devuelve el estado actual al instante, para poder ofrecer una
// pantalla de "preparando...". 'priority': 'high' para quien le ha dado a play
// ahora mismo (adelanta en la cola compartida de ffmpeg al precalentamiento
// en segundo plano), 'low' en caso contrario.
function ensureGenerating(video, priority = 'low') {
  if (hasValidMasterPlaylist(video)) {
    status.set(video.id, 'ready');
    return 'ready';
  }

  const current = status.get(video.id);
  if (current === 'checking' || current === 'processing' || current === 'failed') return current;

  if (isLost(video)) {
    status.set(video.id, 'failed');
    lastError.set(
      video.id,
      'Vídeo perdido: no queda ni el original ni la copia generada, no hay nada que regenerar. Apuntado en la lista de "Volver a descargar" (ver README).'
    );
    lostVideos.recordLost(video);
    return 'failed';
  }

  lastError.delete(video.id);
  status.set(video.id, 'checking');
  runGeneration(video, priority).catch(() => {}); // el estado ya queda registrado dentro
  return 'checking';
}

// Para el botón "Reintentar" de /queue: algunos fallos son puntuales (un
// hipo del disco externo, p.ej.), no corrupción real del archivo - sin
// esto, un vídeo marcado como 'failed' se queda así para siempre hasta
// reiniciar el servidor entero. Para uno "perdido" (ver isLost) reintentar
// no tiene sentido: no hay archivo de origen con el que hacer nada.
function retry(video) {
  if (isLost(video)) return 'failed';
  status.delete(video.id);
  lastError.delete(video.id);
  // Sin esto, un vídeo que falló una vez por estar roto/incompleto y luego
  // se sustituyó por uno bueno (p.ej. se volvió a descargar) seguía dando el
  // mismo error para siempre: getMediaInfo memoiza en RAM y esa memoria no
  // caduca sola dentro del mismo proceso (ver mediaInfo.js:forgetAnalysis).
  forgetAnalysis(video.id);
  return ensureGenerating(video, 'high');
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
    const hdr = !videoCopy && isHdr(videoStream);
    const useGpu = !videoCopy && (await checkGpuAvailable(HLS_PATH));

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
        const ffmpegStderr = await runLimited(
          () => runFfmpegHls(inputPathFor(video), tmpDir, { audioStreams, defaultIndex, videoCopy, useGpu: attempts[i], hdr, durationSeconds, onProgress }),
          priority
        );
        // ffmpeg puede salir con código 0 (éxito) y aun así dejar el
        // manifiesto sin la línea que declara la pista de vídeo
        // (#EXT-X-STREAM-INF), o con esa línea pero con un BANDWIDTH mal
        // estimado - ver fixStreamInfBandwidth. Sin la comprobación de que
        // la línea exista, se daba directamente por "ready" (y, si era
        // compatible, se archivaba borrando el original) un HLS que en
        // realidad no se podía reproducir - tratarlo como un fallo más (con
        // sus reintentos) evita perder el original de algo roto. La
        // corrección del BANDWIDTH se aplica siempre (no solo si falta la
        // línea entera), porque el segundo caso no rompe la sintaxis y por
        // tanto no se detectaría de otra forma.
        const tmpMaster = path.join(tmpDir, 'master.m3u8');
        fixStreamInfBandwidth(tmpMaster, videoStream, durationSeconds, ffmpegStderr);
        if (!fs.readFileSync(tmpMaster, 'utf-8').includes('#EXT-X-STREAM-INF')) {
          throw new Error('El manifiesto generado no declara la pista de vídeo (falta #EXT-X-STREAM-INF)');
        }
        // No basta con que el texto del manifiesto tenga buena pinta: se
        // vuelve a analizar con ffprobe el HLS ya generado (lee los
        // segmentos de verdad, no solo el manifiesto) y se compara su
        // duración con la del original. Solo con esto confirmado se marca
        // "ready" y se deja archivar (borrar el original) más abajo - así
        // un resultado roto de cualquier otra forma (segmentos truncados,
        // corruptos...) tampoco se da nunca por bueno a ciegas.
        // eslint-disable-next-line no-await-in-loop
        await verifyGeneratedHlsWithRetry(tmpMaster, durationSeconds);
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

    // Antes, cuando el original ya era H.264 compatible, se borraba tras
    // generar el HLS (el mismo vídeo dos veces en disco, se consideraba
    // redundante) - instrucción permanente del usuario tras perder de verdad
    // ~180 episodios (issue #67/#97): el original NUNCA se borra, pase lo
    // que pase. Sigue precalentando subtítulos/vista previa en segundo plano
    // (no bloquea el "ready"), simplemente sin la parte de borrado.
    //
    // Esto es independiente de "videoCopy" (si el vídeo necesitó
    // recodificarse o no) - antes estaba condicionado a eso por error, así
    // que cualquier vídeo que necesitara recodificar (HEVC, 10 bits,
    // HDR/Dolby Vision...) nunca llegaba a extraer sus subtítulos
    // incrustados. Visto de verdad con "X-Men '97" S02E05 (HEVC 4K Dolby
    // Vision, 27 pistas de subtítulos en el archivo, ninguna extraída).
    pregenerateExtras(video).catch((err) => {
      console.warn(`HLS: no se pudieron precalentar subtítulos/vista previa de "${video.title}": ${err.message}`);
    });

    // Traslado automático a un disco de respaldo frío (ver moveOriginal.js):
    // sin relación con el borrado de arriba - aquí SIEMPRE queda una copia
    // real verificada antes de tocar el original, y si no hay ninguna
    // carpeta configurada para esto no hace nada. En segundo plano, no
    // bloquea el "ready": el vídeo ya se puede reproducir mientras tanto.
    moveOriginal.maybeMoveOriginal(video).catch((err) => {
      console.warn(`HLS: fallo en el traslado automático del original de "${video.title}": ${err.message}`);
    });

    return master;
  } catch (err) {
    console.warn(`HLS: no se pudo generar "${video.title}": ${err.message}`);
    status.set(video.id, 'failed');
    lastError.set(video.id, err.message);
    progress.delete(video.id);
    throw err;
  }
}

// El original YA NO SE BORRA NUNCA (instrucción permanente del usuario, tras
// perder de verdad ~180 episodios cuando coincidió con un borrado manual de
// la carpeta de HLS - ver issue #67/#97: sin el original, esos episodios
// fueron irrecuperables). Esto solo precalienta en segundo plano lo que
// tiene sentido tener ya listo para un vídeo H.264 compatible (subtítulos,
// vista previa de arrastre) - nunca bloquea el "ready", el vídeo ya se
// puede reproducir igual mientras tanto.
async function pregenerateExtras(video) {
  const info = await getMediaInfo(video);
  const subtitleStreams = info.streams.filter((s) => s.codec_type === 'subtitle');
  for (const stream of subtitleStreams) {
    // eslint-disable-next-line no-await-in-loop
    await subtitles.extractSubtitle(video, stream.index).catch((err) => {
      console.warn(`HLS: no se pudo precalentar el subtítulo ${stream.index} de "${video.title}": ${err.message}`);
    });
  }
  await trickplay.ensureTrickplay(video);
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

// Precalienta en segundo plano toda la biblioteca, en prioridad 'low': si
// alguien le da a play mientras tanto, esa petición 'high' adelanta en la
// cola compartida de ffmpeg (ver ffmpeg-limiter.js) y se sirve antes, sin
// esperar a que termine el precalentamiento. Así lo ya generado está listo
// al momento y lo demás se va poniendo al día solo, sin perder la
// prioridad de "quien está viendo ahora" que tenía sentido quitarle al
// pipeline antiguo (#61).
//
// Antes esto era 4: aunque el tope compartido (ffmpeg-limiter.js) permite
// hasta 10 procesos ffmpeg a la vez y CPU/RAM aguantaban bien varios en
// paralelo, el disco externo (USB, IOPS limitados) no - varias
// generaciones HLS a la vez lo saturaban de verdad y dejaban la web entera
// sin responder (incluso rutas que no tocan el catálogo), la misma lección
// que ya costó aprender una vez con el pipeline antiguo (#48). Ver #67
// para el diagnóstico completo y la verificación de que 1 lo soluciona.
const WARM_CONCURRENCY = 1;

// Un reescaneo automático puede llamar a esto mientras la pasada anterior
// sigue en marcha (mismo motivo que el guard de metadata.js): sin esto, se
// acumulaban pasadas paralelas todas recorriendo la biblioteca entera
// detrás de la primera sin aportar nada.
let warming = false;

// Umbral de seguridad, no una estimación del tamaño real de salida (varía
// demasiado según duración/pistas de audio como para calcularlo de
// antemano): por debajo de esto, generar más HLS solo empeora un disco ya
// al límite (visto de verdad el 2026-09-20 con E: al 100%, 0 bytes
// libres) sin garantía siquiera de terminar un solo vídeo entero.
const MIN_FREE_BYTES_TO_GENERATE = 2 * 1024 * 1024 * 1024;
const DISK_FULL_RETRY_MS = 60 * 1000;

function freeBytesFor(dirPath) {
  try {
    const stats = fs.statfsSync(dirPath);
    return stats.bavail * stats.bsize;
  } catch {
    // Si no se puede comprobar, no bloquear el precalentado por esto.
    return Infinity;
  }
}

// Espera aquí mismo (sin consumir el "worker" en otra cosa) hasta que
// vuelva a haber sitio de verdad, en vez de intentar generar igualmente y
// dejar una carpeta .tmp a medias que nadie limpia sola. El traslado
// automático a otro disco (moveOriginal.js) y el propio usuario borrando
// cosas son las dos formas normales de que esto se libere solo.
async function waitForDiskSpace() {
  let warned = false;
  for (;;) {
    const free = freeBytesFor(HLS_PATH);
    if (free >= MIN_FREE_BYTES_TO_GENERATE) {
      if (warned) console.log('HLS: espacio suficiente de nuevo, se reanuda el precalentado.');
      return;
    }
    if (!warned) {
      console.warn(
        `HLS: precalentado en pausa, menos de ${(MIN_FREE_BYTES_TO_GENERATE / 1024 / 1024 / 1024).toFixed(1)}GB libres en "${HLS_PATH}" - se reintenta cada minuto.`
      );
      warned = true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, DISK_FULL_RETRY_MS));
  }
}

async function warmAll(videos) {
  if (warming) return;
  warming = true;
  const ordered = [...videos].sort((a, b) => (a.size || 0) - (b.size || 0));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const video = ordered[next];
      next += 1;
      if (!video) return;
      try {
        // eslint-disable-next-line no-await-in-loop
        await waitForDiskSpace();
        // eslint-disable-next-line no-await-in-loop
        await generateHls(video, 'low');
      } catch (err) {
        console.warn(`HLS: no se pudo precalentar "${video.title}": ${err.message}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker));
  } finally {
    warming = false;
  }
}

module.exports = {
  generateHls,
  ensureGenerating,
  getStatus,
  getProgress,
  getLastError,
  retry,
  warmAll,
  outDirFor,
  masterPlaylistFor,
  forget,
  isLost,
};
