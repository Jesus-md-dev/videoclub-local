const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_PATH } = require('./config');

const PROFILES_FILE = path.join(DATA_PATH, 'profiles.json');
const PROGRESS_DIR = path.join(DATA_PATH, 'progress');

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
  fs.writeFileSync(PROFILES_FILE, JSON.stringify({ profiles }, null, 2));
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

function deleteProfile(id) {
  writeProfiles(readProfiles().filter((p) => p.id !== id));
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
  fs.writeFileSync(progressFile(profileId), JSON.stringify(data, null, 2));
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
  getProgress,
  setProgress,
  dismissProgress,
  getSettings,
  setSettings,
};
