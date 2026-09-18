const mdns = require('multicast-dns');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const profiles = require('./profiles');
const { getMediaInfo } = require('./mediaInfo');
const { localIp } = require('./localIp');
const { PORT } = require('./config');

// A diferencia de DLNA (dlna.js/castSource.js), que necesita remuxear los
// vídeos "archivados" a un MP4 de verdad porque un reproductor DLNA no
// entiende manifiestos HLS, Chromecast SÍ soporta HLS de forma nativa
// (Shaka Player, el mismo motor que usa el "Default Media Receiver") - así
// que aquí no hace falta remuxear nada, se apunta directamente al mismo
// master.m3u8 que ya sirve al reproductor web, valga o no el original.
// Confirmado que el remux SÍ fallaba de verdad contra una Xiaomi TV real:
// la carga se quedaba colgada ~10s y acababa en LOAD_FAILED.
function buildSource(video) {
  const ip = localIp();
  return { url: `http://${ip}:${PORT}/api/hls/${video.id}/master.m3u8`, type: 'application/x-mpegURL' };
}

// Descubrimiento de Chromecast (y de cualquier TV con Chromecast integrado,
// como las Xiaomi/Android TV - ver issue #109) por mDNS ("_googlecast._tcp"),
// no por SSDP: es un protocolo totalmente distinto al DLNA de dlna.js, así
// que necesita su propio módulo entero, no solo un ajuste del de DLNA.
//
// La librería de referencia (chromecast-api) hace exactamente esto por
// debajo, pero sin fijar la interfaz de red por la que envía la consulta
// mDNS - en un PC con varios adaptadores a la vez (Ethernet + VPN + punto de
// acceso + Bluetooth, el caso real de este servidor) eso puede acabar
// enviando la consulta por un adaptador que no llega a la LAN de verdad, y
// entonces NUNCA encuentra nada aunque la red esté bien configurada (visto
// de verdad: con la interfaz sin fijar, 0 dispositivos; fijándola a la IP
// real de la LAN, aparece la TV al momento). Por eso se reimplementa aquí el
// descubrimiento a mano (bind explícito con localIp()) en vez de usar esa
// librería tal cual.
const devices = new Map(); // id (nombre mDNS) -> { id, name, host }
let mdnsClient = null;
let queryTimer = null;
const QUERY_INTERVAL_MS = 15000;

function startDiscovery() {
  if (mdnsClient) return;
  const ip = localIp();
  mdnsClient = mdns(ip ? { interface: ip, bind: ip } : undefined);

  mdnsClient.on('response', (response) => {
    const all = [...response.answers, ...response.additionals];
    for (const a of all) {
      if (a.type === 'PTR' && a.name === '_googlecast._tcp.local') {
        const id = a.data;
        if (!devices.has(id)) devices.set(id, { id, name: null, host: null, target: null });
      }
    }
    // Dos pasadas a propósito: el SRV (nombre de host mDNS, ej.
    // "Xiaomi-TV.local") suele llegar en el mismo paquete que su propio
    // registro A (la IP de verdad), pero no hay garantía de orden - hace
    // falta tener ya todos los "target" de esta ronda antes de poder
    // emparejarlos con sus A.
    for (const a of all) {
      const entry = devices.get(a.name);
      if (!entry) continue;
      if (a.type === 'SRV' && a.data?.target) entry.target = a.data.target;
      if (a.type === 'TXT') {
        // multicast-dns ya entrega cada "clave=valor" del registro TXT como
        // un Buffer suelto (sin el byte de longitud del formato original,
        // ya consumido al parsear) - librerías como dns-txt esperan el
        // bloque SIN trocear y, si se les pasa un trozo ya suelto, confunden
        // su primer carácter con ese byte de longitud (visto de verdad:
        // "fn=TV del salón" decodificado como clave "n" en vez de "fn"). Se
        // parsea aquí mismo, a mano, sin esa librería de por medio.
        try {
          const buffers = Array.isArray(a.data) ? a.data : [a.data];
          for (const buf of buffers) {
            const text = buf.toString('utf8');
            const eq = text.indexOf('=');
            if (eq === -1) continue;
            const k = text.slice(0, eq);
            const v = text.slice(eq + 1);
            if (k === 'fn') entry.name = v;
          }
        } catch {
          // Un TXT mal formado no debe tirar el descubrimiento entero.
        }
      }
    }
    for (const a of all) {
      if (a.type !== 'A') continue;
      for (const entry of devices.values()) {
        if (entry.target === a.name) entry.host = a.data;
      }
    }
  });

  const query = () => mdnsClient.query('_googlecast._tcp.local', 'PTR');
  query();
  queryTimer = setInterval(query, QUERY_INTERVAL_MS);
}

