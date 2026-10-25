// Servidor simulado en el navegador para la demo pública. Todo es ficticio.
const PROFILES = [
  { id: 'demo-alex', name: 'Alex', color: '#e63946', admin: false },
  { id: 'demo-sam', name: 'Sam', color: '#2a9d8f', admin: false },
];

const base = { size: 1500000, modifiedAt: 1700000000000, hasThumbnail: false, processingState: null, processingPercent: null, hlsReady: true, archived: false, castellano: false, animeMarked: false, customName: null };
const movie = (n, genres, poster) => ({
  ...base,
  id: `movie-${n}`,
  title: `Demo Movie ${n}`,
  cleanName: `Demo Movie ${n}`,
  metadataKey: `Demo Movie ${n}`,
  seriesKey: null,
  absoluteEpisode: null,
  genres,
  poster: `/demo/posters/${poster}.svg`,
  type: 'movie',
});
const episode = (n) => ({
  ...base,
  id: `series-${n}`,
  title: `Demo Series S01E0${n}`,
  cleanName: 'Demo Series',
  metadataKey: 'Demo Series',
  seriesKey: 'Demo Series',
  absoluteEpisode: n,
  genres: ['Comedy'],
  poster: '/demo/posters/series.svg',
  type: 'series',
});

const MOVIES = [
  movie(1, ['Action'], 'movie-1'),
  movie(2, ['Drama'], 'movie-2'),
  movie(3, ['Comedy'], 'movie-3'),
  movie(4, ['Drama', 'Sci-Fi'], 'movie-4'),
  movie(5, ['Action', 'Sci-Fi'], 'movie-5'),
];
const EPISODES = [1, 2, 3].map(episode);
const ALL = [...MOVIES, ...EPISODES];
const FOLDER = {
  name: 'Demo Series',
  path: 'Demo Series',
  metadataKey: 'Demo Series',
  cleanName: 'Demo Series',
  customName: null,
  thumbnailId: 'series-1',
  poster: '/demo/posters/series.svg',
  genres: ['Comedy'],
  type: 'series',
  animeMarked: false,
  count: EPISODES.length,
  processingState: null,
  processingPercent: null,
  hlsCompletion: 'ready',
  seriesProgress: null,
  firstVideoReady: true,
};

const GENRES = ['Action', 'Comedy', 'Drama', 'Sci-Fi'];
const NOT_IN_DEMO = { error: 'Not available in the demo.' };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Progreso y ajustes de perfil: solo en localStorage de este navegador.
function store(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`demo:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`demo:${key}`, JSON.stringify(value));
  } catch {
    // Sin localStorage: la demo sigue funcionando, sin recordar nada.
  }
}

async function handle(url, method, init) {
  const u = new URL(url, window.location.origin);
  const p = u.pathname;
  let m;

  if (p === '/api/profiles' && method === 'GET') return json(PROFILES);
  if ((m = p.match(/^\/api\/profiles\/([^/]+)\/progress(?:\/([^/]+))?(\/dismiss)?$/))) {
    const progress = store(`progress:${m[1]}`, {});
    if (m[3]) {
      if (progress[m[2]]) progress[m[2]].dismissedAt = Date.now();
      save(`progress:${m[1]}`, progress);
      return json({ ok: true });
    }
    if (method === 'GET') return json(m[2] ? progress[m[2]] || null : progress);
    const body = JSON.parse(init?.body || '{}');
    progress[m[2]] = { time: body.time, ratio: body.ratio, updatedAt: Date.now() };
    save(`progress:${m[1]}`, progress);
    return json(progress[m[2]]);
  }
  if ((m = p.match(/^\/api\/profiles\/([^/]+)\/settings$/))) {
    const settings = store(`settings:${m[1]}`, {});
    if (method === 'GET') return json(settings);
    Object.assign(settings, JSON.parse(init?.body || '{}'));
    save(`settings:${m[1]}`, settings);
    return json(settings);
  }

  if (p === '/api/videos' && method === 'GET') return json(ALL);
  if (p === '/api/videos/browse' && method === 'GET') {
    const dir = u.searchParams.get('dir') || '';
    if (!dir) return json({ dir: '', parent: null, folders: [FOLDER], videos: MOVIES });
    return json({ dir, parent: '', folders: [], videos: dir === 'Demo Series' ? EPISODES : [] });
  }
  if (p === '/api/genres') return json(GENRES);
  if ((m = p.match(/^\/api\/hls\/[^/]+\/status$/))) return json({ status: 'ready' });
  if (p.startsWith('/api/tracks/')) {
    return json({
      audio: [{ index: 1, codec: 'aac', language: 'eng', languageLabel: 'English', title: null, channels: 1 }],
      subtitles: [],
    });
  }
  if (p.startsWith('/api/trickplay/')) return json(null, 404);
  if (p === '/api/subdl/status') return json({ configured: false });
  if (p === '/api/metadata/force-tmdb-status') return json({ running: false });
  if (p === '/api/dlna/status' || p === '/api/chromecast/status') return json({ active: false });
  if (p === '/api/dlna/devices' || p === '/api/chromecast/devices') return json([]);
  if (p === '/api/analytics/track') return json({ ok: true });

  // Cualquier otra lectura: vacía; cualquier escritura: no disponible.
  return method === 'GET' ? json({}, 404) : json(NOT_IN_DEMO, 403);
}

export function installDemoMock() {
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.startsWith('/api/')) return original(input, init);
    const method = (init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    return handle(url, method, init);
  };
  // sendBeacon (analítica al cerrar): no hay a dónde enviar nada.
  navigator.sendBeacon = (url, data) => {
    const m = url.match(/^\/api\/profiles\/[^/]+\/progress\/[^/]+$/);
    if (m && data?.text) data.text().then((body) => handle(url, 'PUT', { body })).catch(() => {});
    return true;
  };
}
