const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_PATH } = require('./config');

const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const PROGRESS_DIR = path.join(DATA_PATH, 'progress');

// fs.writeFileSync directo sobre el archivo final puede dejarlo a medias o
// vacío si falla a mitad de escritura (disco lleno, corte de luz...) - visto
// de verdad el 2026-09-20 con E: al 100%: una escritura de progreso falló
// así, y la siguiente (getProgress -> JSON inválido -> {} en silencio ->
// writeProgress sobrescribe con solo la entrada nueva) borró todo el
// historial de "continuar viendo" salvo lo último visto. Escribir primero a
// un archivo temporal y renombrar es atómico a nivel de sistema de
// archivos: o se queda el bueno de antes, o el nuevo completo, nunca algo
// a medias.
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readProfiles() {
  try {
    const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
    return Array.isArray(data.profiles) ? data.profiles : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles) {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  writeJsonAtomic(PROFILES_FILE, { profiles });
}

function listProfiles() {
  return readProfiles();
}

function profileExists(id) {
  return readProfiles().some((p) => p.id === id);
}

function createProfile(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('El perfil necesita un nombre');
  if (trimmed.length > 30) throw new Error('El nombre es demasiado largo');
  const profiles = readProfiles();
  if (profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error('Ya existe un perfil con ese nombre');
  }
  const profile = { id: crypto.randomBytes(8).toString('hex'), name: trimmed, createdAt: Date.now() };
  profiles.push(profile);
  writeProfiles(profiles);
  return profile;
}

// Perfil administrador (#152, ver adminGuard.js). Va en el perfil y no en
// settings: los ajustes los cambia cada perfil libremente (subtítulos...).
// Nunca se deja sin ningún admin: sin admins, adminGuard deja hacer todo a
// todos.
function setAdmin(id, admin) {
  const profiles = readProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) throw new Error('Perfil no encontrado');
  if (!admin && profile.admin && profiles.filter((p) => p.admin).length === 1) {
    throw new Error('Tiene que quedar al menos un perfil administrador');
  }
  if (admin) profile.admin = true;
  else delete profile.admin;
  writeProfiles(profiles);
  return profile;
}

function deleteProfile(id) {
  const profiles = readProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (profile?.admin && profiles.filter((p) => p.admin).length === 1) {
    throw new Error('No se puede borrar el único perfil administrador');
  }
  writeProfiles(profiles.filter((p) => p.id !== id));
  fs.rm(progressFile(id), { force: true }, () => {});
}

function progressFile(profileId) {
  return path.join(PROGRESS_DIR, `${profileId}.json`);
}

// { [videoId]: { time, ratio, updatedAt, dismissedAt? } }
function getProgress(profileId) {
  try {
    return JSON.parse(fs.readFileSync(progressFile(profileId), 'utf-8'));
  } catch {
    return {};
  }
}

function writeProgress(profileId, data) {
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  writeJsonAtomic(progressFile(profileId), data);
}

function setProgress(profileId, videoId, { time, ratio }) {
  const data = getProgress(profileId);
  const previous = data[videoId];
  data[videoId] = { time, ratio, updatedAt: Date.now() };
  // Si se retoma más adelante (progreso posterior al momento en que se
  // descartó de "Continuar viendo"), debe volver a aparecer solo.
  if (previous?.dismissedAt) data[videoId].dismissedAt = previous.dismissedAt;
  writeProgress(profileId, data);
  return data[videoId];
}

function dismissProgress(profileId, videoId) {
  const data = getProgress(profileId);
  data[videoId] = { ...(data[videoId] || {}), dismissedAt: Date.now() };
  writeProgress(profileId, data);
}

// Preferencias de reproducción (aspecto de los subtítulos, idioma de audio/
// subtítulos elegido la última vez...): es "cómo prefiere ver/leer esto
// ESTA persona", así que viaja con el perfil igual que el progreso, no con
// el navegador/dispositivo.
function getSettings(profileId) {
  const profile = readProfiles().find((p) => p.id === profileId);
  return profile?.settings || {};
}

function setSettings(profileId, patch) {
  const profiles = readProfiles();
  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error('Perfil no encontrado');
  profile.settings = { ...(profile.settings || {}), ...patch };
  writeProfiles(profiles);
  return profile.settings;
}

module.exports = {
  listProfiles,
  profileExists,
  createProfile,
  deleteProfile,
  setAdmin,
  getProgress,
  setProgress,
  dismissProgress,
  getSettings,
  setSettings,
};
