const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getVideosPath, VIDEO_EXTENSIONS } = require('./config');
const archivedVideos = require('./archivedVideos');
const movedOriginals = require('./movedOriginals');
const catalogOverrides = require('./catalogOverrides');
const hls = require('./hls');
const metadata = require('./metadata');
const { createJsonRegistry } = require('./jsonRegistry');

// Claves que alguna vez han sido serie (más de un vídeo): { <clave>: true }.
// Sin esto, una serie a la que solo le queda un episodio (los demás
// borrados tras verlos, o aún descargándose) pasaba a mostrarse como
// película suelta. Ver buildLibrary.
const knownShows = createJsonRegistry('known-shows.json');
// Marca de episodio en el título ("S01E05", "1x05"): un único vídeo así
// dentro de una carpeta es el primer episodio de una serie, no una película.
const EPISODE_MARKER_PATTERN = /S\d{1,2}E\d{1,4}|(?:^|[\s\-_.])\d{1,2}x\d{1,4}(?:[\s\-_.]|$)/i;

let cache = [];
let byId = new Map();
let showsList = []; // agrupaciones con más de un vídeo (series/anime)
let moviesList = []; // vídeos sueltos (películas)
let showVideos = new Map(); // clave de serie -> vídeos ordenados

// Episodios sueltos sin carpeta propia ("Mushoku Tensei III - Isekai Ittara
// Honki Dasu - 01.mkv" ... "- 14.mkv" en la raíz, #160): sin esto cada uno
// tenía su propio título como clave y salían como 14 películas. Si al menos
// dos títulos sueltos comparten nombre y solo cambia un número de episodio
// final (" - 01"), se agrupan como serie con ese nombre como clave. No se
// mueve ningún archivo (ver #118), así que los ids no cambian.
const LOOSE_EPISODE_PATTERN = /^(.+?)\s+-\s+(\d{2,4})$/;
let looseSeriesKeys = new Map(); // título del vídeo -> clave de serie

function computeLooseSeriesKeys(videos) {
  const byPrefix = new Map();
  for (const video of videos) {
    if (groupKeyFor(video, { loose: false }) !== video.title) continue;
    const match = video.title.match(LOOSE_EPISODE_PATTERN);
    if (!match) continue;
    const prefix = match[1].trim();
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(video.title);
  }
  const keys = new Map();
  for (const [prefix, titles] of byPrefix) {
    if (titles.length < 2) continue;
    for (const title of titles) keys.set(title, prefix);
  }
  return keys;
}
// Cuántos vídeos archivados están además "perdidos" (isLost) en el último
// escaneo - no se cuenta con lostVideos.js (registro histórico que solo
// crece, puede tener entradas obsoletas de ids que ya no existen tras un
// renombrado) sino en vivo, aquí mismo, cada vez que se escanea de verdad.
let lostCount = 0;

function makeId(relativePath) {
  return crypto.createHash('sha1').update(relativePath).digest('hex').slice(0, 16);
}

