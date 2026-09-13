import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

function progressFor(id) {
  try {
    const raw = localStorage.getItem(`progress:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function VideoCard({ video }) {
  const progress = progressFor(video.id);
  const showProgress = progress && progress.ratio < 0.95;

  return (
    <Link className="card" to={`/watch/${video.id}`}>
      {showProgress && <span className="badge">Continuar</span>}
      <img
        className="poster"
        src={`/api/thumbnail/${video.id}`}
        alt={video.title}
        loading="lazy"
        onError={(e) => {
          e.currentTarget.onerror = null;
          e.currentTarget.src = '/placeholder.svg';
        }}
      />
      {showProgress && (
        <div className="progress-bar">
          <div style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
        </div>
      )}
      <div className="card-info">
        <p className="card-title">{video.title}</p>
      </div>
    </Link>
  );
}

export default function CatalogPage() {
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState(null);
  const [term, setTerm] = useState('');

  useEffect(() => {
    fetch('/api/videos')
      .then((res) => res.json())
      .then(setVideos)
      .catch(() => setError('No se pudo cargar el catálogo.'));
  }, []);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return videos;
    return videos.filter((v) => v.title.toLowerCase().includes(q));
  }, [videos, term]);

  return (
    <>
      <header>
        <Link className="logo" to="/">
          VIDEO<span>CLUB</span>
        </Link>
        <input
          id="search"
          type="search"
          placeholder="Buscar título..."
          autoComplete="off"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </header>
      <main>
        <p className="section-title">Estanterías</p>
        <div className="grid">
          {filtered.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </div>
        {error && <p className="empty-state">{error}</p>}
        {!error && filtered.length === 0 && (
          <p className="empty-state">
            {videos.length === 0
              ? 'No hay vídeos en el catálogo todavía.'
              : 'No hay resultados para tu búsqueda.'}
          </p>
        )}
      </main>
    </>
  );
}
