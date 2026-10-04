const profiles = require('./profiles');

// Perfiles administradores (#152): solo ellos gestionan perfiles, tocan la
// configuración y editan el catálogo; el resto solo ve. La web manda el
// perfil activo en la cabecera X-Profile-Id (client/src/main.jsx).
//
// No es seguridad de verdad: no hay contraseñas (red local, SECURITY.md) y
// cualquiera puede elegir un perfil admin. Sirve para que un perfil de
// "solo ver" no pueda cambiar ni borrar nada por error.
//
// Se deja pasar siempre:
// - lo que llega del propio PC (vigilante, scripts de mantenimiento, curl a
//   127.0.0.1), que no es una persona eligiendo perfil;
// - todo, mientras no haya ningún admin (instalación nueva: si no, nadie
//   podría nombrar al primero).

// Rutas (sin /api) de las acciones de administrador.
const ADMIN_ROUTES = [
  /^\/profiles$/, // crear (POST)
  /^\/profiles\/[^/]+$/, // borrar (DELETE)
  /^\/profiles\/[^/]+\/admin$/,
  /^\/metadata\/(refresh|override|custom-name|anime|force-tmdb-all)$/,
  /^\/catalog\//,
  /^\/normalize\/(run|rename|merge-season)$/,
  /^\/settings(\/autostart)?$/,
  /^\/power\//,
  /^\/storage\//,
  /^\/scan$/,
  /^\/queue\/resolve-failed$/,
  /^\/admin\//,
];

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requesterIsAdmin(req) {
  if (isLoopback(req)) return true;
  const all = profiles.listProfiles();
  if (!all.some((p) => p.admin)) return true;
  const id = req.get('X-Profile-Id');
  return all.some((p) => p.id === id && p.admin);
}

function adminGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!ADMIN_ROUTES.some((re) => re.test(req.path))) return next();
  if (requesterIsAdmin(req)) return next();
  res.status(403).json({ error: 'Solo un perfil administrador puede hacer esto.' });
}

module.exports = { adminGuard, requesterIsAdmin };
