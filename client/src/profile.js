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
  try {
    sessionStorage.setItem(CHOSEN_KEY, '1');
  } catch {
    // Sin sessionStorage: se volverá a preguntar, sin más.
  }
}

// Como Netflix, "¿Quién ve ahora?" cada vez que se entra (#147): el perfil
// recordado solo sirve para preseleccionarlo. Cuenta como "esta vez" la
// sesión del navegador (en la APK, mientras la app siga abierta): recargar
// la página no vuelve a preguntar.
const CHOSEN_KEY = 'profileChosenThisSession';

export function isProfileChosenThisSession() {
  try {
    return sessionStorage.getItem(CHOSEN_KEY) === '1';
  } catch {
    return true;
  }
}

export function clearActiveProfileId() {
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
}
