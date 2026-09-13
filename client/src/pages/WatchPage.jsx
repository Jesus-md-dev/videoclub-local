import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import VideoControls from '../components/VideoControls';

function progressKey(id) {
  return `progress:${id}`;
}

function saveProgress(id, videoEl) {
  if (!videoEl.duration) return;
  const ratio = videoEl.currentTime / videoEl.duration;
  localStorage.setItem(
    progressKey(id),
    JSON.stringify({ time: videoEl.currentTime, ratio, updatedAt: Date.now() })
  );
}

function loadProgress(id) {
  try {
    const raw = localStorage.getItem(progressKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function trackLabel(track) {
  return track.languageLabel || track.title || `Pista ${track.index}`;
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
  const [prevEpisodeId, setPrevEpisodeId] = useState(null);
  const [nextEpisodeId, setNextEpisodeId] = useState(null);
  const [autoAdvanceIn, setAutoAdvanceIn] = useState(null);
  const [forcing, setForcing] = useState(false);
  const [forced, setForced] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const playerRef = useRef(null);
  const shellRef = useRef(null);
  const resumeTimeRef = useRef(null);

  useEffect(() => {
    fetch('/api/videos')
      .then((res) => res.json())
      .then((videos) => {
        const found = videos.find((v) => v.id === id);
        if (!found) {
          setError('El vídeo solicitado no existe en el catálogo.');
          return;
        }
        setVideo(found);
        document.title = `${found.title} - Videoclub Local`;
      })
      .catch(() => setError('No se pudo cargar el catálogo.'));

    fetch(`/api/tracks/${id}`)
      .then((res) => res.json())
      .then(setTracks)
      .catch(() => {});

    setAutoAdvanceIn(null);
    setForced(false);
    setRawMode(false);
  }, [id]);

  useEffect(() => {
    if (!video?.seriesKey) {
      setPrevEpisodeId(null);
      setNextEpisodeId(null);
      return;
    }
    fetch(`/api/videos/browse?dir=${encodeURIComponent(video.seriesKey)}`)
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

  // En modo raw, el servidor ignora la pista de audio (sirve el archivo tal
  // cual), así que cambiarla no debe volver a comprobar el estado del vídeo
  // ni recargarlo: solo importa si se entra/sale de modo raw.
  const statusDep = rawMode ? 'raw' : audioIndex;

  useEffect(() => {
    if (!video) return undefined;
    let cancelled = false;
    let timer;
    setReady(false);
    setPrepProgress(null);

    const params = new URLSearchParams();
    // En modo raw el servidor sirve el archivo tal cual, ignorando la pista
    // de audio (esa selección se hace en el navegador vía audioTracks, ver
    // más abajo); no se incluye aquí para que cambiar de idioma no dispare
    // una nueva comprobación/recarga del vídeo.
    if (audioIndex != null && !rawMode) params.set('audio', audioIndex);
    if (rawMode) params.set('raw', '1');
    const query = params.toString();
    const streamUrl = `/api/stream/${id}/status${query ? `?${query}` : ''}`;

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
    // En modo raw, cambiar de pista de audio no debe re-disparar esta
    // comprobación (se gestiona aparte con audioTracks nativo): se usa
    // `statusDep` en vez de audioIndex/rawMode por separado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, id, statusDep]);

  useEffect(() => {
    const player = playerRef.current;
    if (!video || !ready || !player) return undefined;

    const saved = loadProgress(id);
    const onLoadedMetadata = () => {
      if (resumeTimeRef.current != null) {
        player.currentTime = resumeTimeRef.current;
        resumeTimeRef.current = null;
      } else if (saved && saved.ratio < 0.95) {
        player.currentTime = saved.time;
      }
      if (rawMode) applyNativeAudioTrack(audioIndex);
    };
    const onPause = () => saveProgress(id, player);
    const onEnded = () => {
      localStorage.setItem(
        progressKey(id),
        JSON.stringify({ time: 0, ratio: 1, updatedAt: Date.now() })
      );
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
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!autoRetried) {
          autoRetried = true;
          doRetry();
        } else {
          setStuck(true);
        }
      }, 15000);
    };
    const clearStall = () => {
      clearTimeout(stallTimer);
      setStuck(false);
    };
    const onError = () => {
      if (!autoRetried) {
        autoRetried = true;
        doRetry();
      } else {
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

    const interval = setInterval(() => saveProgress(id, player), 5000);
    const onBeforeUnload = () => saveProgress(id, player);
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
      saveProgress(id, player);
    };
  }, [video, ready, id, playbackKey, nextEpisodeId]);

  // En modo raw no hay recodificación por pista: se cambia de idioma
  // activando/desactivando las pistas embebidas del propio <video> con la
  // API nativa audioTracks, sin recargar el archivo ni perder la posición.
  // Depende de que el navegador exponga varias audioTracks para el
  // contenedor (soportado en Chrome/Edge para mp4; no todos los
  // navegadores/contenedores lo permiten).
  const applyNativeAudioTrack = (streamIndex) => {
    const player = playerRef.current;
    if (!player?.audioTracks) return;
    const target = streamIndex == null ? tracks.audio.find((t) => t.default) || tracks.audio[0] : tracks.audio.find((t) => t.index === streamIndex);
    const targetPos = target ? tracks.audio.indexOf(target) : -1;
    for (let i = 0; i < player.audioTracks.length; i += 1) {
      player.audioTracks[i].enabled = i === targetPos;
    }
  };

  const handleAudioChange = (e) => {
    const value = e.target.value;
    const numValue = value === '' ? null : Number(value);
    if (rawMode) {
      setAudioIndex(numValue);
      applyNativeAudioTrack(numValue);
      return;
    }
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setAudioIndex(numValue);
  };

  const handleForcePriority = () => {
    setForcing(true);
    const url = `/api/stream/${id}/priority${audioIndex != null ? `?audio=${audioIndex}` : ''}`;
    fetch(url, { method: 'POST' })
      .then((res) => res.json())
      .then(() => setForced(true))
      .catch(() => {})
      .finally(() => setForcing(false));
  };

  const retryPlayback = () => {
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setStuck(false);
    setPlaybackKey((k) => k + 1);
  };

  const streamParams = new URLSearchParams();
  if (audioIndex != null && !rawMode) streamParams.set('audio', audioIndex);
  if (rawMode) streamParams.set('raw', '1');
  const streamQuery = streamParams.toString();
  const streamSrc = `/api/stream/${id}${streamQuery ? `?${streamQuery}` : ''}`;
  const backTo = video?.seriesKey ? `/?dir=${encodeURIComponent(video.seriesKey)}` : '/';
  const backLabel = video?.seriesKey ? '← Volver a episodios' : '← Volver al catálogo';

  return (
    <>
      <div className="watch-header">
        <Link className="back-link" to={backTo}>
          {backLabel}
        </Link>
        <h1 className="watch-title">{error ? 'Error' : video ? video.title : 'Cargando...'}</h1>
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
          <select
            className="track-select"
            value={audioIndex ?? ''}
            onChange={handleAudioChange}
            title={rawMode ? 'En formato original, depende de que el navegador soporte varias pistas de audio.' : undefined}
          >
            {tracks.audio.map((track) => (
              <option key={track.index} value={track.index}>
                Audio: {trackLabel(track)}
              </option>
            ))}
          </select>
        )}
      </div>
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
            {forced ? (
              <p className="prep-detail">Priorizado. Si había otra conversión en marcha, se ha interrumpido para dar paso a esta.</p>
            ) : (
              <button onClick={handleForcePriority} disabled={forcing}>
                {forcing ? 'Priorizando...' : 'Forzar prioridad'}
              </button>
            )}
            <button className="raw-mode-btn" onClick={() => setRawMode(true)}>
              Reproducir sin convertir
            </button>
            <p className="prep-detail">Formato original: puede no funcionar en este dispositivo/navegador.</p>
          </div>
        )}
        {!error && video && ready && (
          <div className="player-column">
            {rawMode && <p className="prep-detail">Reproduciendo en formato original (sin convertir).</p>}
            <div className="player-shell" ref={shellRef}>
              <video
                key={playbackKey}
                ref={playerRef}
                autoPlay
                playsInline
                src={streamSrc}
                onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
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
                subtitleTracks={tracks.subtitles}
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
    </>
  );
}
