const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const router = express.Router();

function listDrives() {
  if (os.platform() !== 'win32') {
    return [{ name: '/', path: '/' }];
  }
  const drives = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drivePath = `${letter}:\\`;
    if (fs.existsSync(drivePath)) {
      drives.push({ name: drivePath, path: drivePath });
    }
  }
  return drives;
}

function listSubfolders(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`La carpeta no existe: ${resolved}`);
  }

  const entries = fs
    .readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$'))
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const parsed = path.parse(resolved);
  const isRoot = resolved === parsed.root;
  const parent = isRoot ? null : path.dirname(resolved);

  return { path: resolved, parent, entries };
}

router.get('/browse', (req, res) => {
  const { path: targetPath } = req.query;

  try {
    if (!targetPath) {
      res.json({ path: null, parent: null, entries: listDrives() });
      return;
    }
    res.json(listSubfolders(targetPath));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
