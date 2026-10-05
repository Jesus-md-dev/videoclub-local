import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from './HiddenMenu';
import ProfileButton from './ProfileButton';
import { isTvMode, setKeepScreenOn } from '../tvMode';

// Nombre de tecla normalizado para los atajos del reproductor. Antes solo
// se miraba e.code, que los mandos de tele no siempre rellenan: la Fire TV
// manda las teclas multimedia como keyCode 179 (play/pausa), 227
// (retroceder) y 228 (avanzar); otras teles, 415/19/412/417.
const MEDIA_KEYS = new Set(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaRewind', 'MediaFastForward']);
const KEY_NAMES = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  m: 'KeyM',
  M: 'KeyM',
  f: 'KeyF',
  F: 'KeyF',
};
const KEYCODE_NAMES = {
  32: 'Space',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  70: 'KeyF',
  77: 'KeyM',
  179: 'MediaPlayPause',
  227: 'MediaRewind',
  228: 'MediaFastForward',
  415: 'MediaPlay',
  19: 'MediaPause',
  412: 'MediaRewind',
  417: 'MediaFastForward',
};

function keyNameFor(e) {
  if (MEDIA_KEYS.has(e.key)) return e.key;
  const fromKeyCode = KEYCODE_NAMES[e.keyCode || e.which];
  if (MEDIA_KEYS.has(fromKeyCode)) return fromKeyCode;
  return e.code || KEY_NAMES[e.key] || fromKeyCode;
}

// Recortado: un <select> mide lo que su opción más larga, y pistas como
// "Inglés (Audio Commentary with producer Tim Burton, director...)"
// sacaban de la pantalla el resto de controles (#156).
const MAX_TRACK_LABEL = 40;

// Cabecera de las vistas de ajustes y búsqueda dentro del panel de audio y
// subtítulos: "←" vuelve a las listas.
function TracksSubviewHeader({ title, onBack }) {
  return (
    <div className="tracks-subview-header">
      <button className="tracks-back" onClick={onBack} aria-label="Volver a audio y subtítulos">
        ←
      </button>
      <p className="subtitle-settings-title">{title}</p>
    </div>
  );
}

function trackLabel(track) {
  const label = track.languageLabel || track.title || `Pista ${track.index}`;
  return label.length > MAX_TRACK_LABEL ? `${label.slice(0, MAX_TRACK_LABEL - 1).trimEnd()}…` : label;
}

