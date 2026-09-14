const KEY = 'preferredAudioLanguage';

// Qué idioma de audio se eligió la última vez, para aplicarlo solo al
// abrir el siguiente episodio/película (por dispositivo, como el perfil
// activo): no tiene sentido guardarlo en el servidor por perfil, es una
// preferencia de "cómo prefiero ver esto en este aparato", no progreso.
export function getPreferredAudioLanguage() {
  return localStorage.getItem(KEY);
}

export function setPreferredAudioLanguage(language) {
  if (language) {
    localStorage.setItem(KEY, language);
  } else {
    localStorage.removeItem(KEY);
  }
}
