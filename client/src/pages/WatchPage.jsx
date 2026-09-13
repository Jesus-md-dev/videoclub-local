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

export default function WatchPage() {
  const { id } = useParams();
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);
  const playerRef = useRef(null);

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
  }, [id]);

  useEffect(() => {
    const player = playerRef.current;
    if (!video || !player) return undefined;

    const saved = loadProgress(id);
    const onLoadedMetadata = () => {
      if (saved && saved.ratio < 0.95) {
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

    player.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);

    const interval = setInterval(() => saveProgress(id, player), 5000);
    const onBeforeUnload = () => saveProgress(id, player);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      player.removeEventListener('loadedmetadata', onLoadedMetadata);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearInterval(interval);
      saveProgress(id, player);
    };
  }, [video, id]);

  return (
    <>
      <div className="watch-header">
        <Link className="back-link" to="/">
          &larr; Volver al catálogo
        </Link>
        <h1 className="watch-title">{error ? 'Error' : video ? video.title : 'Cargando...'}</h1>
      </div>
      <div className="player-wrap">
        {error && <div className="error-box">{error}</div>}
        {!error && video && (
          <video ref={playerRef} controls autoPlay src={`/api/stream/${id}`} />
        )}
      </div>
    </>
  );
}
