// Preferencias de reproducción que viajan con el PERFIL (servidor), no con
// el dispositivo - aspecto de los subtítulos (tamaño/color/fondo) y también
// el idioma de audio/subtítulos elegido la última vez (ver WatchPage): es
// "cómo prefiere ver/leer esto esta persona", igual en el móvil que en la
// tele. Es el mismo blob de settings del perfil (GET/PATCH /api/profiles/
// :id/settings), con más claves de las que declara DEFAULT_SUBTITLE_PREFS.
export const DEFAULT_SUBTITLE_PREFS = { size: 'medium', color: '#ffffff', background: 'semi' };

export const SUBTITLE_SIZE_EM = { small: 0.85, medium: 1.15, large: 1.6 };
export const SUBTITLE_BG_COLOR = { none: 'transparent', semi: 'rgba(0, 0, 0, 0.6)', solid: 'rgba(0, 0, 0, 0.95)' };

export async function fetchSubtitlePrefs(profileId) {
  if (!profileId) return DEFAULT_SUBTITLE_PREFS;
  try {
    const res = await fetch(`/api/profiles/${profileId}/settings`);
    if (!res.ok) return DEFAULT_SUBTITLE_PREFS;
    const data = await res.json();
    return { ...DEFAULT_SUBTITLE_PREFS, ...data };
  } catch {
    return DEFAULT_SUBTITLE_PREFS;
  }
}

export function saveSubtitlePrefs(profileId, patch) {
  if (!profileId) return;
  fetch(`/api/profiles/${profileId}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).catch(() => {});
}
