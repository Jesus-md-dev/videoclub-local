import { useEffect, useState } from 'react';
import { DEMO } from './demo';

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

// Añade el perfil activo a una URL del catálogo: el servidor oculta el
// anime a los perfiles que no tienen activado "Mostrar anime" (#150).
export function withProfile(url) {
  const id = getActiveProfileId();
  if (!id) return url;
  return `${url}${url.includes('?') ? '&' : '?'}profileId=${encodeURIComponent(id)}`;
}

// ¿Es administrador el perfil activo? (#152: solo los admin gestionan
// perfiles, entran en las páginas de administración y editan el catálogo).
// Sin ningún admin todavía, todos lo son (como hace el servidor,
// adminGuard.js). La lista de perfiles se pide una vez y se comparte;
// refreshProfiles() la vuelve a pedir tras cambiar algo.
let profilesPromise = null;

export function refreshProfiles() {
  profilesPromise = fetch('/api/profiles')
    .then((res) => res.json())
    .catch(() => []);
  return profilesPromise;
}

export function isAdminIn(profiles, id = getActiveProfileId()) {
  if (DEMO) return false; // la demo no tiene páginas de administración
  if (!profiles.some((p) => p.admin)) return true;
  return profiles.some((p) => p.id === id && p.admin);
}

// null mientras carga; luego true/false.
export function useIsAdmin() {
  const [admin, setAdmin] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (profilesPromise || refreshProfiles()).then((profiles) => {
      if (!cancelled) setAdmin(isAdminIn(profiles));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return admin;
}

export const PROFILE_COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#457b9d', '#8338ec', '#f4a261', '#06d6a0', '#ef476f'];

// El elegido a mano (#155), o uno fijo sacado del id.
export function profileColor(profile) {
  if (profile.color) return profile.color;
  const { id } = profile;
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PROFILE_COLORS[hash % PROFILE_COLORS.length];
}

// El perfil activo completo (nombre, color...), o null mientras carga o
// si no hay ninguno.
export function useActiveProfile() {
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (profilesPromise || refreshProfiles()).then((profiles) => {
      if (!cancelled) setProfile(profiles.find((p) => p.id === getActiveProfileId()) || null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return profile;
}

export function clearActiveProfileId() {
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
}
