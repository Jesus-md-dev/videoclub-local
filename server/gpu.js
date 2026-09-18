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

module.exports = { isTenBit, checkGpuAvailable };
