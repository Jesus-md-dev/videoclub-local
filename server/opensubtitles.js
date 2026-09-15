const fs = require('fs');
const path = require('path');
const { DATA_PATH, getOpenSubtitlesConfig } = require('./config');
const { outputFile: subtitleFile } = require('./subtitles');

// Segunda fuente de subtítulos, solo para cuando SubDL (ver subdl.js, la
// prioritaria: cuota gratuita mucho más generosa) no encuentra nada - la
// cuota gratuita de OpenSubtitles es muy baja (unas pocas descargas al
// día), así que se deja como último recurso, no como opción principal.
//
// Se guardan con el mismo formato de nombre que un subtítulo extraído del
// propio vídeo ("<id>-<streamIndex>.vtt", ver subtitles.js), usando
// "os<fileId>" como streamIndex - así el resto del sistema (tracks.js,
// /api/subtitle/:id/:streamIndex) ya sabe servirlos sin cambios.
const API_BASE = 'https://api.opensubtitles.com/api/v1';
const REGISTRY_FILE = path.join(DATA_PATH, 'opensubtitles-downloads.json');
const USER_AGENT = 'VideoclubLocal v1.0';

let tokenCache = null; // { token, expiresAt }

function isConfigured() {
  return Boolean(getOpenSubtitlesConfig().apiKey);
}

async function apiFetch(pathname, options = {}) {
  const cfg = getOpenSubtitlesConfig();
  if (!cfg.apiKey) {
    throw new Error('Falta la clave de API de OpenSubtitles (configúrala en /config).');
  }
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      'Api-Key': cfg.apiKey,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenSubtitles respondió ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// El token dura ~24h; se guarda solo en memoria (no en disco) y se pide uno
// nuevo automáticamente cuando falta o ha caducado. Sin usuario/contraseña
// configurados, la búsqueda sigue funcionando (no hace falta login para
// eso), solo la descarga la necesita.
async function login() {
  const cfg = getOpenSubtitlesConfig();
  if (!cfg.username || !cfg.password) {
    throw new Error('Falta usuario/contraseña de OpenSubtitles (configúralos en /config).');
  }
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const data = await apiFetch('/login', {
    method: 'POST',
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  if (!data.token) throw new Error('OpenSubtitles no devolvió un token de sesión válido.');
  tokenCache = { token: data.token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
  return tokenCache.token;
}

async function search({ query, season, episode, languages = 'es' }) {
  const wanted = new Set(languages.split(',').map((l) => l.trim().toLowerCase()));
  const params = new URLSearchParams({ query, languages });
  if (season != null) params.set('season_number', String(season));
  if (episode != null) params.set('episode_number', String(episode));
  const data = await apiFetch(`/subtitles?${params.toString()}`);
  return (data.data || [])
    .map((item) => ({
      fileId: item.attributes?.files?.[0]?.file_id,
      language: item.attributes?.language || null,
      release: item.attributes?.release || item.attributes?.files?.[0]?.file_name || 'Sin nombre',
      downloadCount: item.attributes?.download_count ?? 0,
      hearingImpaired: Boolean(item.attributes?.hearing_impaired),
    }))
    // Filtro propio además del "languages" que ya se le pide a la API: por
    // seguridad (ver el mismo problema real encontrado en subdl.js), nunca
    // fiarse a ciegas de que el filtro del lado del servidor de turno
    // funcione siempre bien.
    .filter((r) => r.fileId && r.language && wanted.has(r.language.toLowerCase()))
    .sort((a, b) => b.downloadCount - a.downloadCount);
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

function streamIndexFor(fileId) {
  return `os${fileId}`;
}

async function downloadSubtitle(videoId, { fileId, language, release }) {
  const token = await login();
  const data = await apiFetch('/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!data.link) throw new Error(data.message || 'OpenSubtitles no devolvió un enlace de descarga.');

  const contentRes = await fetch(data.link);
  if (!contentRes.ok) throw new Error(`No se pudo descargar el archivo del subtítulo (${contentRes.status})`);
  const raw = decodeSubtitleBuffer(Buffer.from(await contentRes.arrayBuffer()));
  const vtt = srtToVtt(raw);

  const streamIndex = streamIndexFor(fileId);
  const file = subtitleFile(videoId, streamIndex);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, vtt);

  const registry = loadRegistry();
  registry[videoId] = (registry[videoId] || []).filter((e) => e.fileId !== fileId);
  registry[videoId].push({ fileId, language, release, addedAt: Date.now() });
  saveRegistry(registry);

  return { index: streamIndex, codec: 'vtt', language, languageLabel: language, title: release, default: false };
}

// Vídeos ya descargados de OpenSubtitles para uno en concreto (solo los que
// además sigan teniendo su .vtt en disco).
function listDownloaded(videoId) {
  const registry = loadRegistry();
  return (registry[videoId] || [])
    .filter((e) => fs.existsSync(subtitleFile(videoId, streamIndexFor(e.fileId))))
    .map((e) => ({
      index: streamIndexFor(e.fileId),
      codec: 'vtt',
      language: e.language || null,
      languageLabel: e.language || null,
      title: e.release || 'OpenSubtitles',
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
    const streamIndex = streamIndexFor(entry.fileId);
    const oldFile = subtitleFile(oldId, streamIndex);
    const newFile = subtitleFile(newId, streamIndex);
    if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) fs.renameSync(oldFile, newFile);
  }
}

module.exports = { isConfigured, search, downloadSubtitle, listDownloaded, migrateVideo };
