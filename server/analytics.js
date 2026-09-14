const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

const LOG_FILE = path.join(DATA_PATH, 'analytics.log');
const MAX_SUMMARY_LINES = 200000; // no leer un archivo infinito si crece mucho

// Analítica propia y local: nada sale de este servidor. Un evento por
// línea (JSON Lines), para poder ir añadiendo sin reescribir el archivo
// entero cada vez. Pensado para responder "¿qué se ve/busca más?" y "¿qué
// falla?" (tirones, fallos de conversión...) y así saber qué mejorar.
function track(event, data = {}) {
  const line = JSON.stringify({ ts: Date.now(), event, ...data });
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.appendFile(LOG_FILE, `${line}\n`, () => {});
}

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_FILE, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const recent = lines.slice(-MAX_SUMMARY_LINES);
  const events = [];
  for (const line of recent) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // línea corrupta (p.ej. corte a medio escribir), se ignora
    }
  }
  return events;
}

function topEntries(counts, limit = 15) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

// Resumen agregado a partir del log crudo: cuántos eventos de cada tipo,
// qué vídeos se reproducen/terminan más, qué búsquedas son más frecuentes,
// y cuántos tirones/fallos ha habido (para detectar problemas reales de
// rendimiento, no solo gustos de catálogo).
function summary() {
  const events = readEvents();
  const byEvent = {};
  const playsByVideo = {};
  const completesByVideo = {};
  const searches = {};
  const genreClicks = {};
  const stallsByVideo = {};
  const errorsByVideo = {};

  for (const e of events) {
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    if (e.event === 'play_start' && e.videoId) {
      const key = e.title || e.videoId;
      playsByVideo[key] = (playsByVideo[key] || 0) + 1;
    }
    if (e.event === 'play_complete' && e.videoId) {
      const key = e.title || e.videoId;
      completesByVideo[key] = (completesByVideo[key] || 0) + 1;
    }
    if (e.event === 'search' && e.term) {
      const term = e.term.trim().toLowerCase();
      if (term) searches[term] = (searches[term] || 0) + 1;
    }
    if (e.event === 'genre_filter' && e.genre) {
      genreClicks[e.genre] = (genreClicks[e.genre] || 0) + 1;
    }
    if (e.event === 'stall' && e.videoId) {
      const key = e.title || e.videoId;
      stallsByVideo[key] = (stallsByVideo[key] || 0) + 1;
    }
    if (e.event === 'play_error' && e.videoId) {
      const key = e.title || e.videoId;
      errorsByVideo[key] = (errorsByVideo[key] || 0) + 1;
    }
  }

  return {
    totalEvents: events.length,
    since: events.length ? events[0].ts : null,
    byEvent,
    topPlayed: topEntries(playsByVideo),
    topCompleted: topEntries(completesByVideo),
    topSearches: topEntries(searches),
    topGenres: topEntries(genreClicks),
    topStalls: topEntries(stallsByVideo),
    topErrors: topEntries(errorsByVideo),
  };
}

module.exports = { track, summary };
