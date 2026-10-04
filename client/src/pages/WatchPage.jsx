import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Hls from 'hls.js';
import VideoControls from '../components/VideoControls';
import HiddenMenu from '../components/HiddenMenu';
import ProfileButton from '../components/ProfileButton';
import ShortcutsHelp from '../components/ShortcutsHelp';
import { getActiveProfileId, withProfile } from '../profile';
import { DEFAULT_SUBTITLE_PREFS, SUBTITLE_SIZE_EM, SUBTITLE_BG_COLOR, fetchSubtitlePrefs, saveSubtitlePrefs } from '../subtitlePrefs';
import { track } from '../analytics';
import { episodeTitle } from '../utils/format';

// El progreso se guarda en el servidor por perfil (no en localStorage), así
// que se retoma igual desde cualquier dispositivo de la red.
function progressUrl(profileId, id) {
  return `/api/profiles/${profileId}/progress/${id}`;
}

function saveProgress(profileId, id, videoEl) {
  if (!profileId || !videoEl.duration) return;
  const ratio = videoEl.currentTime / videoEl.duration;
  fetch(progressUrl(profileId, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: videoEl.currentTime, ratio }),
  }).catch(() => {});
}

// Estado del <video> en el momento de un tirón/fallo (issue #111: antes solo
// se registraba "ocurrió un fallo", sin nada para saber POR QUÉ - ni rango
// de buffer, ni si la red iba lenta, ni el motivo real de hls.js si el fallo
// venía de ahí). Se adjunta a cada evento de analítica relacionado con la
// reproducción para poder estudiarlos de verdad después, no solo contarlos.
function playbackDiagnostics(videoEl) {
  const buffered = [];
  for (let i = 0; i < videoEl.buffered.length; i += 1) {
    buffered.push([Number(videoEl.buffered.start(i).toFixed(1)), Number(videoEl.buffered.end(i).toFixed(1))]);
  }
  const connection = navigator.connection;
  return {
    currentTime: Number(videoEl.currentTime.toFixed(1)),
    duration: Number.isFinite(videoEl.duration) ? Number(videoEl.duration.toFixed(1)) : null,
    readyState: videoEl.readyState,
    networkState: videoEl.networkState,
    buffered,
    // effectiveType ("4g"/"3g"/...) y downlink (Mbps estimados): solo
    // Chrome/Edge lo exponen, undefined en Firefox/Safari - optional
    // chaining lo deja sin más en ese caso, no hace falta comprobar antes.
    connectionType: connection?.effectiveType || null,
    downlinkMbps: connection?.downlink ?? null,
  };
}

// Más fiable que fetch al cerrar la pestaña/navegar fuera: el navegador
// garantiza el envío aunque la página ya se esté descargando.
function saveProgressOnUnload(profileId, id, videoEl) {
  if (!profileId || !videoEl.duration || !navigator.sendBeacon) return;
  const ratio = videoEl.currentTime / videoEl.duration;
  const blob = new Blob([JSON.stringify({ time: videoEl.currentTime, ratio })], {
    type: 'application/json',
  });
  navigator.sendBeacon(progressUrl(profileId, id), blob);
}

// Distingue una recarga "de rescate" (la reproducción llevaba un buen rato
// atascada, ver "stall"/stuckRef más abajo) de cerrar la pestaña o navegar a
// otra página sin más - solo la primera es una señal real de fallo que
// merece la pena estudiar. fetch() (usado por track(), ver analytics.js) no
// tiene garantía de completarse durante la descarga de la página, igual que
// saveProgressOnUnload de arriba - por eso sendBeacon directo, no track().
function trackStuckOnUnload(videoEl, videoId, title) {
  if (!navigator.sendBeacon) return;
  const blob = new Blob(
    [JSON.stringify({ event: 'reload_while_stuck', videoId, title, ...playbackDiagnostics(videoEl) })],
    { type: 'application/json' }
  );
  navigator.sendBeacon('/api/analytics/track', blob);
}

// Recortado: un <select> mide lo que su opción más larga, y pistas como
// "Inglés (Audio Commentary with producer Tim Burton, director...)"
// sacaban de la pantalla el resto de controles (#156).
const MAX_TRACK_LABEL = 40;

