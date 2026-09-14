// Analítica propia: se queda en tu servidor, no sale a ningún sitio
// externo. "Fire and forget": nunca bloquea ni rompe la app si falla.
export function track(event, data = {}) {
  fetch('/api/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...data }),
  }).catch(() => {});
}
