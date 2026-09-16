const express = require('express');
const catalog = require('../catalog');
const thumbnails = require('../thumbnails');
const metadata = require('../metadata');
const hls = require('../hls');
const profiles = require('../profiles');

const router = express.Router();

// El "type" que devuelven las fuentes (tv/anime/movie) es poco fiable para
// distinguir anime: TVmaze indexa muchos animes como series de TV normales
// y solo a veces los etiqueta también con el género "Anime". Se usa esa
// etiqueta de género (más consistente) como señal real.
function resolveType(meta) {
  if (meta.type === 'anime' || meta.genres?.includes('Anime')) return 'anime';
  return meta.type;
}

// 'active': generándose el HLS ahora mismo (con su % si se conoce).
// 'queued': ya se sabe que hace falta, pero aún analizando/esperando su
// turno. null: ya está listo, o aún no se ha comprobado.
function hlsProcessingState(video) {
  const status = hls.getStatus(video);
  if (status === 'processing') return 'active';
  if (status === 'checking') return 'queued';
  return null;
}

function toPublicVideo(video) {
  return {
    id: video.id,
    title: video.title,
    size: video.size,
    modifiedAt: video.modifiedAt,
    // Clave de metadatos (nombre de carpeta de serie/anime, o título si es
    // una película suelta): para poder pedir/corregir su carátula desde el
    // cliente (ver /api/metadata/candidates y QuickInfoModal "Cambiar
    // carátula") sin tener que adivinarla.
    metadataKey: catalog.metadataKeyFor(video),
    hasThumbnail: thumbnails.hasThumbnail(video.id),
    seriesKey: catalog.getShowKeyFor(video),
    processingState: hlsProcessingState(video),
    processingPercent: hls.getProgress(video)?.percent ?? null,
    // Para la vista previa al pasar el ratón sobre la carátula: solo tiene
    // sentido intentarla si el HLS ya está generado (si no, habría que
    // esperar a que termine solo por pasar el ratón por encima).
    hlsReady: hls.getStatus(video) === 'ready',
    // El original se borró (era H.264 compatible, el HLS ya es el mismo
    // vídeo, ver hls.js): "Reproducir sin convertir" no puede funcionar.
    archived: video.archived === true,
  };
}

// Para una carpeta de serie: si algún episodio se está convirtiendo ahora
// mismo eso manda (con su porcentaje real); si no, pero alguno está en
// cola, se marca como en cola.
function folderProcessingState(videosInFolder) {
  let queued = false;
  for (const v of videosInFolder) {
    const state = hlsProcessingState(v);
    if (state === 'active') return { processingState: 'active', processingPercent: hls.getProgress(v)?.percent ?? null };
    if (state === 'queued') queued = true;
  }
  return { processingState: queued ? 'queued' : null, processingPercent: null };
}

// Punto verde/rojo/naranja de la carátula de serie: 'ready' si todos los
// episodios ya tienen su HLS listo, 'pending' si ninguno lo tiene, 'partial'
// si es una mezcla (a medias). null si la carpeta no tiene vídeos.
function folderHlsCompletion(videosInFolder) {
  if (videosInFolder.length === 0) return null;
  const readyCount = videosInFolder.filter((v) => hls.getStatus(v) === 'ready').length;
  if (readyCount === 0) return 'pending';
  if (readyCount === videosInFolder.length) return 'ready';
  return 'partial';
}

router.get('/videos', (req, res) => {
  const videos = catalog.getCatalog().map((video) => {
    const meta = metadata.getCached(catalog.metadataKeyFor(video));
    return {
      ...toPublicVideo(video),
      genres: meta.genres,
      cleanName: meta.cleanName,
      poster: meta.poster,
      type: resolveType(meta),
    };
  });
  res.json(videos);
});

// Fracción (0-1) de episodios ya vistos (>=95%) de una carpeta de serie,
// para pintar una barra de progreso de la serie completa en su carátula
// (no solo del episodio suelto, como "Continuar viendo"). null si no hay
// perfil activo o la carpeta no tiene vídeos.
function seriesProgressFor(videosInFolder, profileProgress) {
  if (!profileProgress || videosInFolder.length === 0) return null;
  const watched = videosInFolder.filter((v) => (profileProgress[v.id]?.ratio || 0) >= 0.95).length;
  return { ratio: watched / videosInFolder.length, watched, total: videosInFolder.length };
}

router.get('/videos/browse', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const { parent, folders, videos } = catalog.listDir(dir);
  const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : null;
  const profileProgress = profileId && profiles.profileExists(profileId) ? profiles.getProgress(profileId) : null;

  // Metadatos ya cacheados (si los hay); nunca bloquea esperando a fuentes
  // externas, así el catálogo carga al instante aunque haya miles de vídeos.
  res.json({
    dir,
    parent,
    folders: folders.map((folder) => {
      const meta = metadata.getCached(folder.name);
      const folderVideos = catalog.listDir(folder.path).videos;
      const { processingState, processingPercent } = folderProcessingState(folderVideos);
      return {
        ...folder,
        metadataKey: folder.name,
        genres: meta.genres,
        cleanName: meta.cleanName,
        poster: meta.poster,
        type: resolveType(meta),
        processingState,
        processingPercent,
        hlsCompletion: folderHlsCompletion(folderVideos),
        seriesProgress: seriesProgressFor(folderVideos, profileProgress),
        // Para la vista previa al pasar el ratón sobre la carátula de la
        // serie (folder.thumbnailId es justo el primer episodio, mismo
        // orden que folderVideos[0] - ver catalog.js buildLibrary): solo
        // tiene sentido intentarla si su HLS ya está generado.
        firstVideoReady: folderVideos.length > 0 && hls.getStatus(folderVideos[0]) === 'ready',
      };
    }),
    videos: videos.map((video) => {
      const meta = metadata.getCached(catalog.metadataKeyFor(video));
      return {
        ...toPublicVideo(video),
        genres: meta.genres,
        cleanName: meta.cleanName,
        poster: meta.poster,
        type: resolveType(meta),
      };
    }),
  });
});

router.get('/genres', (req, res) => {
  res.json(metadata.allGenres());
});

router.post('/scan', async (req, res) => {
  try {
    const videos = await catalog.scan();
    // Generar carátulas, precalentar géneros y HLS en segundo plano, sin bloquear la respuesta.
    thumbnails.generateMissingThumbnails(videos);
    metadata.warmAll(catalog.getAllGroupKeys());
    hls.warmAll(videos);
    res.json({ count: videos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
