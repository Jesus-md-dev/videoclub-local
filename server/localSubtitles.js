const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { outputFile: subtitleFile } = require('./subtitles');
const { toVtt, SUPPORTED_EXTENSIONS } = require('./subtitleConvert');
const { createJsonRegistry } = require('./jsonRegistry');
const { getVideosPath } = require('./config');

// Subtítulos que ya tenías tú (.srt/.vtt), en vez de buscados en SubDL: por
// dos vías -
//   1. Manual: subir un archivo para un vídeo en concreto (ver
//      routes/tracks.js: POST /subtitle/import).
//   2. Automático: si el archivo ya vive en la misma carpeta que el vídeo,
//      con un nombre que empieza igual (patrón habitual en rips: "Peli.mkv"
//      + "Peli.srt", o con el idioma al final: "Peli.es.srt") - se importa
//      solo, sin tener que subirlo a mano (ver autoImportSidecars).
//
// Se guardan con el mismo formato de nombre que un subtítulo extraído del
// propio vídeo o descargado de SubDL ("<id>-<streamIndex>.vtt", ver
// subtitles.js): el resto del sistema (tracks.js, /api/subtitle/:id/:idx)
// ya sabe servirlos sin cambios.
const store = createJsonRegistry('local-subtitles.json');

function shortId(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

// A partir de la ruta/nombre de origen, no de un hash del contenido: así
// re-detectar el mismo archivo sidecar en pasadas sucesivas (autoImportSidecars)
// siempre da el mismo streamIndex, y ya se reconoce como "ya importado" sin
// volver a leerlo ni duplicar la entrada en el registro.
function streamIndexFor(sourceKey) {
  return `local${shortId(sourceKey)}`;
}

// Guarda `buffer` (contenido crudo de un .srt/.vtt) como subtítulo de
// `videoId`. `sourceKey` identifica el origen para el streamIndex (ruta en
// disco si es automático, o el propio nombre de archivo si es una subida
// manual); `label` es lo que se muestra en el desplegable de subtítulos.
function importBuffer(videoId, sourceKey, buffer, { language = null, label = null } = {}) {
  const ext = path.extname(sourceKey).toLowerCase();
  const vtt = toVtt(ext, buffer);

  const streamIndex = streamIndexFor(sourceKey);
  const file = subtitleFile(videoId, streamIndex);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, vtt);

  const registry = store.get();
  registry[videoId] = (registry[videoId] || []).filter((e) => e.streamIndex !== streamIndex);
  registry[videoId].push({
    streamIndex,
    language,
    label: label || path.basename(sourceKey),
    addedAt: Date.now(),
  });
  store.save();

  return {
    index: streamIndex,
    codec: 'vtt',
    language,
    languageLabel: language,
    title: label || path.basename(sourceKey),
    default: false,
  };
}

// Subtítulos importados de un vídeo (solo los que además sigan teniendo su
// .vtt en disco) - mismo patrón que subdl.js:listDownloaded.
function listImported(videoId) {
  const registry = store.get();
  return (registry[videoId] || [])
    .filter((e) => fs.existsSync(subtitleFile(videoId, e.streamIndex)))
    .map((e) => ({
      index: e.streamIndex,
      codec: 'vtt',
      language: e.language || null,
      languageLabel: e.language || null,
      title: e.label || 'Subtítulo importado',
      default: false,
    }));
}

// Códigos de idioma habituales al final del nombre de un subtítulo suelto
// (ej. "Peli.es.srt", "Peli.spa.srt"), para reconocer el idioma sin tener
// que abrir el archivo.
const LANGUAGE_SUFFIXES = {
  es: 'spa',
  spa: 'spa',
  esp: 'spa',
  castellano: 'spa',
  latino: 'spa',
  en: 'eng',
  eng: 'eng',
  ingles: 'eng',
  inglés: 'eng',
  ja: 'jpn',
  jp: 'jpn',
  jpn: 'jpn',
  japones: 'jpn',
  japonés: 'jpn',
};

// Detecta subtítulos sueltos (.srt/.vtt) en la MISMA carpeta que el vídeo,
// con un nombre que empieza igual que el suyo (sin extensión). Importa los
// que no estuvieran ya registrados; es idempotente entre pasadas (el
// streamIndex sale de la ruta del archivo, así que uno ya importado se
// reconoce y se ignora sin volver a leerlo). Devuelve cuántos importó.
function autoImportSidecars(video) {
  const videosPath = getVideosPath();
  if (!videosPath) return 0;
  const absVideoPath = path.join(videosPath, video.relativePath);
  const dir = path.dirname(absVideoPath);
  const base = path.basename(video.relativePath, path.extname(video.relativePath));

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  const already = new Set((store.get()[video.id] || []).map((e) => e.streamIndex));
  let imported = 0;
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    const nameBase = name.slice(0, -ext.length);
    if (nameBase !== base && !nameBase.startsWith(`${base}.`)) continue;

    const sourcePath = path.join(dir, name);
    const streamIndex = streamIndexFor(sourcePath);
    if (already.has(streamIndex)) continue;

    const suffix = nameBase.slice(base.length).replace(/^\./, '').toLowerCase();
    const language = LANGUAGE_SUFFIXES[suffix] || null;

    try {
      const buffer = fs.readFileSync(sourcePath);
      importBuffer(video.id, sourcePath, buffer, { language, label: name });
      imported += 1;
    } catch (err) {
      console.warn(`No se pudo importar el subtítulo "${sourcePath}": ${err.message}`);
    }
  }
  return imported;
}

// Pasada completa (al arrancar el servidor, ver server/index.js): además
// de la comprobación perezosa de getTracks() cuando alguien abre un vídeo
// en concreto, esto encuentra subtítulos sueltos ya puestos en la carpeta
// de una obra que nadie ha abierto todavía. Barato de repetir (cada vídeo
// ya importado se reconoce y se salta sin volver a leer nada).
function autoImportAllSidecars(videos) {
  let imported = 0;
  for (const video of videos) {
    imported += autoImportSidecars(video);
  }
  if (imported > 0) console.log(`Subtítulos importados automáticamente: ${imported}`);
  return imported;
}

// Para normalize.js: igual que subdl.js, esto está indexado por id de
// vídeo - sin migrarlo al renombrar, un subtítulo importado quedaría
// huérfano.
function migrateVideo(oldId, newId) {
  const registry = store.get();
  const entries = registry[oldId];
  if (!entries || entries.length === 0) return;
  delete registry[oldId];
  registry[newId] = [...(registry[newId] || []), ...entries];
  store.save();

  for (const entry of entries) {
    const oldFile = subtitleFile(oldId, entry.streamIndex);
    const newFile = subtitleFile(newId, entry.streamIndex);
    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) fs.renameSync(oldFile, newFile);
  }
}

module.exports = { importBuffer, listImported, autoImportSidecars, autoImportAllSidecars, migrateVideo };
