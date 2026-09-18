const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_PATH, getSubdlApiKey } = require('./config');
const { outputFile: subtitleFile } = require('./subtitles');
const { decodeSubtitleBuffer, srtToVtt } = require('./subtitleConvert');

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

// "Berserk" (la serie) sale como primer resultado buscando solo "Berserk",
// por delante de "Berserk: Ougon Jidai-hen I - Haou no Tamago (... The
// Golden Age Arc I ...)" - la película en concreto que se busca aquí -
// así que fiarse de results[0] a ciegas devolvía subtítulos (o ninguno) de
// un título distinto. Se puntúan los candidatos: coincide el tipo
// (película/serie) según TMDB, coincide el número de parte/arco (números
// romanos como "I"/"II" en el propio nombre de archivo, que sobreviven
// aunque el idioma del título no coincida), y si tiene imdb_id (los que no
// lo tienen no sirven para la siguiente consulta).
function extractPartMarker(text) {
  const m = text.match(/\b(IV|IX|V?I{1,3})\b/);
  return m ? m[1] : null;
}

function pickBestMatch(results, { query, type }) {
  if (!results || results.length === 0) return null;
  const marker = extractPartMarker(query);
  const markerRe = marker ? new RegExp(`\\b${marker}\\b`) : null;
  let best = results[0];
  let bestScore = -Infinity;
  for (const r of results) {
    let score = 0;
    if (type && r.type === type) score += 2;
    if (markerRe && markerRe.test(r.name || '')) score += 3;
    if (r.imdb_id) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

// Un título completo con subtítulo propio ("Berserk - La edad de oro I: El
// huevo del rey conquistador") a veces no encuentra NADA en SubDL (su
// búsqueda por nombre es más literal que difusa), mientras que solo la
// parte antes del primer separador (aquí, "Berserk") sí encuentra
// candidatos - luego pickBestMatch ya se encarga de elegir el correcto
// entre ellos usando el número de parte/arco del título completo.
function simplifyQuery(query) {
  const m = query.match(/^(.*?)\s(?:-|:)\s/);
  if (!m) return null;
  const simplified = m[1].trim();
  return simplified && simplified !== query ? simplified : null;
}

async function searchFilmName(apiKey, filmName) {
  try {
    const data = await fetchSubtitlesPage(apiKey, new URLSearchParams({ api_key: apiKey, film_name: filmName }));
    return data.results || [];
  } catch {
    return [];
  }
}

async function search({ query, season, episode, languages = 'ES', type = null }) {
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

  let candidates = await searchFilmName(apiKey, query);
  let usedQuery = query;
  if (candidates.length === 0) {
    const simplified = simplifyQuery(query);
    if (simplified) {
      candidates = await searchFilmName(apiKey, simplified);
      if (candidates.length > 0) usedQuery = simplified;
    }
  }
  const bestMatch = pickBestMatch(candidates, { query, type });

  const params = new URLSearchParams({ api_key: apiKey, unpack: '1' });
  if (bestMatch?.imdb_id) params.set('imdb_id', bestMatch.imdb_id);
  else params.set('film_name', usedQuery);
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
