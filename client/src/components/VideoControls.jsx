import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from './HiddenMenu';

function trackLabel(track) {
  return track.languageLabel || track.title || `Pista ${track.index}`;
}

// El origen de una pista de subtítulo se distingue por el prefijo de su
// "index" (ver server/tracks.js: "ext<hash>" = descargado de SubDL; un
// número o "<n>" suelto = incrustado en el propio archivo, o ya extraído
// de él). Solo tiene sentido para subtítulos, no para audio.
function subtitleSourceLabel(track) {
  const index = String(track.index);
  if (index.startsWith('ext')) return 'SubDL';
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
  const [subtitleSearchResults, setSubtitleSearchResults] = useState(null);
  const [subtitleSearchLoading, setSubtitleSearchLoading] = useState(false);
  const [subtitleSearchError, setSubtitleSearchError] = useState(null);
  // Mientras se descarga un subtítulo elegido de la lista de búsqueda (aún
  // no está en subtitleTracks, así que no tiene una posición real todavía):
  // se refleja como seleccionado en el propio desplegable (en vez de un
  // panel aparte) usando este valor especial en vez de una posición.
  const [pendingSearchIndex, setPendingSearchIndex] = useState(null);
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
    setDragging(true);
    const ratio = ratioFromEvent(e);
    setHover({ ratio });
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

  // Cierra el panel de ajustes al hacer clic fuera de él.
  useEffect(() => {
    if (!subtitleSettingsOpen) return undefined;
    const onClickOutside = (e) => {
      if (subtitleSettingsRef.current && !subtitleSettingsRef.current.contains(e.target)) {
        setSubtitleSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [subtitleSettingsOpen]);

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
  // Los resultados se añaden como opciones más dentro del mismo
  // desplegable de subtítulos, no en un panel aparte.
  const searchSubtitles = () => {
    setSubtitleSettingsOpen(false);
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

  // Elegir "Buscar subtítulos" en el <select> cierra el desplegable (así
  // funciona cualquier <select> nativo al elegir una opción) - había que
  // volver a abrirlo para ver los resultados. Para no depender de ese clic,
  // se busca sola en cuanto se sabe que SubDL está configurado: los
  // resultados ya están dentro del desplegable la primera vez que se abre.
  useEffect(() => {
    if (subtitleSearchReady) searchSubtitles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleSearchReady]);

  const downloadSubtitle = (result, searchPos) => {
    setPendingSearchIndex(searchPos);
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
        // Ya descargado: se quita de "buscar y descargar" (ya no tiene
        // sentido ofrecerlo ahí) y se deja preparado para activarse solo en
        // cuanto subtitleTracks lo incluya (ver el efecto de arriba).
        setSubtitleSearchResults((prev) => prev?.filter((_, i) => i !== searchPos) ?? null);
        setPendingActivateStreamIndex(String(data.index));
        onSubtitlesDownloaded?.();
      })
      .catch((err) => {
        setSubtitleSearchError(err.message);
        setPendingSearchIndex(null);
      });
  };

  // Valor mostrado en el desplegable: una posición real (número, o -1 =
  // desactivados) mientras no haya nada descargándose; el índice dentro de
  // subtitleSearchResults (con el prefijo "search-") mientras se está
  // descargando el elegido de la lista de búsqueda.
  const selectValue = pendingSearchIndex != null ? `search-${pendingSearchIndex}` : subtitleIndex;

  const handleSubtitleChange = (e) => {
    const { value } = e.target;
    if (value === 'trigger-search') {
      searchSubtitles();
      return;
    }
    if (value.startsWith('search-')) {
      const searchPos = Number(value.slice('search-'.length));
      const result = subtitleSearchResults?.[searchPos];
      if (result) downloadSubtitle(result, searchPos);
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    const next = Number(value);
    for (let i = 0; i < video.textTracks.length; i += 1) {
      video.textTracks[i].mode = i === next ? 'showing' : 'hidden';
    }
    setSubtitleIndex(next);
    setPendingSearchIndex(null);
    // Se recuerda por idioma (no por posición: no coincide entre archivos),
    // igual que el idioma de audio - "desactivados" (next === -1) también se
    // guarda, para abrir sin subtítulos la próxima vez si así se prefiere.
    onSubtitleLanguageChange?.(next === -1 ? null : subtitleTracks[next] || null);
  };

  const progressRatio = duration ? currentTime / duration : 0;
  const bufferedRatio = duration ? buffered / duration : 0;
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
          {audioTracks.length > 1 && (
            <select className="track-select" value={audioIndex ?? ''} onChange={onAudioChange}>
              {audioTracks.map((track) => (
                <option key={track.index} value={track.index}>
                  Audio: {trackLabel(track)}
                </option>
              ))}
            </select>
          )}
          <HiddenMenu />
        </div>
      </div>
      <div className={`video-controls ${controlsVisible ? '' : 'video-controls-hidden'}`}>
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
        <button className="control-btn" onClick={togglePlay} aria-label={playing ? 'Pausar' : 'Reproducir'}>
          {playing ? '⏸' : '▶'}
        </button>

        <span className="time-display">
          {formatTime(currentTime)} / {formatTime(duration)}
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

        {(subtitleTracks.length > 0 || subtitleSearchReady) && (
          <div className="subtitle-controls" ref={subtitleSettingsRef}>
            <select
              className="track-select"
              value={selectValue}
              onChange={handleSubtitleChange}
              aria-label="Subtítulos"
            >
              <option value={-1}>Subtítulos: Desactivados</option>
              {subtitleTracks.length > 0 && (
                <optgroup label="Disponibles">
                  {subtitleTracks.map((subtitleTrack, i) => (
                    <option key={subtitleTrack.index} value={i}>
                      {trackLabel(subtitleTrack)} ({subtitleSourceLabel(subtitleTrack)})
                    </option>
                  ))}
                </optgroup>
              )}
              {subtitleSearchReady && (
                <optgroup label="Buscar y descargar">
                  <option value="trigger-search" disabled={subtitleSearchLoading}>
                    {subtitleSearchLoading
                      ? 'Buscando…'
                      : subtitleSearchResults === null
                        ? '🔍 Buscar subtítulos'
                        : '🔄 Buscar de nuevo'}
                  </option>
                  {subtitleSearchResults?.map((result, i) => (
                    <option key={result.fileId} value={`search-${i}`}>
                      {pendingSearchIndex === i ? 'Descargando… ' : ''}
                      {result.release} (SubDL)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {subtitleTracks.length > 0 && (
              <button
                className={`control-btn ${subtitleSettingsOpen ? 'control-btn-active' : ''}`}
                onClick={() => setSubtitleSettingsOpen((v) => !v)}
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
            {!subtitleSearchLoading && subtitleSearchResults && subtitleSearchResults.length === 0 && (
              <span className="subtitle-search-hint">Sin resultados para este título.</span>
            )}
            {subtitleSearchError && <span className="subtitle-search-hint subtitle-search-hint-error">{subtitleSearchError}</span>}
          </div>
        )}

        <button className="control-btn" onClick={toggleFullscreen} aria-label="Pantalla completa">
          {fullscreen ? '⤡' : '⤢'}
        </button>
      </div>
      </div>
    </>
  );
}
