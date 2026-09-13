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
async function generateCert() {
  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    { type: 7, ip: '127.0.0.1' }, // IP
    ...localIps().map((ip) => ({ type: 7, ip })),
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

async function getOrCreateCert() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
  }
  return generateCert();
}

module.exports = { getOrCreateCert, CERT_FILE };
