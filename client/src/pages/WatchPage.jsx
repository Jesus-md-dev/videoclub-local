import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

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

export default function WatchPage() {
  const { id } = useParams();
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [tracks, setTracks] = useState({ audio: [], subtitles: [] });
  const [audioIndex, setAudioIndex] = useState(null);
  const [playbackKey, setPlaybackKey] = useState(0);
  const [stuck, setStuck] = useState(false);
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
  }, [id]);

  useEffect(() => {
    if (!video) return undefined;
    let cancelled = false;
    let timer;
    setReady(false);

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
            timer = setTimeout(checkStatus, 3000);
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
    };

    // Si la reproducción se queda esperando datos y no se recupera sola en
    // un rato, se ofrece un botón para reintentar sin recargar la página.
    let stallTimer;
    const onWaiting = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => setStuck(true), 15000);
    };
    const clearStall = () => {
      clearTimeout(stallTimer);
      setStuck(false);
    };
    const onError = () => setStuck(true);

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
  }, [video, ready, id, playbackKey]);

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
          <div className="error-box">
            Preparando vídeo para este dispositivo... puede tardar unos minutos la primera vez.
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
          </div>
        )}
      </div>
    </>
  );
}
