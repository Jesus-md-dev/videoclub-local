const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_PATH, getSubdlApiKey } = require('./config');
const { outputFile: subtitleFile } = require('./subtitles');

// Subtítulos de mejor calidad/variedad que los que ya lleve incrustados el
// archivo (o cuando no lleva ninguno): busca y descarga desde SubDL
// (https://subdl.com/api-doc), con solo una clave de API gratuita (sin
// usuario/contraseña) y una cuota diaria generosa (miles de búsquedas,
// cientos de descargas).
//
// Se guardan con el mismo formato de nombre que un subtítulo extraído del
// propio vídeo ("<id>-<streamIndex>.vtt", ver subtitles.js), usando
// "ext<hash>" como streamIndex - así el resto del sistema (tracks.js,
// /api/subtitle/:id/:streamIndex) ya sabe servirlos sin cambios.
const API_BASE = 'https://api.subdl.com/api/v1';
const REGISTRY_FILE = path.join(DATA_PATH, 'subtitle-downloads.json');

function isConfigured() {
  return Boolean(getSubdlApiKey());
}

function shortId(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
}

function streamIndexFor(url) {
  return `ext${shortId(url)}`;
}

async function fetchSubtitlesPage(apiKey, params) {
  const res = await fetch(`${API_BASE}/subtitles?${params.toString()}`);
  if (!res.ok) throw new Error(`SubDL respondió ${res.status}`);
  const data = await res.json();
  if (data.status === false) throw new Error(data.error || 'SubDL no encontró nada para este título.');
  return data;
}

async function search({ query, season, episode, languages = 'ES' }) {
  const apiKey = getSubdlApiKey();
  if (!apiKey) throw new Error('Falta la clave de API de SubDL (configúrala en /config).');

  // Buscar directamente por nombre ("film_name") a veces solo devuelve una
  // página parcial/distinta de subtítulos (se ha visto quedarse sin los de
  // un idioma que sí existen) - en dos pasos es fiable: primero se busca el
  // título para sacar su imdb_id, y solo con ESO se vuelve a pedir la
  // lista de subtítulos completa (además, así "languages" si filtra bien
  // del lado del servidor; aun así se vuelve a filtrar aquí mismo, por si
  // acaso, con el idioma real de cada subtítulo).
  const wanted = new Set(languages.split(',').map((l) => l.trim().toLowerCase()));

  const searchParams = new URLSearchParams({ api_key: apiKey, film_name: query });
  const searchData = await fetchSubtitlesPage(apiKey, searchParams);
  const bestMatch = searchData.results?.[0];

  const params = new URLSearchParams({ api_key: apiKey, unpack: '1' });
  if (bestMatch?.imdb_id) params.set('imdb_id', bestMatch.imdb_id);
  else params.set('film_name', query);
  if (season != null) params.set('season_number', String(season));
  if (episode != null) params.set('episode_number', String(episode));

  const data = await fetchSubtitlesPage(apiKey, params);

  const results = [];
  for (const sub of data.subtitles || []) {
    const subLang = (sub.language || sub.lang || '').toLowerCase();
    if (!wanted.has(subLang)) continue;
    // "unpack=1" desglosa el zip en archivos sueltos ya descargables
    // directamente (unpack_files); si SubDL no lo hace para alguno, se cae
    // al archivo tal cual viene (puede ser un .zip - se detecta y se avisa
    // al descargar, ver downloadSubtitle).
    const files = sub.unpack_files?.length ? sub.unpack_files : [{ url: sub.url, name: sub.release_name || sub.name }];
    for (const file of files) {
      if (!file.url) continue;
      results.push({
        fileId: file.url,
        language: sub.language || sub.lang || null,
        release: file.release_name || file.name || sub.release_name || 'Sin nombre',
        downloadCount: sub.download_count ?? 0,
        hearingImpaired: Boolean(sub.hi),
      });
    }
  }
  return results.sort((a, b) => b.downloadCount - a.downloadCount);
}

// Muchos .srt antiguos (sobre todo en español) no están en UTF-8 sino en
// Windows-1252/ISO-8859-1 - decodificarlos como UTF-8 sin más deja tildes y
// "ñ" como el carácter de reemplazo "�". Se decodifica primero como UTF-8
// y, si aparece ese carácter (señal de que no lo era), se decodifica de
// nuevo como latin1 (mismo rango de acentuadas que Windows-1252 en la
// práctica para subtítulos).
function decodeSubtitleBuffer(buf) {
  const utf8 = buf.toString('utf-8');
  return utf8.includes('\uFFFD') ? buf.toString('latin1') : utf8;
}

function srtToVtt(raw) {
  if (/^\uFEFF?WEBVTT/i.test(raw.trim())) return raw;
  return `WEBVTT\n\n${raw.replace(/\r+/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')}`;
}

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

async function downloadSubtitle(videoId, { fileId: url, language, release }) {
  if (!url) throw new Error('Falta el archivo a descargar.');
  const apiKey = getSubdlApiKey();
  const absoluteUrl = url.startsWith('http') ? url : `https://dl.subdl.com${url}`;
  const res = await fetch(absoluteUrl, apiKey ? { headers: { 'x-api-key': apiKey } } : undefined);
  if (!res.ok) throw new Error(`No se pudo descargar el archivo del subtítulo (${res.status})`);
  const raw = decodeSubtitleBuffer(Buffer.from(await res.arrayBuffer()));
  if (raw.startsWith('PK')) {
    throw new Error('SubDL ha devuelto un archivo comprimido (.zip) para este subtítulo en concreto; prueba con otro de la lista.');
  }
  const vtt = srtToVtt(raw);

  const streamIndex = streamIndexFor(url);
  const file = subtitleFile(videoId, streamIndex);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, vtt);

  const registry = loadRegistry();
  registry[videoId] = (registry[videoId] || []).filter((e) => e.streamIndex !== streamIndex);
  registry[videoId].push({ streamIndex, language, release, addedAt: Date.now() });
  saveRegistry(registry);

  return { index: streamIndex, codec: 'vtt', language, languageLabel: language, title: release, default: false };
}

// Vídeos ya descargados de SubDL para uno en concreto (solo los que además
// sigan teniendo su .vtt en disco).
function listDownloaded(videoId) {
  const registry = loadRegistry();
  return (registry[videoId] || [])
    .filter((e) => fs.existsSync(subtitleFile(videoId, e.streamIndex)))
    .map((e) => ({
      index: e.streamIndex,
      codec: 'vtt',
      language: e.language || null,
      languageLabel: e.language || null,
      title: e.release || 'Subtítulo',
      default: false,
    }));
}

// Para normalize.js: igual que progreso/carátula/HLS, esto también está
// indexado por id de vídeo - sin migrarlo al renombrar, un subtítulo ya
// descargado quedaría huérfano exactamente igual que pasó antes con los
// extraídos del propio archivo (ver tracks.js/subtitles.js).
function migrateVideo(oldId, newId) {
  const registry = loadRegistry();
  const entries = registry[oldId];
  if (!entries || entries.length === 0) return;
  delete registry[oldId];
  registry[newId] = [...(registry[newId] || []), ...entries];
  saveRegistry(registry);

  for (const entry of entries) {
    const oldFile = subtitleFile(oldId, entry.streamIndex);
    const newFile = subtitleFile(newId, entry.streamIndex);
    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) fs.renameSync(oldFile, newFile);
  }
}

module.exports = { isConfigured, search, downloadSubtitle, listDownloaded, migrateVideo };