// Se arranca perezosamente (a la primera consulta de /api/chromecast/devices),
// no al cargar el módulo: así un servidor que nunca usa esta función no deja
// un socket mDNS abierto todo el rato sin motivo.
function getDevices() {
  startDiscovery();
  return [...devices.values()].filter((d) => d.name && d.host).map((d) => ({ id: d.id, name: d.name }));
}

const STATUS_POLL_MS = 5000;

// Igual que dlna.js: solo una emisión activa a la vez.
let session = null;

function clearStatusTimer() {
  if (session?.timer) clearInterval(session.timer);
}

function startStatusPolling() {
  clearStatusTimer();
  session.timer = setInterval(() => {
    if (!session) return;
    // El callback de castv2-client se invoca desde dentro de un manejador
    // de evento de la librería, no de una promesa: una excepción sin
    // capturar aquí no se quedaría en esta función, tiraría el proceso de
    // Node ENTERO (todo el servidor, no solo la emisión) - visto de verdad
    // durante las pruebas (getStatus puede responder con un status vacío,
    // por ejemplo en transiciones de estado de la propia TV).
    try {
      session.player.getStatus((err, status) => {
        try {
          if (err || !session || !status) return;
          session.lastStatus = status;
          if (status.currentTime != null && session.durationSeconds) {
            const ratio = Math.min(1, status.currentTime / session.durationSeconds);
            profiles.setProgress(session.profileId, session.videoId, { time: status.currentTime, ratio });
          }
        } catch (err2) {
          console.warn(`Chromecast: fallo procesando el estado: ${err2.message}`);
        }
      });
    } catch (err) {
      console.warn(`Chromecast: fallo pidiendo el estado: ${err.message}`);
    }
  }, STATUS_POLL_MS);
}

function connectClient(host) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('error', reject);
    client.connect(host, () => {
      client.removeListener('error', reject);
      resolve(client);
    });
  });
}

function launchReceiver(client) {
  return new Promise((resolve, reject) => {
    client.launch(DefaultMediaReceiver, (err, player) => {
      if (err) reject(err);
      else resolve(player);
    });
  });
}

// Fallo real de castv2-client, en dos partes:
//  1) Tras cargar, NO guarda por su cuenta el mediaSessionId donde luego lo
//     busca pausar/reanudar/buscar (MediaController.currentSession) - solo
//     lo hace dentro de getStatus() o al recibir un MEDIA_STATUS de la
//     propia TV.
//  2) getStatus() en sí MISMO sobrescribe currentSession con lo que
//     responda la TV, VACÍO INCLUIDO - y la Xiaomi TV real responde vacío a
//     getStatus() con mucha frecuencia incluso con la emisión ya en marcha
//     de verdad (visto con DEBUG=castv2-client: más de 20 peticiones
//     GET_STATUS seguidas sin una sola respuesta útil). O sea que llamar a
//     getStatus() para "confirmar" la sesión antes de pausar en realidad
//     puede BORRARLA en vez de confirmarla.
//
// La solución de verdad: guardar el mediaSessionId por cuenta propia (en
// "session.mediaSessionId" más abajo, no en la propiedad de la librería) a
// partir de la respuesta de load() -que sí lo trae siempre, en menos de
// 200ms- y de cualquier MEDIA_STATUS que llegue después por su cuenta
// (evento "status"), y reconstruir player.media.currentSession a mano justo
// antes de cada orden (ver refreshSession) en vez de fiarse de lo que haya
// podido dejar getStatus() por el camino.
function loadMedia(player, url, type, title) {
  return new Promise((resolve, reject) => {
    player.load(
      { contentId: url, contentType: type, streamType: 'BUFFERED', metadata: { type: 0, metadataType: 0, title } },
      { autoplay: true },
      (err, status) => (err ? reject(err) : resolve(status?.mediaSessionId ?? null))
    );
  });
}

