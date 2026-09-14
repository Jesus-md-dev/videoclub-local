const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

// Claves de agrupación (ver catalog.js:groupKeyFor) que, aunque tengan más
// de un vídeo en su carpeta, NO son una serie/anime sino varios títulos
// sueltos metidos en la misma carpeta (p.ej. "Berserk" con las 3 películas
// de "La Edad de Oro"): se listan cada una como su propia película en vez
// de agruparse como una sola "carpeta".
const FILE = path.join(DATA_PATH, 'catalog-ungrouped.json');

let ungrouped = load();

function load() {
  try {
    return new Set(JSON.parse(fs.readFileSync(FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function save() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify([...ungrouped], null, 2));
}

function isUngrouped(key) {
  return ungrouped.has(key);
}

function setUngrouped(key, value) {
  if (value) ungrouped.add(key);
  else ungrouped.delete(key);
  save();
}

module.exports = { isUngrouped, setUngrouped };
