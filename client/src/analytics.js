// Analítica propia: se queda en tu servidor, no sale a ningún sitio
// externo. "Fire and forget": nunca bloquea ni rompe la app si falla.
export function track(event, data = {}) {
  fetch('/api/analytics/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...data }),
  }).catch(() => {});
}

// issue #144: una vez por sesión del navegador, qué declara el dispositivo
// (sobre todo para saber cómo se ve Silk de Fire TV sin tenerla delante).
export function trackDeviceInfo() {
  try {
    if (sessionStorage.getItem('deviceInfoSent')) return;
    sessionStorage.setItem('deviceInfoSent', '1');
  } catch {
    // Sin sessionStorage se manda igualmente.
  }
  const media = (q) => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return null;
    }
  };
  track('device_info', {
    userAgent: navigator.userAgent,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    hover: media('(hover: hover)'),
    pointerFine: media('(pointer: fine)'),
    pointerCoarse: media('(pointer: coarse)'),
    touchPoints: navigator.maxTouchPoints || 0,
    standalone: media('(display-mode: standalone)'),
  });
}
