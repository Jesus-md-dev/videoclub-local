const fs = require('fs');
const path = require('path');
const { DATA_PATH, getVideosPath } = require('./config');

// Registro persistente de vídeos ya detectados como perdidos (ver
// hls.js:isLost), para no reescribir la lista humana en cada petición y
// para poder ir añadiendo según se detectan, no solo en una foto fija.
const REGISTRY_FILE = path.join(DATA_PATH, 'lost-videos.json');

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveRegistry(registry) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

// Fuera de la carpeta de vídeos pero en el mismo disco, para no mezclarla
// con la biblioteca y que el escaneo del catálogo no la confunda con
// contenido real.
function manifestDir() {
  const root = path.parse(getVideosPath()).root || 'C:\\';
  return path.join(root, 'Volver a descargar');
}

function manifestPath() {
  return path.join(manifestDir(), 'episodios-perdidos.txt');
}

function buildManifestText(registry) {
  const entries = Object.entries(registry);
  const bySeries = new Map();
  for (const [id, info] of entries) {
    const parts = info.relativePath.split(path.sep);
    const series = parts.length > 1 ? parts[parts.length - 2] : info.title;
    const folder = parts.slice(0, -1).join(path.sep);
    if (!bySeries.has(series)) bySeries.set(series, { folder, items: [] });
    bySeries.get(series).items.push({ id, ...info });
  }

  let out = 'Videoclub Local - Episodios perdidos (original borrado y cache HLS también perdida, sin backup)\n';
  out += `Actualizado: ${new Date().toISOString()}\n`;
  out += `Total: ${entries.length} episodios en ${bySeries.size} series/animes\n`;
  out += `Hay que volver a conseguir estos archivos y ponerlos en su carpeta original dentro de ${getVideosPath()}.\n`;
  out += 'Esta lista se actualiza sola según el servidor va encontrando vídeos perdidos: no hace falta tocarla a mano.\n\n';

  const seriesSorted = [...bySeries.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'));
  for (const [series, data] of seriesSorted) {
    out += `=== ${series} (${data.items.length}) ===\n`;
    out += `Carpeta: ${path.join(getVideosPath(), data.folder)}\n`;
    data.items.sort((a, b) => a.title.localeCompare(b.title, 'es', { numeric: true }));
    for (const it of data.items) out += `  - ${it.title}${path.extname(it.relativePath)}\n`;
    out += '\n';
  }
  return out;
}

let registry = loadRegistry();

// Se llama cada vez que hls.js detecta un vídeo perdido (ver isLost). No
// hace nada si ya estaba registrado, así que es barato llamarla a menudo.
function recordLost(video) {
  if (registry[video.id]) return;
  registry[video.id] = {
    relativePath: video.relativePath,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    detectedAt: new Date().toISOString(),
  };
  saveRegistry(registry);
  try {
    fs.mkdirSync(manifestDir(), { recursive: true });
    fs.writeFileSync(manifestPath(), buildManifestText(registry), 'utf-8');
  } catch (err) {
    console.warn(`No se pudo actualizar la lista de vídeos perdidos: ${err.message}`);
  }
}

// Para purgar del todo una obra (ver purge.js): quita este id de la lista
// de "Volver a descargar" y regenera el fichero, para no dejar ahí un
// episodio que ya se ha decidido no reponer.
function forget(id) {
  if (!registry[id]) return;
  delete registry[id];
  saveRegistry(registry);
  try {
    fs.mkdirSync(manifestDir(), { recursive: true });
    fs.writeFileSync(manifestPath(), buildManifestText(registry), 'utf-8');
  } catch (err) {
    console.warn(`No se pudo actualizar la lista de vídeos perdidos: ${err.message}`);
  }
}

module.exports = { recordLost, forget };