function trackLabel(track) {
  const label = track.languageLabel || track.title || `Pista ${track.index}`;
  return label.length > MAX_TRACK_LABEL ? `${label.slice(0, MAX_TRACK_LABEL - 1).trimEnd()}…` : label;
}

// La posición de una pista en tracks.audio (venida de ffprobe, vía
// /api/tracks/:id) NO tiene por qué coincidir con la posición de esa misma
// pista en hls.js/audioTracks nativo del navegador (su propio análisis del
// manifiesto, con su propio orden interno) - usar el índice de una lista
// para indexar la otra podía acabar sin querer siempre en la pista por
// defecto, por mucho idioma distinto que se eligiera. Se busca por idioma
// (LANGUAGE="jpn", etc., el mismo valor en ambos sitios) directamente
// dentro de la lista real del reproductor, nunca por posición prestada.
// "occurrence": cuántas pistas con este MISMO idioma hay antes de la que se
// busca en tracks.audio (0 = la primera de ese idioma, 1 = la segunda...).
// Sin esto, un archivo con dos pistas "spa" a la vez (Latino Y Castellano,
// caso real y nada raro en este catálogo) siempre encontraba la primera
// ("Latino") por mucho que se pidiera la segunda ("Castellano") - el idioma
// solo identifica el GRUPO de pistas candidatas, no distingue cuál de
// varias del mismo idioma es la que se quiere.
function findByLanguage(list, language, occurrence = 0) {
  if (!language || !list) return -1;
  let seen = -1;
  for (let i = 0; i < list.length; i += 1) {
    const trackLang = list[i].lang || list[i].language;
    if (trackLang && trackLang.toLowerCase() === language.toLowerCase()) {
      seen += 1;
      if (seen === occurrence) return i;
    }
  }
  return -1;
}

// Algunos archivos (ediciones de fans, sobre todo) no llevan la pista de
// audio etiquetada con un idioma real en el contenedor, solo un "título"
// (p.ej. "Castellano"/"Japones Flac") - ahí no hay idioma con el que
// buscar en ninguno de los dos lados. Además ffmpeg no traslada ese
// título tal cual al NAME del manifiesto HLS (siempre pone "audio_N"
// genérico), así que tampoco sirve para buscar por nombre. En ese caso se
// cae a la posición ordinal entre pistas de audio: sí es consistente
// entre tracks.audio y el manifiesto/audioTracks del reproductor, porque
// ambos se derivan del mismo análisis del archivo en el mismo orden.
function findAudioTrackPosition(list, wantedTrack, ordinalPosition, occurrence = 0) {
  if (!list) return -1;
  const byLanguage = findByLanguage(list, wantedTrack?.language, occurrence);
  if (byLanguage >= 0) return byLanguage;
  if (ordinalPosition != null && ordinalPosition >= 0 && ordinalPosition < list.length) return ordinalPosition;
  return -1;
}

function formatRemaining(progress) {
  if (!progress || !progress.percent) return null;
  const { percent, elapsedMs } = progress;
  const totalEstimate = elapsedMs / (percent / 100);
  const remainingSec = Math.max(0, Math.round((totalEstimate - elapsedMs) / 1000));
  if (remainingSec < 60) return `~${remainingSec}s restantes`;
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  return `~${minutes}m ${seconds}s restantes`;
}

const WATCH_SHORTCUTS = [
  { keys: 'Espacio', label: 'Reproducir/pausar' },
  { keys: '← →', label: 'Retroceder/avanzar 10s' },
  { keys: '↑ ↓', label: 'Subir/bajar volumen' },
  { keys: 'M', label: 'Silenciar' },
  { keys: 'F', label: 'Pantalla completa' },
  { keys: 'Esc', label: 'Volver al catálogo' },
];