function cleanTitle(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nombres de carpeta que son categorías genéricas, no el título de una obra
// concreta (p.ej. "Anime", "Peliculas"). Se ignoran al buscar la clave de
// agrupación de un vídeo, para no acabar agrupando por "Anime" o "Peliculas"
// en vez del título real.
const GENERIC_FOLDER_NAMES = new Set([
  'anime', 'peliculas', 'películas', 'pelis', 'series', 'movies', 'movie',
  'tv', 'shows', 'videos', 'video', 'films', 'film', 'dorama', 'doramas',
  // Variantes de idioma/audio, habituales como subcarpeta dentro de una categoría.
  'castellano', 'español', 'espanol', 'latino', 'subtitulado', 'subtitulados',
  'vose', 'dual', 'japones', 'japonés', 'ingles', 'inglés',
]);

// Subcarpetas por arco/temporada/tanda de episodios dentro de una misma obra
// (ej. "[442-489] Thriller Bark", "Temporada 2", "Season 3", "Arc 5"): no son
// el nombre de la obra, sino una subdivisión suya, así que también se tratan
// como genéricas para que la agrupación siga subiendo hasta el nombre real.
const RANGE_OR_SEASON_PATTERN =
  /^\[?\(?\s*\d+\s*[-–]\s*\d+\s*\)?\]?(\s|$)|^(temporada|season|arco|arc|saga|cour|parte|part|volumen|vol)\.?\s*\d+(\s|$)/i;

// Abreviatura española de "Temporada N" usada como nombre de carpeta ENTERO
// (ej. "T1", "T2", "T3", "T4"): a diferencia de RANGE_OR_SEASON_PATTERN, se
// exige que sea el nombre completo de la carpeta (no solo el prefijo) para
// no confundir con títulos reales que empiecen por "T" + número (ej. una
// carpeta de película "T2 Judgment Day").
const SHORT_SEASON_PATTERN = /^t\.?\s*\d{1,3}$/i;

// Ordinales en palabra (no dígito) usados en subtítulos de entrega/saga de
// anime, ej. "Initial D First Stage" / "Initial D Segunda Etapa": el propio
// RANGE_OR_SEASON_PATTERN no los reconoce porque exige un número.
const SAGA_ORDINAL_WORDS =
  'primera|segunda|tercera|cuarta|quinta|sexta|s[ée]ptima|octava|novena|d[ée]cima|[uú]ltima|' +
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|final|last|extra|new';
const SAGA_STAGE_WORDS = 'etapa|stage';

// Carpeta que es SOLO el marcador de saga, sin el título (ej. "First Stage"
// dentro de una carpeta padre "Initial D"): se trata como genérica para
// seguir subiendo hasta el título real, igual que RANGE_OR_SEASON_PATTERN.
const STANDALONE_SAGA_PATTERN = new RegExp(
  `^(?:${SAGA_ORDINAL_WORDS})\\s+(?:${SAGA_STAGE_WORDS})(\\s|$)`,
  'i'
);

// Título con el marcador de saga pegado en la misma carpeta (ej. "Initial D
// First Stage", sin carpeta padre separada): captura el título base para
// que todas las entregas agrupen bajo la misma clave.
const TITLE_WITH_SAGA_SUFFIX_PATTERN = new RegExp(
  `^(.+?)\\s+(?:${SAGA_ORDINAL_WORDS})\\s+(?:${SAGA_STAGE_WORDS})$`,
  'i'
);

function isGenericFolderName(name) {
  const clean = name.trim().toLowerCase();
  return (
    GENERIC_FOLDER_NAMES.has(clean) ||
    RANGE_OR_SEASON_PATTERN.test(clean) ||
    SHORT_SEASON_PATTERN.test(clean) ||
    STANDALONE_SAGA_PATTERN.test(clean)
  );
}

// Quita un sufijo de saga pegado al título (ver TITLE_WITH_SAGA_SUFFIX_PATTERN)
// para obtener el título base de agrupación. Si no hay sufijo, devuelve el
// nombre tal cual.
function stripSagaSuffix(name) {
  const match = name.match(TITLE_WITH_SAGA_SUFFIX_PATTERN);
  return match ? match[1].trim() : name;
}

// Mismos marcadores numéricos que RANGE_OR_SEASON_PATTERN/SHORT_SEASON_PATTERN,
// pero capturando el número en vez de solo detectar que la carpeta es
// genérica: agruparla como serie descarta ese número (no hace falta para
// agrupar), pero sí hace falta para reconstruir "S04E07" en episodios cuyo
// nombre de archivo es solo el número (ver normalize.js: extractEpisodeMarker).
const NUMBERED_SEASON_CAPTURE_PATTERN =
  /^(?:temporada|season|arco|arc|saga|cour|parte|part|volumen|vol)\.?\s*(\d+)(\s|$)/i;
const SHORT_SEASON_CAPTURE_PATTERN = /^t\.?\s*(\d{1,3})$/i;

function seasonNumberForFolder(name) {
  const clean = name.trim().toLowerCase();
  let match = clean.match(NUMBERED_SEASON_CAPTURE_PATTERN);
  if (match) return Number(match[1]);
  match = clean.match(SHORT_SEASON_CAPTURE_PATTERN);
  if (match) return Number(match[1]);
  return null;
}

// Número de temporada de un vídeo a partir de su carpeta contenedora
// inmediata (ej. "Initial D/T4/07.mp4" -> 4), o null si no se reconoce
// ninguna marca de temporada ahí.
function seasonNumberFor(video) {
  const folderSegments = video.relativePath.split(path.sep).slice(0, -1);
  if (folderSegments.length === 0) return null;
  const immediateParent = cleanTitle(folderSegments[folderSegments.length - 1]);
  return seasonNumberForFolder(immediateParent);
}

// Clave de agrupación para un vídeo: el nombre de la carpeta contenedora más
// específica (la más profunda que no sea una categoría genérica), asumiendo
// que agrupa otros vídeos de la misma obra (ej. episodios de una serie). Si
// no hay ninguna carpeta así en la ruta, se usa el propio título del
// archivo. No se asume de antemano si es serie o película por estructura de
// carpetas: eso lo decide cuántos vídeos comparten la clave y la propia
// búsqueda de metadatos.
function groupKeyFor(video, { loose = true } = {}) {
  const folderSegments = video.relativePath.split(path.sep).slice(0, -1);
  for (let i = folderSegments.length - 1; i >= 0; i -= 1) {
    const name = cleanTitle(folderSegments[i]);
    if (!isGenericFolderName(name)) {
      // Carpeta marcada como "no es una serie, son varios títulos sueltos"
      // (ver catalogOverrides.js, p.ej. "Berserk" con sus 3 películas de
      // "La Edad de Oro"): cada vídeo usa su propio título como clave, así
      // que buildLibrary() los trata como películas independientes en vez
      // de agruparlos todos bajo la misma carpeta.
      if (catalogOverrides.isUngrouped(name)) return video.title;
      return stripSagaSuffix(name);
    }
  }
  // Episodio suelto de una serie sin carpeta (ver looseSeriesKeys).
  if (loose && looseSeriesKeys.has(video.title)) return looseSeriesKeys.get(video.title);
  return video.title;
}

// Asíncrono a propósito (fs.promises, no fs...Sync): con la carpeta de
// vídeos en un disco externo, una sola llamada síncrona lenta (el disco
// saturado por streaming/conversión/copia a la vez) bloqueaba el bucle de
// eventos de Node entero mientras duraba - el servidor se quedaba sin
// responder a NINGUNA petición, a veces varios segundos, a veces mucho
// más. Con await, solo esta función concreta espera; el resto del
// servidor sigue atendiendo peticiones mientras tanto.
// Recorre a mano SOLO dentro de una "junction" (carpeta-enlace NTFS) que
// recursive:true de fs.readdir se saltó (la lista como entrada pero no
// entra a mirar dentro, en Windows). No se usa hoy en producción (el
// traslado de originales a otro disco, moveOriginal.js/movedOriginals.js,
// acabó usando un registro en vez de junctions - ver ese módulo), pero se
// deja como red de seguridad por si alguna vez se crea una a mano dentro
// de la biblioteca: sin esto, su contenido se esfumaría del catálogo sin
// más aviso.
async function walkReparsePoint(dir, results) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // Enlace roto (destino desconectado/borrado): se ignora.
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const target = await fs.promises.stat(fullPath);
        isDir = target.isDirectory();
        isFile = target.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) {
      // eslint-disable-next-line no-await-in-loop
      await walkReparsePoint(fullPath, results);
      continue;
    }
    if (!isFile) continue;
    if (!VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.promises.stat(fullPath);
    results.push({ fullPath, title: cleanTitle(entry.name), size: stat.size, modifiedAt: stat.mtime });
  }
}

