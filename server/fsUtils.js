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

// Borra un archivo suelto (no carpetas). No usar fs.rmSync para esto: en
// Node 24 sobre Windows vuelve SIN error y deja el archivo en su sitio si
// el nombre lleva caracteres no ASCII ("más", "Dónde"...) - visto de
// verdad con los traslados a D:, que "borraban" el original de E: sin
// liberar nada. fs.unlinkSync sí funciona; que ya no exista no es error.
function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { migrateFile, unlinkIfExists };
