const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

// Fábrica para el patrón repetido en varios registros persistentes de
// server/ (archivedVideos.js, movedOriginals.js, lostVideos.js,
// catalogOverrides.js): un valor en memoria respaldado por un JSON en
// DATA_PATH, con su propia carga al arrancar, guardado tras cada cambio, y
// una recarga para POST /api/admin/reload (por si algo edita el archivo por
// fuera de este proceso: migración, restauración de backup...).
//
// Cada módulo sigue exponiendo su propia API (archive/isArchived/forget...,
// no esto directamente): esto solo evita repetir el load/save/reload. Como
// `get()` devuelve la misma referencia en memoria, mutarla in-place (añadir
// una clave, borrarla, `.add`/`.delete` de un Set...) y llamar a `save()`
// después es válido y es justo cómo lo usa cada módulo.
function createJsonRegistry(fileName, { defaultValue = {}, serialize, deserialize } = {}) {
  const filePath = path.join(DATA_PATH, fileName);
  const toText = serialize || ((data) => JSON.stringify(data, null, 2));
  const fromText = deserialize || JSON.parse;

  function load() {
    try {
      return fromText(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return defaultValue;
    }
  }

  let value = load();

  function save() {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(filePath, toText(value));
  }

  function reload() {
    value = load();
  }

  return { get: () => value, save, reload };
}

module.exports = { createJsonRegistry };
