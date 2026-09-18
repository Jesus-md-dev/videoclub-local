const fs = require('fs');
const path = require('path');
const { ffmpeg } = require('./mediaInfo');

// H.264 de 10 bits ("Hi10p"/"High 10") es un caso especial molesto: muchos
// reproductores por hardware (sobre todo TVs/palos de streaming como Fire
// TV) no lo aceptan como H.264 normal, así que caen a descodificación por
// software y eso es justo lo que provoca reproducción lenta/con tirones.
function isTenBit(videoStream) {
  return Boolean(videoStream?.pix_fmt?.includes('10')) || videoStream?.profile === 'High 10';
}

// HDR10 (transferencia PQ/smpte2084) o HLG (arib-std-b67): sin convertir de
// verdad la curva de color al recodificar a 8 bits, el resultado no sale
// "un poco peor", sale MAL - los valores de luminancia de HDR (pensados
// para mostrarse con una curva PQ) se interpretan con la curva normal
// (gamma/BT.709), así que la imagen sale oscura y lavada de color, no solo
// con menos rango dinámico. Visto de verdad con "Michael (2026)" (HEVC Main
// 10, bt2020/smpte2084).
function isHdr(videoStream) {
  const transfer = videoStream?.color_transfer;
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67') return true;
  // Dolby Vision: en perfiles de una sola capa (5, 8.x) suele venir también
  // con color_transfer=smpte2084 (de ahí que ya lo pille el caso de arriba),
  // pero el perfil 5 (sin capa base HDR10 compatible) puede no declararlo
  // igual - el códec en sí ("dvhe"/"dvh1" para HEVC, "dva1"/"dvav" para
  // H.264) es una señal más fiable de que hay HDR de por medio pase lo que
  // pase con ese campo. Solo se usa la capa base (el "enhancement layer"
  // propio de Dolby Vision se ignora al no tener licencia para decodificarlo),
  // pero tonemapear esa capa base es muchísimo mejor que no tonemapear nada.
  const tag = videoStream?.codec_tag_string?.toLowerCase() || '';
  return ['dvhe', 'dvh1', 'dva1', 'dvav'].includes(tag);
}

// Detecta una sola vez si la GPU (NVENC) funciona de verdad en este equipo
// probando una codificación mínima; si algo falla (sin GPU NVIDIA, driver
// antiguo, etc.) se usa libx264 (CPU) para todo, sin más aviso. El
// resultado se comparte entre TODOS los llamantes (HLS y la conversión de
// compatibilidad, antes cada uno con su propia copia de este código y su
// propio caché por separado: la prueba llegaba a hacerse dos veces al
// arrancar, una por módulo). `workDir` es la carpeta donde se escribe el
// archivo de prueba desechable (cada llamante usa la suya: HLS_PATH o
// TRANSCODED_PATH), da igual cuál se use la primera vez.
let gpuAvailable = null;
let gpuCheckPromise = null;
function checkGpuAvailable(workDir) {
  if (gpuAvailable !== null) return Promise.resolve(gpuAvailable);
  if (gpuCheckPromise) return gpuCheckPromise;
  gpuCheckPromise = new Promise((resolve) => {
    fs.mkdirSync(workDir, { recursive: true });
    const checkFile = path.join(workDir, '.gpu-check.mp4');
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
  return gpuCheckPromise;
}

module.exports = { isTenBit, isHdr, checkGpuAvailable };
