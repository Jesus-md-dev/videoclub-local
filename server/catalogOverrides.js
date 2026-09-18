const { createJsonRegistry } = require('./jsonRegistry');

// Claves de agrupación (ver catalog.js:groupKeyFor) que, aunque tengan más
// de un vídeo en su carpeta, NO son una serie/anime sino varios títulos
// sueltos metidos en la misma carpeta (p.ej. "Berserk" con las 3 películas
// de "La Edad de Oro"): se listan cada una como su propia película en vez
// de agruparse como una sola "carpeta".
const store = createJsonRegistry('catalog-ungrouped.json', {
  defaultValue: new Set(),
  serialize: (set) => JSON.stringify([...set], null, 2),
  deserialize: (text) => new Set(JSON.parse(text)),
});

function isUngrouped(key) {
  return store.get().has(key);
}

function setUngrouped(key, value) {
  const ungrouped = store.get();
  if (value) ungrouped.add(key);
  else ungrouped.delete(key);
  store.save();
}

module.exports = { isUngrouped, setUngrouped, reloadUngrouped: store.reload };
