const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { MOVED_ORIGINALS_PATH } = require('./config');
const { inputPathFor } = require('./mediaInfo');
const movedOriginals = require('./movedOriginals');

// Traslada automáticamente a MOVED_ORIGINALS_PATH (si hay una carpeta
// configurada) el original de UN vídeo, justo después de que su HLS quede
// listo (ver hls.js: se llama ahí, igual que pregenerateExtras). Es la
// versión automática, por vídeo individual, de
// scripts/mover-originales-a-d.js (que hace lo mismo a mano, por carpeta
// entera): mismo registro (movedOriginals.js), mismo motivo (liberar
// espacio en el disco de la biblioteca sin perder el original).
//
// El original SOLO se borra de su sitio después de comprobar que la copia
// en el destino tiene el mismo tamaño exacto - igual que el resto del
// proyecto desde que se perdieron ~180 episodios por un borrado sin
// verificar (ver hls.js, comentario junto a donde se llama esto). Si algo
// falla en cualquier paso (el disco destino no está conectado ahora mismo,
// se queda sin espacio, la verificación no cuadra...), se deja el original
// tal cual donde estaba y se reintentará solo, sin querer, la próxima vez
// que ese vídeo pase por aquí (lo cual no vuelve a pasar salvo que se borre
// y regenere su HLS) - por eso conviene no depender de que esto pase de
// primeras: sirve como ahorro de espacio, no como paso obligatorio.
async function maybeMoveOriginal(video) {
  if (!MOVED_ORIGINALS_PATH) return; // sin carpeta configurada: desactivado
  if (video.archived === true || video.movedTo) return;

  const sourceAbs = inputPathFor(video);
  if (!fs.existsSync(sourceAbs)) return;

  const destAbs = path.join(MOVED_ORIGINALS_PATH, video.relativePath);

  try {
    if (fs.existsSync(destAbs)) {
      console.warn(`Traslado automático: ya existe "${destAbs}", se omite por seguridad.`);
      return;
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });

    // robocopy con un nombre de archivo de por medio copia solo ESE
    // archivo del directorio origen al destino (no toda la carpeta).
    const result = spawnSync(
      'robocopy',
      [path.dirname(sourceAbs), path.dirname(destAbs), path.basename(sourceAbs), '/COPY:DAT', '/R:3', '/W:2'],
      { encoding: 'utf-8' }
    );
    if (result.status >= 8) {
      throw new Error(`robocopy falló (código ${result.status}): ${result.stdout}\n${result.stderr}`);
    }

    const sourceSize = fs.statSync(sourceAbs).size;
    const destSize = fs.statSync(destAbs).size;
    if (sourceSize !== destSize) {
      throw new Error(`verificación fallida: ${sourceSize} bytes en origen, ${destSize} en destino`);
    }

    fs.rmSync(sourceAbs, { force: true });
    movedOriginals.register(video, destAbs);
    console.log(`Traslado automático: "${video.relativePath}" -> "${destAbs}"`);
  } catch (err) {
    console.warn(`Traslado automático fallido para "${video.relativePath}" (se deja el original donde estaba): ${err.message}`);
  }
}

module.exports = { maybeMoveOriginal };