// El origen de una pista de subtítulo se distingue por el prefijo de su
// "index" (ver server/tracks.js: "ext<hash>" = descargado de SubDL,
// "local<hash>" = importado a mano o detectado junto al vídeo; un número o
// "<n>" suelto = incrustado en el propio archivo, o ya extraído de él).
// Solo tiene sentido para subtítulos, no para audio.
function subtitleSourceLabel(track) {
  const index = String(track.index);
  if (index.startsWith('ext')) return 'SubDL';
  if (index.startsWith('local')) return 'importado';
  return 'del vídeo';
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Controles propios (no los nativos del <video>) para poder mostrar una
// miniatura de vista previa al arrastrar/pasar el ratón por la barra de
// progreso, estilo Netflix/YouTube. El <video> sigue siendo el mismo
// elemento que maneja WatchPage (progreso, reintentos, etc.); este
// componente solo lee su estado y lo controla desde fuera.
// Cambiar de audio recarga el reproductor entero (ver handleAudioChange en
// WatchPage) y con él estos controles, que además se montan dos veces
// (clave nueva, y otra vez tras volver a comprobar el vídeo): sin esto, el
// panel de audio y subtítulos se cerraba al elegir una pista. Mientras dura
// esta ventana, cada VideoControls nuevo lo abre; cerrarlo la anula.
const REOPEN_TRACKS_MS = 15000;
let reopenTracksUntil = 0;

export default function VideoControls({
  videoRef,
  shellRef,
  id,
  profileId,
  subtitleTracks,
  title,
  backTo,
  backLabel,
  prevEpisodeId,
  nextEpisodeId,
  onNavigate,
  audioTracks,
  audioIndex,
  onAudioChange,
  subtitlePrefs,
  onSubtitlePrefsChange,
  onSubtitlesDownloaded,
  initialSubtitleLanguage,
  initialSubtitleTitle,
  onSubtitleLanguageChange,
}) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [subtitleIndex, setSubtitleIndex] = useState(-1);
  // Un solo botón "Audio y subtítulos" (#166), como Netflix/Prime/Disney+:
  // abre un panel con las dos listas lado a lado. Ajustes y búsqueda de
  // subtítulos son vistas dentro de ese mismo panel.
  const [tracksOpen, setTracksOpen] = useState(() => Date.now() < reopenTracksUntil);
  // Al abrir el panel (o al reabrirlo tras esa recarga), el foco va a la
  // pista de audio marcada: con el mando no hay que buscar dónde empezar.
  useEffect(() => {
    if (tracksOpen) subtitleSettingsRef.current?.querySelector('.tracks-option-active')?.focus({ preventScroll: true });
  }, [tracksOpen]);
  const [subtitleSettingsOpen, setSubtitleSettingsOpen] = useState(false);
  const [subtitleSearchOpen, setSubtitleSearchOpen] = useState(false);
  const [subtitleSearchResults, setSubtitleSearchResults] = useState(null);
  const [subtitleSearchLoading, setSubtitleSearchLoading] = useState(false);
  const [subtitleSearchError, setSubtitleSearchError] = useState(null);
  // Posición (dentro de subtitleSearchResults) del resultado que se está
  // descargando ahora mismo, para mostrar "Descargando…" solo en ese botón.
  const [downloadingIndex, setDownloadingIndex] = useState(null);
  const [importingFile, setImportingFile] = useState(false);
  const [importError, setImportError] = useState(null);
  const importFileInputRef = useRef(null);
  // El streamIndex ("ext<hash>"/"os<fileId>") del subtítulo recién
  // descargado: en cuanto aparece en subtitleTracks (tras onSubtitlesDownloaded,
  // que vuelve a pedir /api/tracks) se activa solo, sin que haga falta
  // elegirlo dos veces.
  const [pendingActivateStreamIndex, setPendingActivateStreamIndex] = useState(null);
  const [hover, setHover] = useState(null); // { ratio, x } mientras se pasa/arrastra por la barra
  const [dragging, setDragging] = useState(false);
  const [trickplay, setTrickplay] = useState(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const barRef = useRef(null);
  const hideTimer = useRef(null);
  const lastMediaKeyAt = useRef(0);
  const subtitleSettingsRef = useRef(null);
  const castPanelRef = useRef(null);

  // Emitir a la TV: dos protocolos con API en el servidor casi idéntica -
  // DLNA/UPnP (issue #99, server/dlna.js) y Chromecast (issue #109,
  // server/chromecast.js, para TVs con Chromecast integrado tipo Xiaomi/
  // Android TV que no hablan DLNA en absoluto). Cada dispositivo de
  // castDevices lleva su "kind" ('dlna'|'chromecast') para saber a qué
  // prefijo de API (/api/dlna o /api/chromecast) mandar cada orden;
  // castStatus también lo guarda, para pausar/reanudar/parar la emisión
  // correcta. castStatus es null salvo que haya una emisión activa PARA
  // ESTE vídeo concreto - así, si se emitió otro vídeo antes o desde otra
  // pestaña, no se confunde con el de aquí.
  const [castOpen, setCastOpen] = useState(false);
  const [castDevices, setCastDevices] = useState([]);
  const [castDevicesLoading, setCastDevicesLoading] = useState(false);
  const [castConnecting, setCastConnecting] = useState(false);
  const [castError, setCastError] = useState(null);
  const [castStatus, setCastStatus] = useState(null);

  useEffect(() => {
    fetch(`/api/trickplay/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setTrickplay)
      .catch(() => setTrickplay(null));
  }, [id]);

  const [subtitleSearchReady, setSubtitleSearchReady] = useState(false);
  useEffect(() => {
    fetch('/api/subdl/status')
      .then((res) => res.json())
      .then((data) => setSubtitleSearchReady(data.configured))
      .catch(() => setSubtitleSearchReady(false));
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onLoadedMetadata = () => setDuration(video.duration || 0);
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('progress', onProgress);

    setPlaying(!video.paused);
    setDuration(video.duration || 0);
    setVolume(video.volume);
    setMuted(video.muted);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('progress', onProgress);
    };
  }, [videoRef, id]);

  useEffect(() => {
    const onFsChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Oculta los controles tras unos segundos de inactividad (solo mientras
  // reproduce), como cualquier reproductor de vídeo.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;

    const showThenScheduleHide = () => {
      setControlsVisible(true);
      clearTimeout(hideTimer.current);
      if (playing && !dragging && !tracksOpen) {
        hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
      }
    };

    showThenScheduleHide();
    shell.addEventListener('mousemove', showThenScheduleHide);
    shell.addEventListener('touchstart', showThenScheduleHide);
    // Sin ratón ni tacto (mando de TV) los controles ocultos (opacity:0 +
    // pointer-events:none, ver CSS) se quedaban invisibles e inalcanzables
    // para siempre una vez pasaban los 3s - ninguna tecla los volvía a
    // mostrar. En document, no en shell: con los controles ya invisibles
    // (pointer-events:none) el foco puede estar en cualquier otro sitio de
    // la página, no necesariamente dentro de shell, así que ahí no
    // burbujearía nada hasta él.
    document.addEventListener('keydown', showThenScheduleHide);
    return () => {
      shell.removeEventListener('mousemove', showThenScheduleHide);
      shell.removeEventListener('touchstart', showThenScheduleHide);
      document.removeEventListener('keydown', showThenScheduleHide);
      clearTimeout(hideTimer.current);
    };
  }, [shellRef, playing, dragging, tracksOpen]);

  // Modo tele: al ocultarse los controles el foco vuelve al vídeo, para
  // que las flechas no se pierdan entre botones invisibles.
  useEffect(() => {
    if (controlsVisible || !isTvMode()) return;
    const shell = shellRef.current;
    if (shell && shell !== document.activeElement && shell.contains(document.activeElement)) {
      shell.focus({ preventScroll: true });
    }
  }, [controlsVisible, shellRef]);

  // La APK de tele deja la pantalla encendida solo mientras se reproduce.
  useEffect(() => {
    setKeepScreenOn(playing);
    return () => setKeepScreenOn(false);
  }, [playing]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  };

  const ratioFromEvent = (e) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekToRatio = (ratio) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    video.currentTime = ratio * duration;
  };

  const handleBarMove = (e) => {
    const ratio = ratioFromEvent(e);
    setHover({ ratio });
    if (dragging) seekToRatio(ratio);
  };

  const handleBarDown = (e) => {
    const ratio = ratioFromEvent(e);
    setHover({ ratio });
    // Emitiendo a la TV: un solo salto por clic (no arrastre continuo, para
    // no bombardear al dispositivo DLNA con órdenes de "seek" en cada
    // movimiento del ratón).
    if (castStatus?.active) {
      castSeekToRatio(ratio);
      return;
    }
    setDragging(true);
    seekToRatio(ratio);
  };

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e) => {
      const ratio = ratioFromEvent(e);
      setHover({ ratio });
      seekToRatio(ratio);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, duration]);

  const toggleFullscreen = () => {
    const shell = shellRef.current;
    if (!shell) return;
    // Con prefijo webkit de resguardo: navegadores de tele con Chromium
    // antiguo (Silk de Fire TV viejas) solo tienen esa versión.
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (shell.requestFullscreen || shell.webkitRequestFullscreen)?.call(shell);
    }
  };

  // Salto de ±10 s compartido por las flechas, las teclas multimedia del
  // mando, Media Session y los botones ⟲/⟳.
  const seekBy = (seconds) => {
    const video = videoRef.current;
    if (!video) return;
    const end = video.duration || video.currentTime + Math.abs(seconds);
    video.currentTime = Math.min(end, Math.max(0, video.currentTime + seconds));
  };

  const handleVolumeChange = (e) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  };

  // Atajos de teclado/mando (D-pad): antes ni el play/pausa ni avanzar ni
  // el volumen se podían controlar sin ratón/touch salvo llegando por Tab
  // al botón exacto. Espacio/flechas/M/F funcionan desde cualquier sitio
  // del reproductor, igual que en cualquier reproductor de vídeo (YouTube,
  // Netflix...) - se desactivan solo cuando el foco está en un control que
  // ya usa esas teclas para lo suyo (el volumen, un <select>, un campo de
  // texto), para no interferir con su comportamiento nativo.
  useEffect(() => {
    const handleKeyDown = (e) => {
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (active?.getAttribute('role') === 'slider') return;

      const video = videoRef.current;
      if (!video) return;

      const key = keyNameFor(e);
      if (MEDIA_KEYS.has(key)) lastMediaKeyAt.current = Date.now();

      // Modo tele (mando, como Netflix): con el foco en un botón de los
      // controles las flechas van de botón en botón (tvMode.js) y OK lo
      // pulsa; con el foco en el vídeo, ←/→ avanzan, OK pausa y ↑/↓ entran
      // en los controles (el volumen ya lo lleva la tele).
      if (isTvMode()) {
        const onControl = active && active !== shellRef.current && shellRef.current?.contains(active);
        if (onControl && !MEDIA_KEYS.has(key)) return;
        if (key === 'ArrowUp' || key === 'ArrowDown') {
          e.preventDefault();
          shellRef.current?.querySelector('.controls-row .control-btn')?.focus({ preventScroll: true });
          return;
        }
        if (e.key === 'Enter' || e.keyCode === 13) {
          e.preventDefault();
          togglePlay();
          return;
        }
      }

      switch (key) {
        case 'Space':
        case 'MediaPlayPause':
          e.preventDefault();
          togglePlay();
          break;
        case 'MediaPlay':
          e.preventDefault();
          video.play();
          break;
        case 'MediaPause':
          e.preventDefault();
          video.pause();
          break;
        case 'ArrowLeft':
        case 'MediaRewind':
          e.preventDefault();
          seekBy(-10);
          break;
        case 'ArrowRight':
        case 'MediaFastForward':
          e.preventDefault();
          seekBy(10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.1);
          video.muted = false;
          break;
        case 'ArrowDown':
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.1);
          break;
        case 'KeyM':
          e.preventDefault();
          toggleMute();
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef]);

  // Media Session: en Chromium/Android (Silk de Fire TV incluido) los
  // botones multimedia del mando pueden llegar por aquí en vez de como
  // tecla. Si la misma pulsación ya llegó como tecla hace un instante, se
  // ignora, para no saltar 20 s ni pausar y reanudar a la vez.
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return undefined;
    const fromKeyJustNow = () => Date.now() - lastMediaKeyAt.current < 400;
    const handlers = {
      play: () => !fromKeyJustNow() && videoRef.current?.play(),
      pause: () => !fromKeyJustNow() && videoRef.current?.pause(),
      seekbackward: () => !fromKeyJustNow() && seekBy(-10),
      seekforward: () => !fromKeyJustNow() && seekBy(10),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Acción no soportada por este navegador.
      }
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Ídem.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef]);

  useEffect(() => {
    if (!navigator.mediaSession || typeof MediaMetadata === 'undefined' || !title) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title });
  }, [title]);

  // La pista que suena: la elegida o, sin elección, la de por defecto del
  // archivo (si no, el panel no marcaba ninguna).
  const activeAudioIndex = audioIndex ?? (audioTracks.find((t) => t.default) || audioTracks[0])?.index;

  const closeTracksPanel = () => {
    reopenTracksUntil = 0;
    setTracksOpen(false);
    setSubtitleSettingsOpen(false);
    setSubtitleSearchOpen(false);
  };

  // Cierra el panel de audio y subtítulos al hacer clic fuera de él o con
  // Escape (en captura, antes de que WatchPage lo use para salir del vídeo).
  useEffect(() => {
    if (!tracksOpen) return undefined;
    const onClickOutside = (e) => {
      if (subtitleSettingsRef.current && !subtitleSettingsRef.current.contains(e.target)) closeTracksPanel();
    };
    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      closeTracksPanel();
      subtitleSettingsRef.current?.querySelector('.control-btn')?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [tracksOpen]);

  useEffect(() => {
    if (!castOpen) return undefined;
    const onClickOutside = (e) => {
      if (castPanelRef.current && !castPanelRef.current.contains(e.target)) {
        setCastOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [castOpen]);

  // Un solo prefijo de API según el protocolo del dispositivo elegido -
  // DLNA y Chromecast exponen exactamente las mismas rutas (devices/cast/
  // pause/resume/seek/stop/status), así que todo lo demás puede ser
  // idéntico para los dos.
  const apiPrefix = (kind) => (kind === 'chromecast' ? '/api/chromecast' : '/api/dlna');

  // Al abrir el reproductor: si ya había una emisión en marcha para este
  // mismo vídeo (p.ej. se recargó la página) en cualquiera de los dos
  // protocolos, se recupera el estado en vez de empezar como si no hubiera
  // nada emitiéndose.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('/api/dlna/status').then((res) => res.json()).then((data) => ({ ...data, kind: 'dlna' })).catch(() => null),
      fetch('/api/chromecast/status').then((res) => res.json()).then((data) => ({ ...data, kind: 'chromecast' })).catch(() => null),
    ]).then(([dlna, chromecast]) => {
      if (cancelled) return;
      const active = [dlna, chromecast].find((s) => s?.active && s.videoId === id);
      if (active) setCastStatus(active);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Mientras hay una emisión activa para este vídeo, se consulta su estado
  // por *polling* (mismo patrón de setTimeout encadenado ya usado en
  // WatchPage para /api/hls/:id/status) - si deja de estar activa o pasa a
  // ser de otro vídeo, se deja de mostrar como "emitiendo" aquí.
  useEffect(() => {
    if (!castStatus?.active) return undefined;
    let cancelled = false;
    let timer;
    const poll = () => {
      fetch(`${apiPrefix(castStatus.kind)}/status`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (!data.active || data.videoId !== id) {
            setCastStatus(null);
            return;
          }
          setCastStatus({ ...data, kind: castStatus.kind });
          timer = setTimeout(poll, 3000);
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(poll, 5000);
        });
    };
    timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [castStatus?.active, castStatus?.kind, id]);

  const loadCastDevices = () => {
    setCastDevicesLoading(true);
    setCastError(null);
    Promise.all([
      fetch('/api/dlna/devices')
        .then((res) => res.json())
        .then((data) => (data.devices || []).map((d) => ({ ...d, kind: 'dlna' })))
        .catch(() => []),
      fetch('/api/chromecast/devices')
        .then((res) => res.json())
        .then((data) => (data.devices || []).map((d) => ({ ...d, kind: 'chromecast' })))
        .catch(() => []),
    ])
      .then(([dlnaDevices, chromecastDevices]) => {
        setCastDevices([...chromecastDevices, ...dlnaDevices]);
      })
      .finally(() => setCastDevicesLoading(false));
  };

  const toggleCastPanel = () => {
    closeTracksPanel();
    setCastOpen((open) => {
      const next = !open;
      if (next) loadCastDevices();
      return next;
    });
  };

  const startCast = (device) => {
    setCastConnecting(true);
    setCastError(null);
    fetch(`${apiPrefix(device.kind)}/cast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: device.id, videoId: id, profileId, audioIndex }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'No se pudo emitir a este dispositivo.');
        videoRef.current?.pause();
        setCastOpen(false);
        setCastStatus({ active: true, deviceId: device.id, videoId: id, currentTime: 0, playerState: 'PLAYING', kind: device.kind });
      })
      .catch((err) => setCastError(err.message))
      .finally(() => setCastConnecting(false));
  };

  const stopCast = () => {
    fetch(`${apiPrefix(castStatus?.kind)}/stop`, { method: 'POST' }).catch(() => {});
    setCastStatus(null);
  };

  const castTogglePause = () => {
    const path = castStatus?.playerState === 'PAUSED' ? 'resume' : 'pause';
    fetch(`${apiPrefix(castStatus?.kind)}/${path}`, { method: 'POST' }).catch(() => {});
  };

  const castSeekToRatio = (ratio) => {
    if (!duration) return;
    fetch(`${apiPrefix(castStatus?.kind)}/seek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: ratio * duration }),
    }).catch(() => {});
  };

  // En cuanto el subtítulo recién descargado aparece en subtitleTracks (tras
  // onSubtitlesDownloaded, que vuelve a pedir /api/tracks), se activa solo -
  // sin esto, habría que volver a abrir el desplegable y elegirlo dos veces.
  useEffect(() => {
    if (!pendingActivateStreamIndex) return;
    const pos = subtitleTracks.findIndex((t) => String(t.index) === pendingActivateStreamIndex);
    if (pos < 0) return;
    const video = videoRef.current;
    if (video) {
      for (let i = 0; i < video.textTracks.length; i += 1) {
        video.textTracks[i].mode = i === pos ? 'showing' : 'hidden';
      }
    }
    setSubtitleIndex(pos);
    setPendingActivateStreamIndex(null);
    setPendingSearchIndex(null);
    onSubtitleLanguageChange?.(subtitleTracks[pos] || null);
  }, [subtitleTracks, pendingActivateStreamIndex, videoRef, onSubtitleLanguageChange]);

  // Aplica el subtítulo elegido la última vez (guardado por perfil, ver
  // WatchPage) en cuanto se sabe qué pistas trae este vídeo - solo una vez
  // por vídeo (appliedInitialSubtitle), para no pisar una elección manual
  // posterior si subtitleTracks cambia por otro motivo (p.ej. al descargar
  // un subtítulo nuevo de SubDL). Se busca por idioma y, si no hay uno con
  // ese idioma (ediciones de fans sin ese dato en el contenedor, solo un
  // "título" tipo "Español"/"Castellano" - ver comentario en WatchPage
  // sobre findAudioTrackPosition, mismo caso para audio), por título.
  const appliedInitialSubtitle = useRef(false);
  useEffect(() => {
    if (appliedInitialSubtitle.current) return;
    if ((!initialSubtitleLanguage && !initialSubtitleTitle) || subtitleTracks.length === 0) return;
    let pos = initialSubtitleLanguage
      ? subtitleTracks.findIndex((t) => (t.language || '').toLowerCase() === initialSubtitleLanguage.toLowerCase())
      : -1;
    if (pos < 0 && initialSubtitleTitle) {
      pos = subtitleTracks.findIndex((t) => (t.title || '').toLowerCase() === initialSubtitleTitle.toLowerCase());
    }
    if (pos < 0) return;
    appliedInitialSubtitle.current = true;
    const video = videoRef.current;
    if (video) {
      for (let i = 0; i < video.textTracks.length; i += 1) {
        video.textTracks[i].mode = i === pos ? 'showing' : 'hidden';
      }
    }
    setSubtitleIndex(pos);
  }, [subtitleTracks, initialSubtitleLanguage, initialSubtitleTitle, videoRef]);

  // Busca subtítulos en SubDL usando el título del vídeo (server/routes/
  // subdl.js ya saca el nombre limpio y la temporada/episodio del
  // catálogo) - sin caja de texto que rellenar, como el resto de la app.
  // Los resultados se muestran en su propio panel (subtitleSearchOpen),
  // separado del desplegable de pistas ya disponibles.
  const searchSubtitles = () => {
    setSubtitleSearchLoading(true);
    setSubtitleSearchError(null);
    fetch('/api/subdl/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: id }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'No se pudo buscar');
        setSubtitleSearchResults(data.results);
      })
      .catch((err) => setSubtitleSearchError(err.message))
      .finally(() => setSubtitleSearchLoading(false));
  };

  // Se busca sola en cuanto se sabe que SubDL está configurado, así los
  // resultados ya están listos la primera vez que se abre el panel de
  // búsqueda (sin caja de texto que rellenar, como el resto de la app).
  useEffect(() => {
    if (subtitleSearchReady) searchSubtitles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleSearchReady]);

  const downloadSubtitle = (result, searchPos) => {
    setDownloadingIndex(searchPos);
    setSubtitleSearchError(null);
    fetch('/api/subdl/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: id,
        fileId: result.fileId,
        language: result.language,
        release: result.release,
      }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'No se pudo descargar');
        // Ya descargado: se quita de la lista de resultados (ya no tiene
        // sentido ofrecerlo ahí) y se deja preparado para activarse solo en
        // cuanto subtitleTracks lo incluya (ver el efecto de arriba).
        setSubtitleSearchResults((prev) => prev?.filter((_, i) => i !== searchPos) ?? null);
        setPendingActivateStreamIndex(String(data.index));
        setSubtitleSearchOpen(false);
        onSubtitlesDownloaded?.();
      })
      .catch((err) => {
        setSubtitleSearchError(err.message);
      })
      .finally(() => setDownloadingIndex(null));
  };

  // Un archivo (.srt/.vtt) que ya tenía la persona, en vez de buscado en
  // SubDL - se manda tal cual en base64 (server/routes/tracks.js decide si
  // hace falta decodificarlo como Windows-1252, no aquí) para no perder
  // nada al leerlo como texto en el navegador.
  const handleImportFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportingFile(true);
    setImportError(null);
    file
      .arrayBuffer()
      .then((buf) => {
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        const contentBase64 = btoa(binary);
        return fetch('/api/subtitle/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: id, filename: file.name, contentBase64 }),
        });
      })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'No se pudo importar el archivo');
        setPendingActivateStreamIndex(String(data.index));
        setSubtitleSearchOpen(false);
        onSubtitlesDownloaded?.();
      })
      .catch((err) => setImportError(err.message))
      .finally(() => setImportingFile(false));
  };

  const handleSubtitleChange = (e) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Number(e.target.value);
    for (let i = 0; i < video.textTracks.length; i += 1) {
      video.textTracks[i].mode = i === next ? 'showing' : 'hidden';
    }
    setSubtitleIndex(next);
    // Se recuerda por idioma (no por posición: no coincide entre archivos),
    // igual que el idioma de audio - "desactivados" (next === -1) también se
    // guarda, para abrir sin subtítulos la próxima vez si así se prefiere.
    onSubtitleLanguageChange?.(next === -1 ? null : subtitleTracks[next] || null);
  };

  const casting = Boolean(castStatus?.active);
  const displayedCurrentTime = casting ? castStatus.currentTime ?? 0 : currentTime;
  const displayedPlaying = casting ? castStatus.playerState !== 'PAUSED' : playing;
  const progressRatio = duration ? displayedCurrentTime / duration : 0;
  const bufferedRatio = casting ? progressRatio : duration ? buffered / duration : 0;
  const hoverTime = hover ? hover.ratio * duration : 0;

  const previewCell = trickplay && hover
    ? Math.min(trickplay.count - 1, Math.floor(hoverTime / trickplay.interval))
    : null;
  const previewCol = previewCell != null ? previewCell % trickplay.columns : 0;
  const previewRow = previewCell != null ? Math.floor(previewCell / trickplay.columns) : 0;

  return (
    <>
      <div className={`player-topbar ${controlsVisible ? '' : 'player-topbar-hidden'}`}>
        <Link className="back-link" to={backTo}>
          {backLabel}
        </Link>
        <h1 className="watch-title">{title}</h1>
        <div className="topbar-actions">
          {(prevEpisodeId || nextEpisodeId) && (
            <div className="episode-nav">
              <button disabled={!prevEpisodeId} onClick={() => onNavigate(`/watch/${prevEpisodeId}`)}>
                ← Anterior
              </button>
              <button disabled={!nextEpisodeId} onClick={() => onNavigate(`/watch/${nextEpisodeId}`)}>
                Siguiente →
              </button>
            </div>
          )}
          <ProfileButton />
          <HiddenMenu />
        </div>
      </div>
      <div className={`video-controls ${controlsVisible ? '' : 'video-controls-hidden'}`}>
      {casting && (
        <div className="cast-banner">
          <span>
            📺 Emitiendo a{' '}
            {castDevices.find((d) => d.id === castStatus.deviceId && d.kind === castStatus.kind)?.name ||
              castStatus.deviceId}
          </span>
          <button className="secondary" onClick={stopCast}>
            ■ Detener
          </button>
        </div>
      )}
      {hover && trickplay && (
        <div
          className="scrub-preview"
          style={{ left: `${hover.ratio * 100}%` }}
        >
          <div
            className="scrub-thumb"
            style={{
              width: trickplay.thumbWidth,
              height: trickplay.thumbHeight,
              backgroundImage: `url(${trickplay.spriteUrl})`,
              backgroundPosition: `-${previewCol * trickplay.thumbWidth}px -${previewRow * trickplay.thumbHeight}px`,
            }}
          />
          <span className="scrub-time">{formatTime(hoverTime)}</span>
        </div>
      )}

      <div
        className="seek-bar"
        ref={barRef}
        onMouseMove={handleBarMove}
        onMouseLeave={() => !dragging && setHover(null)}
        onMouseDown={handleBarDown}
        onTouchStart={handleBarDown}
      >
        <div className="seek-track">
          <div className="seek-buffered" style={{ width: `${bufferedRatio * 100}%` }} />
          <div className="seek-fill" style={{ width: `${progressRatio * 100}%` }} />
          <div className="seek-handle" style={{ left: `${progressRatio * 100}%` }} />
        </div>
      </div>

      <div className="controls-row">
        <button
          className="control-btn"
          onClick={casting ? castTogglePause : togglePlay}
          aria-label={displayedPlaying ? 'Pausar' : 'Reproducir'}
        >
          {displayedPlaying ? '⏸' : '▶'}
        </button>

        {/* Con el cursor de Silk (Fire TV) las flechas no llegan como
            teclas y arrastrar la barra no es viable: botones de ±10 s. */}
        {!casting && (
          <>
            <button className="control-btn" onClick={() => seekBy(-10)} aria-label="Retroceder 10 segundos" title="−10 s">
              ⟲
            </button>
            <button className="control-btn" onClick={() => seekBy(10)} aria-label="Avanzar 10 segundos" title="+10 s">
              ⟳
            </button>
          </>
        )}

        <span className="time-display">
          {formatTime(displayedCurrentTime)} / {formatTime(duration)}
        </span>

        <div className="volume-control">
          <button className="control-btn" onClick={toggleMute} aria-label={muted ? 'Quitar silencio' : 'Silenciar'}>
            {muted || volume === 0 ? '🔇' : '🔊'}
          </button>
          <input
            className="volume-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
          />
        </div>

        <div className="controls-spacer" />

        <div className="subtitle-controls" ref={subtitleSettingsRef}>
            <input
              type="file"
              accept=".srt,.vtt"
              ref={importFileInputRef}
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <button
              className={`control-btn ${tracksOpen ? 'control-btn-active' : ''}`}
              onClick={() => {
                setCastOpen(false);
                if (tracksOpen) closeTracksPanel();
                else setTracksOpen(true);
              }}
              aria-label="Audio y subtítulos"
              aria-expanded={tracksOpen}
              title="Audio y subtítulos"
            >
              💬
            </button>
            {tracksOpen && !subtitleSettingsOpen && !subtitleSearchOpen && (
              <div className="subtitle-settings-panel tracks-panel" role="dialog" aria-label="Audio y subtítulos">
                <button
                  className="tracks-close"
                  onClick={() => {
                    closeTracksPanel();
                    subtitleSettingsRef.current?.querySelector('.control-btn')?.focus({ preventScroll: true });
                  }}
                  aria-label="Cerrar"
                >
                  ✕
                </button>
                <div className="tracks-columns">
                  {audioTracks.length > 0 && (
                    <div className="tracks-column">
                      <p className="subtitle-settings-title">Audio</p>
                      <ul className="tracks-list">
                        {audioTracks.map((track) => (
                          <li key={track.index}>
                            <button
                              className={`tracks-option ${track.index === activeAudioIndex ? 'tracks-option-active' : ''}`}
                              aria-pressed={track.index === activeAudioIndex}
                              onClick={() => {
                                if (track.index === activeAudioIndex) return;
                                reopenTracksUntil = Date.now() + REOPEN_TRACKS_MS;
                                onAudioChange({ target: { value: String(track.index) } });
                              }}
                            >
                              {trackLabel(track)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="tracks-column">
                    <p className="subtitle-settings-title">Subtítulos</p>
                    <ul className="tracks-list">
                      <li>
                        <button
                          className={`tracks-option ${subtitleIndex === -1 ? 'tracks-option-active' : ''}`}
                          aria-pressed={subtitleIndex === -1}
                          onClick={() => handleSubtitleChange({ target: { value: '-1' } })}
                        >
                          Desactivados
                        </button>
                      </li>
                      {subtitleTracks.map((subtitleTrack, i) => (
                        <li key={subtitleTrack.index}>
                          <button
                            className={`tracks-option ${subtitleIndex === i ? 'tracks-option-active' : ''}`}
                            aria-pressed={subtitleIndex === i}
                            onClick={() => handleSubtitleChange({ target: { value: String(i) } })}
                          >
                            {trackLabel(subtitleTrack)}
                            <span className="tracks-option-source">{subtitleSourceLabel(subtitleTrack)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="tracks-actions">
                  <button
                    className="secondary"
                    onClick={() => importFileInputRef.current?.click()}
                    disabled={importingFile}
                    title="Importar un archivo .srt/.vtt que ya tengas"
                  >
                    {importingFile ? 'Importando…' : '📁 Importar'}
                  </button>
                  {subtitleSearchReady && (
                    <button className="secondary" onClick={() => setSubtitleSearchOpen(true)} title="Buscar subtítulos en SubDL">
                      🔍 Buscar
                    </button>
                  )}
                  {subtitleTracks.length > 0 && (
                    <button className="secondary" onClick={() => setSubtitleSettingsOpen(true)} title="Tamaño y color de los subtítulos">
                      ⚙ Aspecto
                    </button>
                  )}
                </div>
              </div>
            )}
            {tracksOpen && subtitleSettingsOpen && (
              <div className="subtitle-settings-panel tracks-panel">
                <TracksSubviewHeader title="Aspecto de los subtítulos" onBack={() => setSubtitleSettingsOpen(false)} />
                <label>
                  Tamaño
                  <select
                    value={subtitlePrefs.size}
                    onChange={(e) => onSubtitlePrefsChange({ size: e.target.value })}
                  >
                    <option value="small">Pequeño</option>
                    <option value="medium">Mediano</option>
                    <option value="large">Grande</option>
                  </select>
                </label>
                <label>
                  Color
                  <input
                    type="color"
                    value={subtitlePrefs.color}
                    onChange={(e) => onSubtitlePrefsChange({ color: e.target.value })}
                  />
                </label>
                <label>
                  Fondo
                  <select
                    value={subtitlePrefs.background}
                    onChange={(e) => onSubtitlePrefsChange({ background: e.target.value })}
                  >
                    <option value="none">Sin fondo</option>
                    <option value="semi">Semitransparente</option>
                    <option value="solid">Sólido</option>
                  </select>
                </label>
              </div>
            )}
            {tracksOpen && subtitleSearchOpen && (
              <div className="subtitle-settings-panel subtitle-search-panel tracks-panel">
                <TracksSubviewHeader title="Buscar subtítulos (SubDL)" onBack={() => setSubtitleSearchOpen(false)} />
                {subtitleSearchLoading && <span className="subtitle-search-hint">Buscando…</span>}
                {!subtitleSearchLoading && subtitleSearchResults && subtitleSearchResults.length === 0 && (
                  <span className="subtitle-search-hint">Sin resultados para este título.</span>
                )}
                {subtitleSearchError && (
                  <span className="subtitle-search-hint subtitle-search-hint-error">{subtitleSearchError}</span>
                )}
                {subtitleSearchResults && subtitleSearchResults.length > 0 && (
                  <ul className="subtitle-search-results">
                    {subtitleSearchResults.map((result, i) => (
                      <li key={result.fileId}>
                        <span>{result.release}</span>
                        <button
                          className="secondary"
                          disabled={downloadingIndex != null}
                          onClick={() => downloadSubtitle(result, i)}
                        >
                          {downloadingIndex === i ? 'Descargando…' : 'Descargar'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <button className="secondary" onClick={searchSubtitles} disabled={subtitleSearchLoading}>
                  🔄 Buscar de nuevo
                </button>
              </div>
            )}
            {importError && (
              <span className="subtitle-search-hint subtitle-search-hint-error">{importError}</span>
            )}
        </div>

        <div className="cast-controls" ref={castPanelRef}>
          <button
            className={`control-btn ${castOpen || casting ? 'control-btn-active' : ''}`}
            onClick={toggleCastPanel}
            aria-label="Emitir a la TV"
            title="Emitir a la TV (DLNA/Chromecast)"
          >
            📺
          </button>
          {castOpen && (
            <div className="subtitle-settings-panel cast-panel">
              <p className="subtitle-settings-title">Emitir a la TV</p>
              {castDevicesLoading && <span className="subtitle-search-hint">Buscando dispositivos…</span>}
              {!castDevicesLoading && castDevices.length === 0 && (
                <span className="subtitle-search-hint">
                  No se encontró ningún dispositivo (DLNA o Chromecast) en la red.
                </span>
              )}
              {castError && <span className="subtitle-search-hint subtitle-search-hint-error">{castError}</span>}
              {castDevices.length > 0 && (
                <ul className="subtitle-search-results">
                  {castDevices.map((device) => (
                    <li key={`${device.kind}:${device.id}`}>
                      <span>{device.name}</span>
                      <button className="secondary" disabled={castConnecting} onClick={() => startCast(device)}>
                        {castConnecting ? 'Conectando…' : 'Emitir'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button className="secondary" onClick={loadCastDevices} disabled={castDevicesLoading}>
                🔄 Buscar de nuevo
              </button>
            </div>
          )}
        </div>

        <button className="control-btn" onClick={toggleFullscreen} aria-label="Pantalla completa">
          {fullscreen ? '⤡' : '⤢'}
        </button>
      </div>
      </div>
    </>
  );
}
