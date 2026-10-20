const fs = require('fs');
const path = require('path');
const { getVideosPath } = require('./config');
const { createJsonRegistry } = require('./jsonRegistry');

// Registro persistente de vídeos ya detectados como perdidos (ver
// hls.js:isLost), para no reescribir la lista humana en cada petición y
// para poder ir añadiendo según se detectan, no solo en una foto fija.
const store = createJsonRegistry('lost-videos.json');
// Perdidos que se ha decidido no reponer (#170): sin esto, quitarlos de la
// lista no servía de nada, porque hls.js:isLost los volvía a detectar y
// recordLost los añadía otra vez.
const ignored = createJsonRegistry('lost-ignored.json');

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

function rewriteManifest(registry) {
  try {
    fs.mkdirSync(manifestDir(), { recursive: true });
    fs.writeFileSync(manifestPath(), buildManifestText(registry), 'utf-8');
  } catch (err) {
    console.warn(`No se pudo actualizar la lista de vídeos perdidos: ${err.message}`);
  }
}

// Se llama cada vez que hls.js detecta un vídeo perdido (ver isLost). No
// hace nada si ya estaba registrado, así que es barato llamarla a menudo.
function recordLost(video) {
  const registry = store.get();
  if (registry[video.id] || ignored.get()[video.id]) return;
  registry[video.id] = {
    relativePath: video.relativePath,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    detectedAt: new Date().toISOString(),
  };
  store.save();
  rewriteManifest(registry);
}

// Para purgar del todo una obra (ver purge.js): quita este id de la lista
// de "Volver a descargar" y regenera el fichero, para no dejar ahí un
// episodio que ya se ha decidido no reponer.
function forget(id) {
  const registry = store.get();
  if (!registry[id]) return;
  delete registry[id];
  store.save();
  rewriteManifest(registry);
}

// Quita un vídeo de la lista y no lo vuelve a apuntar aunque se detecte
// otra vez como perdido.
function ignore(id) {
  const registry = store.get();
  const entry = registry[id];
  ignored.get()[id] = { title: entry?.title || null, relativePath: entry?.relativePath || null, ignoredAt: new Date().toISOString() };
  ignored.save();
  forget(id);
}

function reloadRegistry() {
  store.reload();
  ignored.reload();
}

module.exports = { recordLost, forget, ignore, reloadRegistry };