// Un único fs.readdir recursivo (rápido, una sola llamada por lo demás en
// vez de miles secuenciales contra el disco externo - una versión anterior
// que recorría TODO a mano, carpeta por carpeta, resultó mucho más lenta a
// esta escala y llegó a dejar el arranque/reescaneo colgado con 2000+
// vídeos). Solo entra a mano (walkReparsePoint) en las pocas carpetas que
// resulten ser una junction, si es que hay alguna.
async function walk(baseDir) {
  const entries = await fs.promises.readdir(baseDir, { recursive: true, withFileTypes: true });
  const results = [];
  const reparsePoints = [];

  for (const entry of entries) {
    const parentDir = entry.parentPath ?? entry.path;
    const fullPath = path.join(parentDir, entry.name);
    if (entry.isSymbolicLink()) {
      reparsePoints.push(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.promises.stat(fullPath);
    results.push({ fullPath, title: cleanTitle(entry.name), size: stat.size, modifiedAt: stat.mtime });
  }

  for (const reparsePoint of reparsePoints) {
    // eslint-disable-next-line no-await-in-loop
    await walkReparsePoint(reparsePoint, results);
  }

  return results.map((r) => ({
    id: makeId(path.relative(baseDir, r.fullPath)),
    title: r.title,
    relativePath: path.relative(baseDir, r.fullPath),
    size: r.size,
    modifiedAt: r.modifiedAt,
  }));
}

// Agrupa el catálogo por `groupKeyFor`: las claves con más de un vídeo se
// tratan como series/anime (mostradas como carpeta), y las de un único
// vídeo como películas sueltas. Esto ignora la carpeta física real en la
// que esté cada archivo: la agrupación es por lo detectado, no por disco.
// Quita acentos/mayúsculas/puntuación para comparar títulos a pesar de
// pequeñas diferencias de formato ("Air Gear" vs "AIR GEAR:").
function normalizeForMatch(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ¿Aparece "needle" como frase completa (con límites de palabra, no a
// media palabra) dentro de "haystack"? "air gear" sí debe encontrarse en
// "air gear kuro no hane..." pero "gear" no debería confundirse con parte
// de otra palabra.
function containsAsPhrase(haystack, needle) {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystack);
}

// Un vídeo suelto (título usado como su propia clave, ver groupKeyFor) cuyo
// nombre se parece mucho al de una serie que YA existe en el catálogo casi
// siempre es un episodio mal colocado (fuera de la carpeta de esa serie),
// no una obra nueva - visto de verdad con las OVAs de "Air Gear" sueltas
// directamente en Anime/ en vez de dentro de Anime/.../Air Gear/, contadas
// como dos "películas" independientes hasta que se movieron a mano. Esto
// no las mueve solo (podría equivocarse), solo avisa en el log para que
// se revise.
function looksLikeSameWork(candidateTitle, existingKey) {
  const a = normalizeForMatch(candidateTitle);
  const b = normalizeForMatch(existingKey);
  if (!a || !b || b.length < 4 || a === b) return false;
  return containsAsPhrase(a, b) || containsAsPhrase(b, a);
}

function buildLibrary() {
  looseSeriesKeys = computeLooseSeriesKeys(cache);
  const groups = new Map();
  for (const video of cache) {
    const key = groupKeyFor(video);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }

  showsList = [];
  moviesList = [];
  showVideos = new Map();

  // Un solo vídeo también es serie si su clave ya lo fue antes, o si está
  // en una carpeta propia (clave distinta de su título) y trae marca de
  // episodio o su ficha de metadatos dice que es una serie. Una película en
  // su carpeta ("Matrix (1999)/Matrix (1999).mkv") no cumple nada de eso.
  const known = knownShows.get();
  let learned = false;
  const isShow = (key, videos) => {
    if (videos.length > 1) {
      if (!known[key]) {
        known[key] = true;
        learned = true;
      }
      return true;
    }
    if (known[key]) return true;
    if (key === videos[0].title) return false;
    if (EPISODE_MARKER_PATTERN.test(videos[0].title)) return true;
    // Sin marca de episodio: lo que diga la ficha de TMDB (o Jikan/TVmaze)
    // de la carpeta. Si aún no la hay, se pide, y al llegar se rehace la
    // biblioteca si resulta ser una serie.
    const series = metadata.isSeries(key);
    if (series === null) {
      metadata.getMetadata(key).then(() => {
        if (metadata.isSeries(key) && !showVideos.has(key)) buildLibrary();
      });
    }
    return series === true;
  };
  const showKeys = [...groups.entries()].filter(([key, videos]) => isShow(key, videos)).map(([key]) => key);
  if (learned) knownShows.save();

  for (const [key, videos] of groups) {
    videos.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'es', { numeric: true }));

    if (showKeys.includes(key)) {
      showsList.push({ name: key, path: key, thumbnailId: videos[0].id });
      showVideos.set(key, videos);
    } else {
      const similarShow = showKeys.find((showKey) => looksLikeSameWork(key, showKey));
      if (similarShow) {
        console.warn(
          `Catálogo: "${videos[0].relativePath}" se ha añadido como título suelto, pero su nombre se parece mucho a la serie "${similarShow}" - revisa si es un episodio mal colocado (fuera de su carpeta).`
        );
      }
      moviesList.push(videos[0]);
    }
  }

  showsList.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  moviesList.sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

// Un archivo que se está copiando/moviendo a la carpeta de vídeos (tamaño
// todavía creciendo) no se muestra en el catálogo ni se procesa hasta que
// termina: incluirlo a medias generaba ruido ("Permission denied" al
// intentar leerlo mientras Windows lo tiene bloqueado por el propio
// proceso de copia) y, peor, arriesgaba analizarlo/generar su carátula con
// datos incompletos si el tamaño se quedaba quieto un instante a medio
// copiar. Un archivo con el mtime reciente (menos de 2 minutos) se trata
// con cautela: solo se da por "listo" cuando su tamaño coincide con el que
// tenía en el escaneo anterior. El historial vive en memoria (se pierde al
// reiniciar el servidor), así que fiarse solo de "¿tengo historial
// previo?" ocultaría TODA la biblioteca en el primer escaneo tras cada
// reinicio - por eso un mtime ya antiguo se da por estable directamente,
// sin depender de ese historial.
const RECENT_MS = 2 * 60 * 1000;
const sizeHistory = new Map(); // video.id -> tamaño visto en el escaneo anterior

function filterStableFiles(results) {
  const now = Date.now();
  const stillCopyingIds = new Set();
  const seenNow = new Set();
  for (const video of results) {
    seenNow.add(video.id);
    const isRecent = now - new Date(video.modifiedAt).getTime() < RECENT_MS;
    if (isRecent) {
      const previousSize = sizeHistory.get(video.id);
      if (previousSize === undefined || previousSize !== video.size) {
        stillCopyingIds.add(video.id);
      }
    }
    sizeHistory.set(video.id, video.size);
  }
  // Limpia del historial lo que ya no está en disco (se borró/movió/ya se
  // archivó), para no acumular basura indefinidamente.
  for (const id of sizeHistory.keys()) {
    if (!seenNow.has(id)) sizeHistory.delete(id);
  }
  return results.filter((video) => !stillCopyingIds.has(video.id));
}

// Varios sitios disparan un escaneo por su cuenta sin coordinarse entre sí
// (el vigilante de archivos, el traslado automático a otro disco tras
// vaciarse su cola, admin/reload, guardar la config...): sin esta
// protección, dos escaneos completos a la vez contra el disco externo
// pueden saturarlo hasta dejar el servidor entero sin responder (visto de
// verdad en producción). Si ya hay uno en marcha, los demás llamantes
// simplemente esperan a que termine ESE, en vez de arrancar otro.
let scanPromise = null;

function scan() {
  if (scanPromise) return scanPromise;
  scanPromise = performScan().finally(() => {
    scanPromise = null;
  });
  return scanPromise;
}

async function performScan() {
  const videosPath = getVideosPath();
  if (!videosPath) {
    throw new Error('No hay carpeta de vídeos configurada. Ajústala en /config.html o en .env');
  }
  if (!fs.existsSync(videosPath)) {
    throw new Error(`La carpeta configurada no existe: ${videosPath}`);
  }

  const results = filterStableFiles(await walk(videosPath));

  // Vídeos cuyo original se borró tras generar su HLS (ver hls.js): siguen
  // en el catálogo a partir del registro, no del escaneo, porque el
  // archivo ya no está en disco. Si ADEMÁS el HLS ya no existe (isLost:
  // "vídeo perdido", ni original ni copia) no se añade al catálogo - antes
  // se seguía mostrando en toda la web (carpetas, filtros...) sin poder
  // reproducirse nunca, solo como ruido; ya queda apuntado aparte en
  // "Volver a descargar" (lostVideos.js), no hace falta verlo también aquí.
  const seenIds = new Set(results.map((v) => v.id));
  const listedArchived = new Map();
  lostCount = 0;
  for (const [id, info] of Object.entries(archivedVideos.getAll())) {
    if (seenIds.has(id)) continue; // no debería pasar, pero por si acaso
    const video = {
      id,
      title: info.title,
      relativePath: info.relativePath,
      size: info.size,
      modifiedAt: info.modifiedAt,
      archived: true,
    };
    if (hls.isLost(video)) {
      lostCount += 1;
      continue;
    }
    results.push(video);
    listedArchived.set(id, video);
  }

  // Vídeos cuyo original se trasladó a otro disco para ahorrar espacio
  // (ver movedOriginals.js/scripts/mover-originales-a-d.js): a diferencia de
  // los archivados arriba, SÍ hay un archivo real en algún sitio, solo que
  // fuera de esta carpeta - se listan igual a partir del registro para que
  // el catálogo no dependa de que ese otro disco esté conectado ahora mismo.
  for (const [id, info] of Object.entries(movedOriginals.getAll())) {
    // El escaneo del disco es la fuente de verdad: si walk() ha encontrado
    // de verdad un archivo en su sitio original (E:), es imposible que a la
    // vez esté también trasladado a otro disco - el registro está obsoleto
    // (visto de verdad con ~148 episodios de Dragon Ball GT: una entrada de
    // un traslado que nunca se llegó a completar del todo en su día). Se
    // olvida aquí mismo para que el vídeo vuelva a ser candidato normal al
    // traslado automático (moveOriginal.js), en vez de quedarse invisible
    // para siempre (mediaInfo.inputPathFor seguiría apuntando a una ruta
    // que ya no existe, sin ningún aviso).
    if (seenIds.has(id)) {
      movedOriginals.forget(id);
      continue;
    }
    // Un mismo vídeo puede constar en los DOS registros (visto de verdad: 62
    // episodios, 27 de Bleach y 32 de One Piece, de cuando todavía se
    // borraba el original tras generar el HLS, ver #100): se añadía una vez
    // por registro y salía repetido en la web. Queda solo la entrada de
    // arriba (o ninguna, si ya estaba perdido); el registro de traslado se
    // conserva porque mediaInfo.inputPathFor lo sigue usando para regenerar
    // el HLS, y "movedTo" hace que normalize.js renombre los dos a la vez
    // (si no, volverían a separarse en dos ids distintos).
    if (archivedVideos.isArchived(id)) {
      const archived = listedArchived.get(id);
      if (archived) archived.movedTo = info.absolutePath;
      continue;
    }
    results.push({
      id,
      title: info.title,
      relativePath: info.relativePath,
      size: info.size,
      modifiedAt: info.modifiedAt,
      movedTo: info.absolutePath,
    });
  }

  results.sort((a, b) => a.title.localeCompare(b.title, 'es'));

  cache = results;
  byId = new Map(results.map((video) => [video.id, video]));
  buildLibrary();
  return cache;
}

function getCatalog() {
  return cache;
}

function getVideoById(id) {
  return byId.get(id);
}

// Para /api/queue (ver routes/queue.js): cuántos vídeos perdidos hay ahora
// mismo, calculado en vivo en el último escaneo (ver "lostCount" arriba).
function getLostCount() {
  return lostCount;
}

// Todos los vídeos de una clave de agrupación (ver metadataKeyFor/groupKeyFor),
// sea una serie/carpeta (varios episodios) o una película suelta (un único
// vídeo cuya propia clave es su título) - a diferencia de listDir() de abajo,
// que solo sabe listar carpetas de serie (showVideos), esto vale para purge.js
// tanto si "key" es un nombre de carpeta como si es el título de una película.
function videosForKey(key) {
  if (!key) return [];
  return getCatalog().filter((video) => groupKeyFor(video) === key);
}

// Lista el contenido del catálogo: sin clave, la raíz (series/anime como
// "carpetas" + películas sueltas); con clave, los vídeos de esa serie.
function listDir(key = '') {
  if (!key) {
    return { dir: '', parent: null, folders: showsList, videos: moviesList };
  }
  return { dir: key, parent: '', folders: [], videos: showVideos.get(key) || [] };
}

// Todas las claves de agrupación del catálogo (series + películas), para
// precalentar la caché de metadatos en segundo plano tras escanear.
function getAllGroupKeys() {
  return [...showsList.map((show) => show.name), ...moviesList.map((movie) => movie.title)];
}

// Clave de la serie a la que pertenece un vídeo, o null si es una película
// suelta (para poder volver a la lista de episodios en vez de al catálogo).
// Para purge.js: una obra purgada del todo deja de contar como serie
// conocida (si más adelante llega un único vídeo con ese nombre, no tiene
// por qué ser la misma serie).
function forgetShow(key) {
  const known = knownShows.get();
  if (!known[key]) return;
  delete known[key];
  knownShows.save();
}

function getShowKeyFor(video) {
  const key = groupKeyFor(video);
  return showVideos.has(key) ? key : null;
}

module.exports = {
  scan,
  getCatalog,
  getVideoById,
  getLostCount,
  listDir,
  videosForKey,
  metadataKeyFor: groupKeyFor,
  isGenericFolderName,
  getAllGroupKeys,
  getShowKeyFor,
  forgetShow,
  reloadKnownShows: knownShows.reload,
  seasonNumberFor,
  // Para normalize.js: calcular el id que tendría una ruta relativa nueva
  // (tras renombrar un archivo) sin tener que reescanear toda la carpeta de
  // vídeos solo para eso - con miles de vídeos en un disco externo, hacerlo
  // una vez por archivo renombrado sería tan lento como el propio escaneo.
  idFor: makeId,
};
