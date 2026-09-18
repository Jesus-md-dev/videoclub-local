const fs = require('fs');
const path = require('path');
const { DATA_PATH } = require('./config');

// El progreso de visionado se guarda por perfil, un archivo JSON en
// DATA_PATH/progress/ por cada uno, cada uno un objeto { [videoId]: {...} }.
// Migrar o borrar un id (al renombrar un vídeo, sustituirlo por su
// conversión, o purgar una obra) significa tocar TODOS esos archivos por
// igual - antes era la misma implementación copiada literalmente en
// dedupe.js, normalize.js y purge.js.
const PROGRESS_DIR = path.join(DATA_PATH, 'progress');

// Aplica `mutate(data)` a cada archivo de progreso; si devuelve true,
// reescribe el archivo. Un archivo con JSON inválido se ignora (no debería
// pasar, pero un progreso roto no debe impedir migrar/purgar el resto).
function forEachProgressFile(mutate) {
  if (!fs.existsSync(PROGRESS_DIR)) return;
  for (const file of fs.readdirSync(PROGRESS_DIR)) {
    const full = path.join(PROGRESS_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }
    if (mutate(data)) fs.writeFileSync(full, JSON.stringify(data, null, 2));
  }
}

// El id de un vídeo sale de un hash de su ruta relativa: renombrarlo o
// sustituirlo por su conversión cambia el id, así que su progreso guardado
// hay que migrarlo al nuevo para no perderlo. Si `newId` ya tenía progreso
// propio, el de `oldId` no lo pisa (por si alguna vez coincidieran).
function migrateProgressId(oldId, newId) {
  forEachProgressFile((data) => {
    if (!data[oldId]) return false;
    data[newId] = { ...data[oldId], ...(data[newId] || {}) };
    delete data[oldId];
    return true;
  });
}

// Borra el progreso de una lista de ids (al purgar una obra del todo).
function removeProgressIds(ids) {
  const idSet = new Set(ids);
  forEachProgressFile((data) => {
    let changed = false;
    for (const id of idSet) {
      if (data[id]) {
        delete data[id];
        changed = true;
      }
    }
    return changed;
  });
}

module.exports = { migrateProgressId, removeProgressIds };
