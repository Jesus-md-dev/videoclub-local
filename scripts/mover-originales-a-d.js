// Traslada a otro disco (D:) los archivos originales que YA tienen su HLS
// listo, para liberar espacio en el disco externo (E:) sin borrar nada. Se
// registra cada vídeo en moved-originals.json (ver server/movedOriginals.js)
// para que el catálogo lo siga listando a partir de ese registro, no de un
// escaneo en vivo de la carpeta - así no depende de que D: esté conectado en
// el momento de escanear (si lo desconectas, el vídeo sigue apareciendo en
// la web con los datos ya conocidos, no desaparece del catálogo).
//
// (Primera versión de este script dejaba una "junction" NTFS en el sitio de
// cada carpeta movida en vez de este registro: funcionaba mientras D:
// estuviera conectado, pero si se desconectaba esos vídeos desaparecían del
// catálogo entero hasta reconectarlo y volver a escanear. El registro evita
// ese problema del todo.)
//
// Solo se mueve una carpeta ENTERA cuando TODOS sus vídeos no archivados ya
// tienen el HLS listo: si tiene algún vídeo pendiente (recién llegado,
// convirtiéndose, o con el HLS fallido), se deja toda la carpeta tal cual en
// el disco externo, para no complicar su generación. Esto también protege
// automáticamente carpetas "planas" con películas sueltas mezcladas (si
// alguna todavía no tiene HLS, ninguna de esa carpeta se mueve).
//
// A diferencia de config.js (pensado para que TODA la biblioteca viva en el
// disco externo y viaje con él a cualquier PC), D:\VideoclubOriginales es
// fijo a este PC a propósito: es solo un respaldo frío de originales que la
// propia web no necesita para reproducir (ya tiene su HLS).
//
// Tras ejecutarlo con --run, para que el servidor en marcha recoja los
// cambios sin reiniciar: POST /api/admin/reload (issue #89).
//
// Uso:
//   node scripts/mover-originales-a-d.js            (vista previa, no toca nada)
//   node scripts/mover-originales-a-d.js --run       (ejecuta el traslado real)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const catalog = require('../server/catalog');
const hls = require('../server/hls');
const movedOriginals = require('../server/movedOriginals');
const { getVideosPath } = require('../server/config');

const DEST_ROOT = 'D:\\VideoclubOriginales';
const DRY_RUN = !process.argv.includes('--run');

function bytesToGB(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

// robocopy cruza de disco sin el límite de fs.renameSync (que falla entre
// unidades distintas, EXDEV) y reintenta solo si el disco externo "se hace
// el remolón" (mismo motivo por el que hls.js/normalize.js también
// reintentan). Sus códigos de salida son un bitmask de éxito (0-7), no un
// booleano normal: >= 8 es el único caso real de fallo.
// /MT:8: copia hasta 8 archivos a la vez (mucho más rápido con muchos
// episodios pequeños/medianos que uno detrás de otro).
function robocopyDir(sourceAbs, destAbs) {
  const result = spawnSync('robocopy', [sourceAbs, destAbs, '/E', '/COPY:DAT', '/R:3', '/W:2', '/MT:8'], {
    encoding: 'utf-8',
  });
  if (result.status >= 8) {
    throw new Error(`robocopy falló (código ${result.status}) en "${sourceAbs}":\n${result.stdout}\n${result.stderr}`);
  }
}

function verifyCopy(sourceAbs, destAbs) {
  const sourceFiles = fs.readdirSync(sourceAbs).filter((f) => fs.statSync(path.join(sourceAbs, f)).isFile());
  const destFiles = fs.readdirSync(destAbs).filter((f) => fs.statSync(path.join(destAbs, f)).isFile());
  if (sourceFiles.length !== destFiles.length) {
    throw new Error(
      `Verificación fallida: ${sourceFiles.length} archivo(s) en origen, ${destFiles.length} en destino ("${destAbs}"). No se toca el original.`
    );
  }
  for (const f of sourceFiles) {
    const sSize = fs.statSync(path.join(sourceAbs, f)).size;
    const dSize = fs.statSync(path.join(destAbs, f)).size;
    if (sSize !== dSize) {
      throw new Error(`Verificación fallida en "${f}": tamaño distinto entre origen y destino. No se toca el original.`);
    }
  }
}

function moveDir(relDir, videosPath, videos) {
  const sourceAbs = path.join(videosPath, relDir);
  const destAbs = path.join(DEST_ROOT, relDir);

  if (fs.existsSync(destAbs)) {
    console.warn(`  ! Ya existe "${destAbs}", se omite por seguridad.`);
    return;
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  robocopyDir(sourceAbs, destAbs);
  verifyCopy(sourceAbs, destAbs);

  // Solo se borra el original de E: y se registra DESPUÉS de verificar que
  // la copia en D: tiene los mismos archivos y tamaños, nunca antes.
  fs.rmSync(sourceAbs, { recursive: true, force: true });
  for (const video of videos) {
    const fileName = path.basename(video.relativePath);
    movedOriginals.register(video, path.join(destAbs, fileName));
  }
  console.log('  OK: movido y registrado.');
}

async function main() {
  const videos = await catalog.scan();
  const videosPath = getVideosPath();

  const byDir = new Map();
  for (const v of videos) {
    const dir = path.dirname(v.relativePath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(v);
  }

  const eligible = [];
  for (const [dir, vids] of byDir) {
    const withOriginal = vids.filter((v) => v.archived !== true && !v.movedTo);
    if (withOriginal.length === 0) continue; // todo ya archivado/movido, nada que hacer
    const allReady = withOriginal.every((v) => hls.getStatus(v) === 'ready');
    if (!allReady) continue;
    eligible.push({ dir, videos: withOriginal });
  }

  let totalBytes = 0;
  for (const { dir, videos: vids } of eligible) {
    const size = vids.reduce((acc, v) => acc + v.size, 0);
    totalBytes += size;
    console.log(`${DRY_RUN ? '[vista previa]' : '[moviendo]'} ${dir}  (${vids.length} vídeo(s), ${bytesToGB(size)} GB)`);
    if (!DRY_RUN) {
      try {
        moveDir(dir, videosPath, vids);
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
      }
    }
  }

  console.log(`\nTotal: ${eligible.length} carpeta(s), ${bytesToGB(totalBytes)} GB`);
  if (DRY_RUN) {
    console.log('Vista previa solamente, no se ha movido nada. Ejecuta con --run para trasladar de verdad.');
  } else {
    console.log('Hecho. Recuerda: POST /api/admin/reload para que el servidor en marcha lo recoja sin reiniciar.');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
