const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Inicio automático al encender el PC (solo Windows): un acceso directo a
// iniciar.bat en la carpeta Inicio del usuario (shell:startup). El estado
// es simplemente si ese acceso existe, así que también refleja lo que se
// haga a mano o desde el Administrador de tareas (deshabilitarlo ahí no lo
// borra, pero tampoco lo arranca: eso no se detecta).

const PROJECT_DIR = path.join(__dirname, '..');
const SHORTCUT_NAME = 'Videoclub Local.lnk';

function isSupported() {
  return process.platform === 'win32' && Boolean(process.env.APPDATA);
}

function shortcutPath() {
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', SHORTCUT_NAME);
}

function getStatus() {
  if (!isSupported()) return { supported: false, enabled: false };
  return { supported: true, enabled: fs.existsSync(shortcutPath()) };
}

// Las rutas van por variables de entorno y no dentro del comando para no
// tener que escapar comillas ni tildes de la ruta del proyecto.
// "silencioso" hace que iniciar.bat no saque el aviso de "Servidor en
// marcha" en cada encendido (los de error sí).
const CREATE_SCRIPT = [
  '$ws = New-Object -ComObject WScript.Shell',
  '$lnk = $ws.CreateShortcut($env:VC_LNK)',
  "$lnk.TargetPath = Join-Path $env:VC_DIR 'iniciar.bat'",
  "$lnk.Arguments = 'silencioso'",
  '$lnk.WorkingDirectory = $env:VC_DIR',
  "$lnk.IconLocation = (Join-Path $env:VC_DIR 'assets\\videoclub.ico') + ',0'",
  "$lnk.Description = 'Arrancar el servidor de Videoclub Local al encender el PC'",
  '$lnk.WindowStyle = 7',
  '$lnk.Save()',
].join('; ');

function createShortcut() {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(shortcutPath()), { recursive: true });
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', CREATE_SCRIPT],
      { windowsHide: true, env: { ...process.env, VC_LNK: shortcutPath(), VC_DIR: PROJECT_DIR } },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve();
      }
    );
  });
}

async function setEnabled(enabled) {
  if (!isSupported()) throw new Error('El inicio automático solo está disponible con el servidor en Windows.');
  const lnk = shortcutPath();
  if (enabled) {
    await createShortcut();
  } else if (fs.existsSync(lnk)) {
    fs.unlinkSync(lnk);
  }
  const status = getStatus();
  if (status.enabled !== enabled) {
    throw new Error(`No se pudo ${enabled ? 'crear' : 'borrar'} el acceso directo en ${path.dirname(lnk)}`);
  }
  return status;
}

module.exports = { getStatus, setEnabled };
