const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

// Vídeos cuyo archivo original se borró tras generar su HLS (solo pasa
// cuando el vídeo ya era H.264 compatible: el HLS es un simple remux del
// mismo vídeo, así que conservar los dos era tener el mismo vídeo dos
// veces). catalog.js los sigue listando a partir de aquí, no de un
// escaneo de disco (el archivo ya no está) - por eso esto tiene que
// sobrevivir a un reinicio/cambio de servidor igual que perfiles o
// progreso (ver backup.js).
const FILE = path.join(DATA_PATH, 'hls-archived.json');

let registry = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function save() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(registry, null, 2));
}

function archive(video) {
  registry[video.id] = {
    relativePath: video.relativePath,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
  };
  save();
}

function isArchived(id) {
  return Boolean(registry[id]);
}

function getAll() {
  return registry;
}

module.exports = { archive, isArchived, getAll };
