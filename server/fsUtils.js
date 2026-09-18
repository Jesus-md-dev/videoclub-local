const fs = require('fs');

// Renombra oldPath a newPath si el destino no existe ya - usado al migrar lo
// que cuelga de un id viejo a uno nuevo tras renombrar/sustituir un vídeo
// (carátula, vista previa, carpeta de HLS, subtítulos...). Sirve igual para
// un archivo suelto que para una carpeta entera (fs.renameSync no distingue).
function migrateFile(oldPath, newPath) {
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
  }
}

module.exports = { migrateFile };
