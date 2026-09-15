import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from './HiddenMenu';

function trackLabel(track) {
  return track.languageLabel || track.title || `Pista ${track.index}`;
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
  const [subtitleDownloadingId, setSubtitleDownloadingId] = useState(null);
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

  // "next" es la POSICIÓN dentro de subtitleTracks/<track> (no el índice de
  // pista del archivo original): así coincide siempre con la posición real
  // en video.textTracks, que sigue el mismo orden en el que se renderizaron
  // los <track> en WatchPage. -1 = subtítulos desactivados.
  const handleSubtitleChange = (e) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Number(e.target.value);
    for (let i = 0; i < video.textTracks.length; i += 1) {
      video.textTracks[i].mode = i === next ? 'showing' : 'hidden';
    }
    setSubtitleIndex(next);
  };

  // Cierra el panel que esté abierto (ajustes o buscador) al hacer clic
  // fuera de él - los dos viven dentro del mismo contenedor con ref.
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

  // Busca subtítulos usando el título del vídeo (server/routes/subdl.js ya
  // saca el nombre limpio y la temporada/episodio del catálogo, y prueba
  // primero SubDL y solo si no hay resultados cae a OpenSubtitles) - sin
  // caja de texto que rellenar, como el resto de la app.
  const searchSubtitles = () => {
    setSubtitleSearchOpen(true);
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

  const downloadSubtitle = (result) => {
    setSubtitleDownloadingId(result.fileId);
    setSubtitleSearchError(null);
    fetch('/api/subdl/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: id,
        fileId: result.fileId,
        language: result.language,
        release: result.release,
        provider: result.provider,
      }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || 'No se pudo descargar');
        onSubtitlesDownloaded?.();
        setSubtitleSearchOpen(false);
      })
      .catch((err) => setSubtitleSearchError(err.message))
      .finally(() => setSubtitleDownloadingId(null));
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
            {subtitleTracks.length > 0 && (
              <select
                className="track-select"
                value={subtitleIndex}
                onChange={handleSubtitleChange}
                aria-label="Subtítulos"
              >
                <option value={-1}>Subtítulos: Desactivados</option>
                {subtitleTracks.map((subtitleTrack, i) => (
                  <option key={subtitleTrack.index} value={i}>
                    {trackLabel(subtitleTrack)}
                  </option>
                ))}
              </select>
            )}
            {subtitleSearchReady && (
              <button
                className={`control-btn ${subtitleSearchOpen ? 'control-btn-active' : ''}`}
                onClick={() => (subtitleSearchOpen ? setSubtitleSearchOpen(false) : searchSubtitles())}
                aria-label="Buscar subtítulos en OpenSubtitles"
                title="Buscar más subtítulos (OpenSubtitles)"
              >
                🔍
              </button>
            )}
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
            {subtitleSearchOpen && (
              <div className="subtitle-settings-panel subtitle-search-panel">
                <p className="subtitle-settings-title">Buscar subtítulos (OpenSubtitles)</p>
                {subtitleSearchLoading && <p className="hint">Buscando...</p>}
                {subtitleSearchError && <p className="config-message error">{subtitleSearchError}</p>}
                {!subtitleSearchLoading && subtitleSearchResults && subtitleSearchResults.length === 0 && (
                  <p className="hint">Sin resultados para este título.</p>
                )}
                {!subtitleSearchLoading && subtitleSearchResults?.length > 0 && (
                  <ul className="subtitle-search-results">
                    {subtitleSearchResults.map((result) => (
                      <li key={result.fileId}>
                        <div className="subtitle-search-result-info">
                          <span className="subtitle-search-result-release">{result.release}</span>
                          <span className="subtitle-search-result-meta">
                            {(result.language || '?').toUpperCase()} · {result.downloadCount} descargas
                            {result.hearingImpaired ? ' · Sordos' : ''}
                          </span>
                        </div>
                        <button
                          className="queue-retry-btn"
                          disabled={subtitleDownloadingId === result.fileId}
                          onClick={() => downloadSubtitle(result)}
                        >
                          {subtitleDownloadingId === result.fileId ? 'Descargando…' : 'Usar'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
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