async function cast({ deviceId, video, profileId, audioIndex }) {
  const device = devices.get(deviceId);
  if (!device || !device.host) {
    throw new Error('Dispositivo no encontrado (puede que se haya desconectado, prueba a refrescar la lista).');
  }

  let durationSeconds = null;
  try {
    const info = await getMediaInfo(video);
    durationSeconds = Number(info.format?.duration) || null;
  } catch {
    // Sin duración no se puede calcular el ratio de progreso, pero la
    // emisión en sí no depende de esto - no es motivo para fallar.
  }

  // Una emisión anterior deja su conexión TCP abierta con el Chromecast
  // hasta que se cierra explícitamente (a diferencia de DLNA, aquí no basta
  // con "olvidarla" - el propio dispositivo se queda "ocupado" si no).
  await stop();

  const { url, type } = buildSource(video);
  const client = await connectClient(device.host);
  let player;
  let mediaSessionId;
  try {
    player = await launchReceiver(client);
    mediaSessionId = await loadMedia(player, url, type, video.title);
  } catch (err) {
    client.close();
    throw err;
  }

  session = { deviceId, videoId: video.id, profileId, client, player, mediaSessionId, durationSeconds, lastStatus: null, timer: null };
  // Cualquier MEDIA_STATUS que la TV envíe por su cuenta a partir de ahora
  // (normal en cuanto arranca de verdad, o tras un pausar/buscar) trae el
  // mediaSessionId real más al día - se guarda tal cual sin más lógica.
  player.on('status', (status) => {
    if (session && status?.mediaSessionId != null) session.mediaSessionId = status.mediaSessionId;
  });
  startStatusPolling();
}

function requireSession() {
  if (!session) throw new Error('No hay ninguna emisión activa.');
  return session;
}

// Reconstruye a mano el "currentSession" que castv2-client necesita para
// cualquier orden (pausar/reanudar/buscar) a partir del mediaSessionId que
// llevamos nosotros mismos (ver el comentario de loadMedia más arriba) -
// llamar a getStatus() aquí para "confirmarlo" sería justo el error que
// causaba el fallo original, no la solución.
function primeCurrentSession(session, mediaSessionId) {
  session.player.media.currentSession = { mediaSessionId: mediaSessionId ?? session.mediaSessionId };
}

// El mediaSessionId de la respuesta de load() deja de valer en algún
// momento entre que empieza a cargar y que la Xiaomi TV termina de
// preparar la reproducción de verdad (visto en directo: pausar unos
// segundos después fallaba con INVALID_MEDIA_SESSION_ID aunque se había
// guardado bien al principio) - un solo getStatus() en ese momento, sin
// esperas ni reintentos en bucle, suele traer ya el id real vigente; si
// ni con eso responde, se deja el error tal cual (no tiene sentido
// reintentar más de una vez contra un dispositivo que no está respondiendo).
function runControl(action) {
  return new Promise((resolve, reject) => {
    const s = requireSession();
    primeCurrentSession(s);
    action(s.player, (err) => {
      if (!err || err.message !== 'Invalid request: INVALID_MEDIA_SESSION_ID') {
        if (err) reject(err);
        else resolve();
        return;
      }
      s.player.getStatus((err2, status) => {
        if (err2 || !status?.mediaSessionId) {
          reject(err);
          return;
        }
        s.mediaSessionId = status.mediaSessionId;
        primeCurrentSession(s, status.mediaSessionId);
        action(s.player, (err3) => (err3 ? reject(err3) : resolve()));
      });
    });
  });
}

function pause() {
  return runControl((player, cb) => player.pause(cb));
}

function resume() {
  return runControl((player, cb) => player.play(cb));
}

function seek(seconds) {
  return runControl((player, cb) => player.seek(seconds, cb));
}

function stop() {
  return new Promise((resolve) => {
    if (!session) {
      resolve();
      return;
    }
    const { client } = session;
    clearStatusTimer();
    session = null;
    try {
      client.close();
    } catch {
      // Ya desconectado por su cuenta (p.ej. la TV se apagó) - no es un fallo.
    }
    resolve();
  });
}

function getStatus() {
  if (!session) return { active: false };
  return {
    active: true,
    deviceId: session.deviceId,
    videoId: session.videoId,
    currentTime: session.lastStatus?.currentTime ?? null,
    playerState: session.lastStatus?.playerState ?? null,
  };
}

module.exports = {
  getDevices,
  cast,
  pause,
  resume,
  seek,
  stop,
  getStatus,
};
