// Aspecto de los subtítulos (tamaño/color/fondo): a diferencia del idioma de
// audio (audioPreference.js, "cómo se ve en este aparato"), esto viaja con
// el PERFIL (servidor), no con el dispositivo - es "cómo prefiere leerlos
// esta persona", igual en el móvil que en la tele.
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
