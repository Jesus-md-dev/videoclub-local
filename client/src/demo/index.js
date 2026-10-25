// Modo demo (VITE_DEMO=1): build estática para Netlify sin servidor. Las
// llamadas a /api las responde demo/mock.js con datos inventados y el vídeo
// sale de clips HLS sintéticos en public/demo/ (scripts/make-demo-assets.js).
export const DEMO = import.meta.env.VITE_DEMO === '1';

export const DEMO_REPO_URL = 'https://github.com/Jesus-md-dev/videoclub-local';

// URL del manifiesto HLS de un vídeo.
export function hlsMasterUrl(id) {
  return DEMO ? `/demo/hls/${id.endsWith('2') || id.endsWith('4') ? 'b' : 'a'}/master.m3u8` : `/api/hls/${id}/master.m3u8`;
}
