const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');
const { DATA_PATH } = require('./config');

const CERT_DIR = path.join(DATA_PATH, 'cert');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');

function localIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

// Certificado autofirmado: no hay dominio real (es una app solo de red
// local), así que no puede haber un certificado "de verdad" firmado por una
// autoridad reconocida. El navegador seguirá avisando de que no confía en
// él (hay que aceptarlo manualmente la primera vez en cada dispositivo);
// eso es inherente a usar HTTPS sin un dominio público, no un fallo de la
// app. Se incluyen como nombres válidos localhost y las IPs de red actuales
// para que el aviso sea solo de "no confiable", no de "dominio equivocado".
async function generateCert(extraIps = []) {
  const ips = [...new Set([...localIps(), ...extraIps])].filter((ip) => ip !== '127.0.0.1');
  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    { type: 7, ip: '127.0.0.1' }, // IP
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'videoclub-local' }], {
    notAfterDate,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, pems.private);
  fs.writeFileSync(CERT_FILE, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// IPs para las que vale un certificado (su subjectAltName).
function certIps(certPem) {
  try {
    const san = new crypto.X509Certificate(certPem).subjectAltName || '';
    return san
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('IP Address:'))
      .map((part) => part.slice('IP Address:'.length));
  } catch {
    return [];
  }
}

// Si el PC cambia de IP, el certificado guardado deja de valer para la
// nueva y los navegadores rechazan la conexión por nombre incorrecto
// (pasó de 192.168.1.47 a 192.168.1.200, #149). Al arrancar se comprueba
// y, si falta alguna IP actual, se genera otro con las de antes más las
// nuevas. El viejo se guarda al lado (.old-<fecha>), no se borra. Los
// dispositivos que lo tenían instalado como de confianza tienen que volver
// a instalarlo desde /cert.
async function getOrCreateCert() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    const cert = fs.readFileSync(CERT_FILE);
    const covered = certIps(cert);
    const missing = localIps().filter((ip) => !covered.includes(ip));
    if (missing.length === 0) return { key: fs.readFileSync(KEY_FILE), cert };
    const stamp = new Date().toISOString().slice(0, 10);
    fs.renameSync(CERT_FILE, `${CERT_FILE}.old-${stamp}`);
    fs.renameSync(KEY_FILE, `${KEY_FILE}.old-${stamp}`);
    console.log(`Certificado HTTPS regenerado: no valía para ${missing.join(', ')} (el anterior queda como .old-${stamp}).`);
    return generateCert(covered);
  }
  return generateCert();
}

module.exports = { getOrCreateCert, CERT_FILE };
