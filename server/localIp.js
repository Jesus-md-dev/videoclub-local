const os = require('os');

// IP de este PC en la LAN (no loopback): se le pasa tal cual a los
// dispositivos DLNA/Chromecast como origen del vídeo, ya que ellos vuelven a
// pedir la URL por su cuenta, no basta con la petición HTTP que ya tenemos.
function localIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

module.exports = { localIp };
