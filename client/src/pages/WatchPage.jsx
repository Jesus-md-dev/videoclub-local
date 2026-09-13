import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

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
  const playerRef = useRef(null);
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

  useEffect(() => {
    if (!video) return undefined;
    let cancelled = false;
    let timer;
    setReady(false);
    setPrepProgress(null);

    const streamUrl = `/api/stream/${id}/status${audioIndex != null ? `?audio=${audioIndex}` : ''}`;

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

  const handleAudioChange = (e) => {
    const value = e.target.value;
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setAudioIndex(value === '' ? null : Number(value));
  };

  const retryPlayback = () => {
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setStuck(false);
    setPlaybackKey((k) => k + 1);
  };

  const streamSrc = `/api/stream/${id}${audioIndex != null ? `?audio=${audioIndex}` : ''}`;
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
          <select className="track-select" value={audioIndex ?? ''} onChange={handleAudioChange}>
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
          </div>
        )}
        {!error && video && ready && (
          <div className="player-column">
            <video key={playbackKey} ref={playerRef} controls autoPlay src={streamSrc}>
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
