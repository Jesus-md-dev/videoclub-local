import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from './HiddenMenu';

function trackLabel(track) {
  return track.languageLabel || track.title || `Pista ${track.index}`;
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
  const subtitleSettingsRef = useRef(null);
  const castPanelRef = useRef(null);

  // Emitir a la TV (DLNA/UPnP, issue #99): castStatus es null salvo que haya
  // una emisión activa PARA ESTE vídeo concreto - así, si se emitió otro
  // vídeo antes o desde otra pestaña, no se confunde con el de aquí.
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
      if (playing && !dragging) {
        hideTimer.current = setTimeout(() => setControlsVisible(false), 3000);
      }
    };

    showThenScheduleHide();
    shell.addEventListener('mousemove', showThenScheduleHide);
    shell.addEventListener('touchstart', showThenScheduleHide);
    return () => {
      shell.removeEventListener('mousemove', showThenScheduleHide);
      shell.removeEventListener('touchstart', showThenScheduleHide);
      clearTimeout(hideTimer.current);
    };
  }, [shellRef, playing, dragging]);

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
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      shell.requestFullscreen?.();
    }
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

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration || video.currentTime + 10, video.currentTime + 10);
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

  // Cierra el panel abierto (ajustes o búsqueda) al hacer clic fuera de él.
  useEffect(() => {
    if (!subtitleSettingsOpen && !subtitleSearchOpen) return undefined;
    const onClickOutside = (e) => {
      if (subtitleSettingsRef.current && !subtitleSettingsRef.current.contains(e.target)) {
        setSubtitleSettingsOpen(false);
        setSubtitleSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [subtitleSettingsOpen, subtitleSearchOpen]);

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

  // Al abrir el reproductor: si ya había una emisión en marcha para este
  // mismo vídeo (p.ej. se recargó la página), se recupera el estado en vez
  // de empezar como si no hubiera nada emitiéndose.
  useEffect(() => {
    fetch('/api/dlna/status')
      .then((res) => res.json())
      .then((data) => {
        if (data.active && data.videoId === id) setCastStatus(data);
      })
      .catch(() => {});
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
      fetch('/api/dlna/status')
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (!data.active || data.videoId !== id) {
            setCastStatus(null);
            return;
          }
          setCastStatus(data);
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
  }, [castStatus?.active, id]);

  const loadCastDevices = () => {
    setCastDevicesLoading(true);
    setCastError(null);
    fetch('/api/dlna/devices')
      .then((res) => res.json())
      .then((data) => setCastDevices(data.devices || []))
      .catch(() => setCastError('No se pudo buscar dispositivos.'))
      .finally(() => setCastDevicesLoading(false));
  };

  const toggleCastPanel = () => {
    setSubtitleSettingsOpen(false);
    setSubtitleSearchOpen(false);
    setCastOpen((open) => {
      const next = !open;
      if (next) loadCastDevices();
      return next;
    });
  };

  const startCast = (deviceId) => {
    setCastConnecting(true);
    setCastError(null);
    fetch('/api/dlna/cast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, videoId: id, profileId, audioIndex }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'No se pudo emitir a este dispositivo.');
        videoRef.current?.pause();
        setCastOpen(false);
        setCastStatus({ active: true, deviceId, videoId: id, currentTime: 0, playerState: 'PLAYING' });
      })
      .catch((err) => setCastError(err.message))
      .finally(() => setCastConnecting(false));
  };

  const stopCast = () => {
    fetch('/api/dlna/stop', { method: 'POST' }).catch(() => {});
    setCastStatus(null);
  };

  const castTogglePause = () => {
    const path = castStatus?.playerState === 'PAUSED' ? 'resume' : 'pause';
    fetch(`/api/dlna/${path}`, { method: 'POST' }).catch(() => {});
  };

  const castSeekToRatio = (ratio) => {
    if (!duration) return;
    fetch('/api/dlna/seek', {
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
          <HiddenMenu />
        </div>
      </div>
      <div className={`video-controls ${controlsVisible ? '' : 'video-controls-hidden'}`}>
      {casting && (
        <div className="cast-banner">
          <span>📺 Emitiendo a {castDevices.find((d) => d.id === castStatus.deviceId)?.name || castStatus.deviceId}</span>
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

        {audioTracks.length > 1 && (
          <select className="track-select" value={audioIndex ?? ''} onChange={onAudioChange} aria-label="Audio">
            {audioTracks.map((track) => (
              <option key={track.index} value={track.index}>
                Audio: {trackLabel(track)}
              </option>
            ))}
          </select>
        )}

        <div className="subtitle-controls" ref={subtitleSettingsRef}>
            <select
              className="track-select"
              value={subtitleIndex}
              onChange={handleSubtitleChange}
              aria-label="Subtítulos"
            >
              <option value={-1}>Subtítulos: Desactivados</option>
              {subtitleTracks.map((subtitleTrack, i) => (
                <option key={subtitleTrack.index} value={i}>
                  {trackLabel(subtitleTrack)} ({subtitleSourceLabel(subtitleTrack)})
                </option>
              ))}
            </select>
            <input
              type="file"
              accept=".srt,.vtt"
              ref={importFileInputRef}
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
            <button
              className="control-btn"
              onClick={() => importFileInputRef.current?.click()}
              disabled={importingFile}
              aria-label="Importar subtítulo"
              title="Importar un archivo .srt/.vtt que ya tengas"
            >
              {importingFile ? '…' : '📁'}
            </button>
            {subtitleSearchReady && (
              <button
                className={`control-btn ${subtitleSearchOpen ? 'control-btn-active' : ''}`}
                onClick={() => {
                  setSubtitleSettingsOpen(false);
                  setSubtitleSearchOpen((v) => !v);
                }}
                aria-label="Buscar subtítulos"
                title="Buscar subtítulos en SubDL"
              >
                🔍
              </button>
            )}
            {subtitleTracks.length > 0 && (
              <button
                className={`control-btn ${subtitleSettingsOpen ? 'control-btn-active' : ''}`}
                onClick={() => {
                  setSubtitleSearchOpen(false);
                  setSubtitleSettingsOpen((v) => !v);
                }}
                aria-label="Ajustes de subtítulos"
                title="Tamaño y color de los subtítulos"
              >
                ⚙
              </button>
            )}
            {subtitleSettingsOpen && (
              <div className="subtitle-settings-panel">
                <p className="subtitle-settings-title">Aspecto de los subtítulos</p>
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
            {subtitleSearchOpen && (
              <div className="subtitle-settings-panel subtitle-search-panel">
                <p className="subtitle-settings-title">Buscar subtítulos (SubDL)</p>
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
            title="Emitir a la TV (DLNA)"
          >
            📺
          </button>
          {castOpen && (
            <div className="subtitle-settings-panel cast-panel">
              <p className="subtitle-settings-title">Emitir a la TV</p>
              {castDevicesLoading && <span className="subtitle-search-hint">Buscando dispositivos…</span>}
              {!castDevicesLoading && castDevices.length === 0 && (
                <span className="subtitle-search-hint">
                  No se encontró ningún dispositivo DLNA en la red.
                </span>
              )}
              {castError && <span className="subtitle-search-hint subtitle-search-hint-error">{castError}</span>}
              {castDevices.length > 0 && (
                <ul className="subtitle-search-results">
                  {castDevices.map((device) => (
                    <li key={device.id}>
                      <span>{device.name}</span>
                      <button className="secondary" disabled={castConnecting} onClick={() => startCast(device.id)}>
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