export default function WatchPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [prepProgress, setPrepProgress] = useState(null);
  const [tracks, setTracks] = useState({ audio: [], subtitles: [] });
  const [audioIndex, setAudioIndex] = useState(null);
  const [playbackKey, setPlaybackKey] = useState(0);
  const [stuck, setStuck] = useState(false);
  // Espejo de "stuck" en un ref: el manejador de beforeunload vive dentro de
  // un efecto que no depende de "stuck" en su lista de dependencias (no hace
  // falta recrearlo por eso), así que capturaría un valor de "stuck"
  // congelado del momento en que se montó, no el real en el instante de
  // cerrar/recargar la pestaña - justo lo que hace falta para distinguir una
  // recarga de rescate de una navegación normal (ver trackStuckOnUnload).
  const stuckRef = useRef(false);
  // Se activa nada más empezar a esperar datos (evento "waiting"), no solo
  // cuando ya ha pasado el tiempo suficiente para darse por "atascado" del
  // todo (stuckRef) - así una recarga de rescate en los primeros segundos de
  // congelación (antes de que el reintento automático de 15s+15s llegue a
  // completarse) también queda registrada, no solo las que aguantan hasta
  // el final de esa espera.
  const waitingRef = useRef(false);
  const [prevEpisodeId, setPrevEpisodeId] = useState(null);
  const [nextEpisodeId, setNextEpisodeId] = useState(null);
  const [autoAdvanceIn, setAutoAdvanceIn] = useState(null);
  const [subtitlePrefs, setSubtitlePrefs] = useState(DEFAULT_SUBTITLE_PREFS);
  const playerRef = useRef(null);
  const hlsRef = useRef(null);
  const shellRef = useRef(null);
  const wasControlsHiddenRef = useRef(false);
  const resumeTimeRef = useRef(null);
  const savedProgressRef = useRef(null);
  const profileId = getActiveProfileId();

  useEffect(() => {
    fetchSubtitlePrefs(profileId).then(setSubtitlePrefs);
  }, [profileId]);

  const handleSubtitlePrefsChange = (patch) => {
    setSubtitlePrefs((prev) => {
      const next = { ...prev, ...patch };
      saveSubtitlePrefs(profileId, patch);
      return next;
    });
  };

  // Tras descargar un subtítulo de SubDL hace falta volver a pedir
  // /api/tracks (ya lo incluirá) para que aparezca en el selector - se
  // reutiliza tanto al cargar la página como después de una descarga.
  const reloadTracks = () =>
    fetch(`/api/tracks/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((t) => t && setTracks(t))
      .catch(() => {});

  useEffect(() => {
    fetch(withProfile('/api/videos'))
      .then((res) => res.json())
      .then((videos) => {
        const found = videos.find((v) => v.id === id);
        if (!found) {
          setError('El vídeo solicitado no existe en el catálogo o no está disponible para este perfil.');
          return;
        }
        setVideo(found);
        document.title = `${found.title} - Videoclub Local`;
      })
      .catch(() => setError('No se pudo cargar el catálogo.'));

    fetch(`/api/tracks/${id}`)
      .then((res) => {
        // Un 500 (p.ej. no se pudo analizar el archivo) también trae un
        // cuerpo JSON válido ({ error: "..." }), así que sin este chequeo
        // se leía como si fuera { audio, subtitles } de verdad y rompía la
        // página entera al intentar recorrer "audio" (undefined).
        if (!res.ok) throw new Error('tracks no disponibles');
        return res.json();
      })
      .then((t) => setTracks(t))
      .catch(() => {});

    savedProgressRef.current = null;
    if (profileId) {
      fetch(progressUrl(profileId, id))
        .then((res) => res.json())
        .then((data) => {
          savedProgressRef.current = data;
        })
        .catch(() => {});
    }

    setAutoAdvanceIn(null);
    // El idioma preferido (audio/subtítulos) se vuelve a aplicar en cuanto
    // lleguen las pistas de este vídeo, ver el efecto de abajo - aquí solo
    // se limpia el de la posición del vídeo anterior, que ya no vale (los
    // índices de pista no coinciden entre archivos).
    setAudioIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Aplica el idioma de audio elegido la última vez (guardado por perfil,
  // no por dispositivo: mismo criterio que el aspecto de los subtítulos) en
  // cuanto se sabe qué pistas trae este vídeo en concreto - se busca por
  // idioma, no por posición, porque el orden de pistas no tiene por qué
  // coincidir entre archivos. Si el archivo no trae idioma real en el
  // contenedor (ediciones de fans, solo "título": "Castellano"/"Japones
  // Flac"...), se cae al título - no sirve entre TODOS los archivos, pero
  // sí es habitual que coincida el texto entre varios de una misma serie.
  useEffect(() => {
    const lang = subtitlePrefs.audioLanguage;
    const title = subtitlePrefs.audioTitle;
    if ((!lang && !title) || tracks.audio.length === 0) return;
    // Si hay varias pistas con el mismo idioma (p.ej. "Latino" y "Castellano",
    // ambas "spa"), el idioma solo no basta para distinguirlas - se prioriza
    // la que además coincide en título antes de conformarse con la primera.
    const sameLanguage = lang ? tracks.audio.filter((t) => t.language === lang) : [];
    const match =
      (sameLanguage.length > 1 && title && sameLanguage.find((t) => t.title === title)) ||
      sameLanguage[0] ||
      (title && tracks.audio.find((t) => t.title === title));
    if (match) setAudioIndex(match.index);
  }, [id, tracks.audio, subtitlePrefs.audioLanguage, subtitlePrefs.audioTitle]);

  useEffect(() => {
    if (!video?.seriesKey) {
      setPrevEpisodeId(null);
      setNextEpisodeId(null);
      return;
    }
    fetch(withProfile(`/api/videos/browse?dir=${encodeURIComponent(video.seriesKey)}`))
      .then((res) => res.json())
      .then((data) => {
        const list = data.videos || [];
        const idx = list.findIndex((v) => v.id === id);
        setPrevEpisodeId(idx > 0 ? list[idx - 1].id : null);
        setNextEpisodeId(idx >= 0 && idx < list.length - 1 ? list[idx + 1].id : null);
      })
      .catch(() => {
        setPrevEpisodeId(null);
        setNextEpisodeId(null);
      });
  }, [video, id]);

  useEffect(() => {
    if (autoAdvanceIn == null) return undefined;
    if (autoAdvanceIn <= 0) {
      navigate(`/watch/${nextEpisodeId}`);
      return undefined;
    }
    const timer = setTimeout(() => setAutoAdvanceIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [autoAdvanceIn, nextEpisodeId, navigate]);

  useEffect(() => {
    if (!video) return undefined;
    let cancelled = false;
    let timer;
    setReady(false);
    setPrepProgress(null);

    // HLS (server/hls.js): no depende de audioIndex, todas las pistas de
    // audio van en el mismo manifiesto, se elige luego sin recargar.
    const streamUrl = `/api/hls/${id}/status`;

    const checkStatus = () => {
      fetch(streamUrl)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.status === 'ready' || data.status === 'compatible') {
            setReady(true);
          } else if (data.status === 'failed') {
            setError('No se pudo preparar este vídeo para reproducirlo.');
          } else {
            setPrepProgress(data.progress || null);
            timer = setTimeout(checkStatus, 2000);
          }
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(checkStatus, 3000);
        });
    };

    checkStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [video, id, audioIndex]);

  useEffect(() => {
    if (ready && video) track('play_start', { videoId: id, title: video.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, id]);

  // Conecta hls.js al <video>: sustituye al <video src=...> directo.
  // Chrome/Firefox necesitan hls.js; Safari reproduce HLS de forma nativa,
  // sin librería. El cambio de pista de audio (handleAudioChange) usa la
  // API de pistas de hls.js en vez de cambiar el src, así no hay recarga
  // ni se pierde la posición.
  useEffect(() => {
    const player = playerRef.current;
    if (!video || !ready || !player) return undefined;

    const masterUrl = `/api/hls/${id}/master.m3u8`;

    if (Hls.isSupported()) {
      // Por defecto hls.js precarga tan por delante como la red permita
      // (hasta 600s / ~60MB) - con una red local rápida y un archivo pesado
      // (BD 1080p), eso llena el SourceBuffer del navegador en pocos
      // segundos de verdad reproducidos, mucho antes de que la posición
      // avance lo suficiente para poder liberar espacio. El resultado
      // ("SourceBuffer is full") es un error no fatal que hls.js sabe
      // recuperar solo para que el vídeo no se corte, pero como efecto
      // colateral reinicia también la pista de audio a la de por defecto -
      // dando la sensación de que cambiar de idioma "no hacía nada" en
      // archivos grandes. Un margen de precarga más conservador evita
      // llegar a ese límite sin perder fluidez real.
      const instance = new Hls({ maxBufferLength: 60, maxMaxBufferLength: 90 });
      hlsRef.current = instance;
      // Todos los fallos de hls.js, no solo los fatales: antes un tirón
      // real (fallo de red al pedir un segmento, buffer vaciado...) que
      // hls.js consigue recuperar solo no dejaba ningún rastro (issue #111)
      // - así "se paró la reproducción" no se podía estudiar después, solo
      // adivinar. "player" puede ser undefined mientras hls.js aún se está
      // conectando al <video> (los primeros instantes tras new Hls()).
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) console.warn(`hls.js FATAL (${data.type}): ${data.details}`);
        const currentPlayer = playerRef.current;
        track('hls_error', {
          videoId: id,
          title: video.title,
          fatal: Boolean(data.fatal),
          type: data.type,
          details: data.details,
          reason: data.reason || data.error?.message || null,
          responseStatus: data.response?.code ?? null,
          responseUrl: data.response?.url || data.url || null,
          frag: data.frag ? { sn: data.frag.sn, level: data.frag.level } : null,
          ...(currentPlayer ? playbackDiagnostics(currentPlayer) : {}),
        });
      });
      // Si el idioma preferido (guardado de otro episodio) no es el que
      // trae por defecto este archivo, se aplica en cuanto se conocen las
      // pistas reales - así el primer episodio que se abre ya suena en el
      // idioma guardado, no solo los siguientes cambios. AUDIO_TRACKS_UPDATED,
      // no MANIFEST_PARSED: verificado en directo que en el momento exacto
      // de MANIFEST_PARSED "instance.audioTracks" todavía puede estar vacío
      // (hls.js lo rellena en un paso posterior), así que la búsqueda por
      // idioma fallaba siempre en silencio (position=-1) y se quedaba con
      // la pista por defecto sin que nada avisara del fallo.
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (audioIndex == null) return;
        const wanted = tracks.audio.find((t) => t.index === audioIndex);
        const ordinal = tracks.audio.findIndex((t) => t.index === audioIndex);
        // Cuántas pistas anteriores comparten el mismo idioma: distingue
        // "Latino" de "Castellano" (ambas "spa") al buscar por idioma.
        const occurrence = wanted
          ? tracks.audio.slice(0, ordinal).filter((t) => t.language === wanted.language).length
          : 0;
        const position = findAudioTrackPosition(instance.audioTracks, wanted, ordinal, occurrence);
        if (position >= 0 && instance.audioTrack !== position) instance.audioTrack = position;
      });
      instance.loadSource(masterUrl);
      instance.attachMedia(player);
      return () => {
        instance.destroy();
        if (hlsRef.current === instance) hlsRef.current = null;
      };
    }

    if (player.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari: soporte nativo, sin hls.js. El cambio de pista de audio en
      // Safari usa player.audioTracks (ver handleAudioChange) en vez de la
      // API de hls.js.
      player.src = masterUrl;
      if (audioIndex != null) {
        const wanted = tracks.audio.find((t) => t.index === audioIndex);
        const ordinal = tracks.audio.findIndex((t) => t.index === audioIndex);
        const occurrence = wanted
          ? tracks.audio.slice(0, ordinal).filter((t) => t.language === wanted.language).length
          : 0;
        const onLoadedMeta = () => {
          const position = findAudioTrackPosition(player.audioTracks, wanted, ordinal, occurrence);
          if (position >= 0 && player.audioTracks) {
            for (let i = 0; i < player.audioTracks.length; i += 1) {
              player.audioTracks[i].enabled = i === position;
            }
          }
        };
        player.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
        return () => player.removeEventListener('loadedmetadata', onLoadedMeta);
      }
      return undefined;
    }

    setError('Este navegador no puede reproducir vídeo HLS.');
    return undefined;
  }, [video, ready, id, playbackKey]);

  useEffect(() => {
    const player = playerRef.current;
    if (!video || !ready || !player) return undefined;

    const onLoadedMetadata = () => {
      const saved = savedProgressRef.current;
      if (resumeTimeRef.current != null) {
        player.currentTime = resumeTimeRef.current;
        resumeTimeRef.current = null;
      } else if (saved && saved.ratio < 0.95) {
        player.currentTime = saved.time;
      }
      // El atributo "autoPlay" del <video> debería bastar al remontar (cambio
      // de pista de audio, reintento tras un corte...), pero depender solo
      // de él es frágil: si el navegador no lo concede a tiempo, el vídeo se
      // queda pausado sin más aviso. Forzarlo aquí es la misma recuperación
      // ya usada para reanudar la posición, así no hace falta un segundo
      // gesto del usuario para que retome la reproducción.
      player.play().catch(() => {});
    };
    const onPause = () => saveProgress(profileId, id, player);
    const onEnded = () => {
      if (profileId) {
        fetch(progressUrl(profileId, id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ time: 0, ratio: 1 }),
        }).catch(() => {});
      }
      track('play_complete', { videoId: id, title: video.title });
      if (nextEpisodeId) {
        setAutoAdvanceIn(5);
      }
    };

    // Si la reproducción se queda esperando datos, se reintenta sola una vez
    // (útil para cortes de red puntuales); si vuelve a atascarse, se ofrece
    // el botón manual en vez de reintentar en bucle sin avisar.
    let stallTimer;
    let autoRetried = false;
    const doRetry = () => {
      resumeTimeRef.current = player.currentTime;
      setPlaybackKey((k) => k + 1);
    };
    const onWaiting = () => {
      waitingRef.current = true;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        // Se registra también el primer intento (antes solo el segundo):
        // si alguien recarga a mano antes de que termine el reintento
        // automático (15s + otros 15s = hasta 30s), ese primer tirón real
        // no dejaba ningún rastro para poder estudiarlo después.
        track('stall', { videoId: id, title: video.title, attempt: autoRetried ? 2 : 1, ...playbackDiagnostics(player) });
        if (!autoRetried) {
          autoRetried = true;
          doRetry();
        } else {
          stuckRef.current = true;
          setStuck(true);
        }
      }, 15000);
    };
    const clearStall = () => {
      waitingRef.current = false;
      clearTimeout(stallTimer);
      stuckRef.current = false;
      setStuck(false);
    };
    const onError = () => {
      track('play_error', {
        videoId: id,
        title: video.title,
        errorCode: player.error?.code ?? null,
        errorMessage: player.error?.message || null,
        ...playbackDiagnostics(player),
      });
      if (!autoRetried) {
        autoRetried = true;
        doRetry();
      } else {
        stuckRef.current = true;
        setStuck(true);
      }
    };

    player.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    player.addEventListener('waiting', onWaiting);
    player.addEventListener('playing', clearStall);
    player.addEventListener('timeupdate', clearStall);
    player.addEventListener('error', onError);

    const interval = setInterval(() => saveProgress(profileId, id, player), 5000);
    const onBeforeUnload = () => {
      saveProgressOnUnload(profileId, id, player);
      if (waitingRef.current || stuckRef.current) trackStuckOnUnload(player, id, video.title);
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      player.removeEventListener('loadedmetadata', onLoadedMetadata);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      player.removeEventListener('waiting', onWaiting);
      player.removeEventListener('playing', clearStall);
      player.removeEventListener('timeupdate', clearStall);
      player.removeEventListener('error', onError);
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearInterval(interval);
      clearTimeout(stallTimer);
      saveProgress(profileId, id, player);
    };
  }, [video, ready, id, playbackKey, nextEpisodeId, profileId]);

  const handleAudioChange = (e) => {
    const value = e.target.value;
    const newIndex = value === '' ? null : Number(value);

    // Se recuerda por idioma (no por índice) y por perfil (no por
    // dispositivo), para aplicarlo en el siguiente episodio/vídeo que se
    // abra en cualquier aparato con este mismo perfil.
    const chosenTrack = tracks.audio.find((t) => t.index === newIndex);
    handleSubtitlePrefsChange({ audioLanguage: chosenTrack?.language || null, audioTitle: chosenTrack?.title || null });

    // El cambio "en caliente" (hls.audioTrack = posición, sin recargar
    // nada) resultó NO ser fiable en la práctica - verificado en directo:
    // la pista pedida por red y la seleccionada en hls.js eran las
    // correctas, pero el sonido seguía siendo el de la pista anterior. En
    // vez de perseguir ese fallo de hls.js/el navegador, se fuerza una
    // recarga completa del reproductor (mismo mecanismo que la recuperación
    // ante un corte, ver retryPlayback) con la posición actual guardada: la
    // ruta de "carga inicial con idioma preferido" (ver MANIFEST_PARSED más
    // abajo) sí aplica bien la pista desde el principio.
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setAudioIndex(newIndex);
    setPlaybackKey((k) => k + 1);
  };

  const retryPlayback = () => {
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    waitingRef.current = false;
    stuckRef.current = false;
    setStuck(false);
    setPlaybackKey((k) => k + 1);
  };

  const backTo = video?.seriesKey ? `/?dir=${encodeURIComponent(video.seriesKey)}` : '/';
  const backLabel = video?.seriesKey ? '← Volver a episodios' : '← Volver al catálogo';

  // Escape vuelve al catálogo (o a la lista de episodios), igual que el
  // enlace "← Volver..." - antes no hacía nada con teclado. Si hay pantalla
  // completa activa, se deja que el propio navegador la cierre primero (un
  // segundo Escape ya vuelve atrás): si no, un solo Escape haría las dos
  // cosas a la vez.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      navigate(backTo);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [backTo, navigate]);

  // Foco inicial con sentido al entrar por teclado: antes nada lo recibía
  // (ni el <video>, ni ningún control), así que había que tabular a ciegas
  // para encontrar el reproductor. El contenedor general, no un botón
  // concreto, para no forzar "play" ni nada más solo por llegar aquí -
  // desde ahí, Tab ya lleva al primer control, y espacio/flechas funcionan
  // igual (VideoControls no exige nada enfocado en concreto).
  useEffect(() => {
    if (ready) shellRef.current?.focus();
  }, [ready]);

  // La cabecera fija solo hace falta mientras no hay reproductor todavía
  // (cargando/preparando/error): en cuanto hay vídeo listo, todo eso pasa a
  // vivir dentro del reproductor como una barra superior que aparece y
  // desaparece con el resto de controles (estilo Netflix/Prime), no una
  // cabecera aparte siempre visible.
  const showFixedHeader = !ready || error;

  return (
    <>
      {showFixedHeader && (
        <div className="watch-header">
          <Link className="back-link" to={backTo}>
            {backLabel}
          </Link>
          <h1 className="watch-title">{error ? 'Error' : video ? episodeTitle(video) : 'Cargando...'}</h1>
          {(prevEpisodeId || nextEpisodeId) && (
            <div className="episode-nav">
              <button disabled={!prevEpisodeId} onClick={() => navigate(`/watch/${prevEpisodeId}`)}>
                ← Anterior
              </button>
              <button disabled={!nextEpisodeId} onClick={() => navigate(`/watch/${nextEpisodeId}`)}>
                Siguiente →
              </button>
            </div>
          )}
          {tracks.audio.length > 1 && (
            <select className="track-select" value={audioIndex ?? ''} onChange={handleAudioChange}>
              {tracks.audio.map((track) => (
                <option key={track.index} value={track.index}>
                  Audio: {trackLabel(track)}
                </option>
              ))}
            </select>
          )}
          <ProfileButton />
          <HiddenMenu />
        </div>
      )}
      <div className="player-wrap">
        {error && <div className="error-box">{error}</div>}
        {!error && video && !ready && (
          <div className="prep-box">
            <div className="spinner" />
            <p>Preparando vídeo para este dispositivo...</p>
            {prepProgress?.percent != null ? (
              <>
                <div className="prep-bar">
                  <div style={{ width: `${prepProgress.percent}%` }} />
                </div>
                <p className="prep-detail">
                  {prepProgress.percent}%{formatRemaining(prepProgress) ? ` · ${formatRemaining(prepProgress)}` : ''}
                </p>
              </>
            ) : (
              <p className="prep-detail">Analizando el vídeo, puede tardar unos minutos la primera vez...</p>
            )}
          </div>
        )}
        {!error && video && ready && (
          <div className="player-column player-column-fill">
            <div className="player-shell" ref={shellRef} tabIndex={-1}>
              {/* Los subtítulos nativos (<track>) los pinta el propio
                  navegador vía el pseudo-elemento ::cue - no hay otra forma
                  de darle tamaño/color propios que con CSS scopeado así. */}
              <style>{`
                .player-shell video::cue {
                  font-size: ${SUBTITLE_SIZE_EM[subtitlePrefs.size] ?? SUBTITLE_SIZE_EM.medium}em;
                  color: ${subtitlePrefs.color};
                  background-color: ${SUBTITLE_BG_COLOR[subtitlePrefs.background] ?? SUBTITLE_BG_COLOR.semi};
                }
              `}</style>
              <video
                key={playbackKey}
                ref={playerRef}
                autoPlay
                playsInline
                onTouchStart={() => {
                  // En táctil, un mismo toque dispara touchstart (que
                  // VideoControls usa para volver a mostrar los controles
                  // ocultos) Y el click sintético que sigue (que aquí
                  // pausaría/reproduciría sin querer) - se lee el estado
                  // justo ANTES de ese click para distinguir "solo estaba
                  // despertando los controles" de "quiere pausar/reproducir
                  // de verdad" (con controles ya visibles). En ratón esto no
                  // se dispara nunca, así que el comportamiento de siempre
                  // (clic = pausa/reproduce) no cambia.
                  wasControlsHiddenRef.current = Boolean(
                    shellRef.current?.querySelector('.video-controls-hidden')
                  );
                }}
                onClick={(e) => {
                  if (wasControlsHiddenRef.current) {
                    wasControlsHiddenRef.current = false;
                    return;
                  }
                  e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause();
                }}
              >
                {tracks.subtitles.map((track) => (
                  <track
                    key={track.index}
                    kind="subtitles"
                    src={`/api/subtitle/${id}/${track.index}`}
                    srcLang={track.language || 'und'}
                    label={trackLabel(track)}
                  />
                ))}
              </video>
              <VideoControls
                key={playbackKey}
                videoRef={playerRef}
                shellRef={shellRef}
                id={id}
                profileId={profileId}
                subtitleTracks={tracks.subtitles}
                title={video?.title}
                backTo={backTo}
                backLabel={backLabel}
                prevEpisodeId={prevEpisodeId}
                nextEpisodeId={nextEpisodeId}
                onNavigate={navigate}
                audioTracks={tracks.audio}
                audioIndex={audioIndex}
                onAudioChange={handleAudioChange}
                subtitlePrefs={subtitlePrefs}
                onSubtitlePrefsChange={handleSubtitlePrefsChange}
                onSubtitlesDownloaded={reloadTracks}
                initialSubtitleLanguage={subtitlePrefs.subtitleLanguage}
                initialSubtitleTitle={subtitlePrefs.subtitleTitle}
                onSubtitleLanguageChange={(track) =>
                  handleSubtitlePrefsChange({ subtitleLanguage: track?.language || null, subtitleTitle: track?.title || null })
                }
              />
            </div>
            {stuck && (
              <div className="stall-banner">
                <span>La reproducción parece atascada.</span>
                <button onClick={retryPlayback}>Reintentar</button>
              </div>
            )}
            {autoAdvanceIn != null && (
              <div className="stall-banner">
                <span>Siguiente episodio en {autoAdvanceIn}s...</span>
                <button onClick={() => navigate(`/watch/${nextEpisodeId}`)}>Reproducir ahora</button>
                <button className="secondary" onClick={() => setAutoAdvanceIn(null)}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <ShortcutsHelp shortcuts={WATCH_SHORTCUTS} />
    </>
  );
}
