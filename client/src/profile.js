const ACTIVE_PROFILE_KEY = 'activeProfileId';

// Qué perfil usa este dispositivo/navegador ahora mismo: es lo único que
// sigue viviendo en localStorage (por dispositivo). El progreso en sí ya no
// vive aquí, vive en el servidor por perfil, para que se vea igual desde
// cualquier dispositivo de la red.
export function getActiveProfileId() {
  return localStorage.getItem(ACTIVE_PROFILE_KEY);
}

export function setActiveProfileId(id) {
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function clearActiveProfileId() {
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
}
