import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

function progressFor(id) {
  try {
    const raw = localStorage.getItem(`progress:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// IDs con progreso guardado (ni recién empezados ni ya terminados),
// ordenados por lo visto más recientemente.
function continueWatchingIds() {
  const entries = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key?.startsWith('progress:')) continue;
    try {
      const data = JSON.parse(localStorage.getItem(key));
      if (data.ratio > 0.02 && data.ratio < 0.95) {
        entries.push({ id: key.slice('progress:'.length), updatedAt: data.updatedAt || 0 });
      }
    } catch {
      // entrada corrupta, se ignora
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.map((e) => e.id);
}

function VideoCard({ video }) {
  const progress = progressFor(video.id);
  const showProgress = progress && progress.ratio < 0.95;
  const posterSrc = video.poster || `/api/thumbnail/${video.id}`;
  // El nombre limpio es el de la serie (mismo para todos sus episodios), así
  // que en un episodio taparía el número; solo se usa en películas sueltas.
  const displayTitle = video.seriesKey ? video.title : video.cleanName || video.title;

  return (
    <Link className="card" to={`/watch/${video.id}`}>
      {showProgress && <span className="badge">Continuar</span>}
      <img
        className="poster"
        src={posterSrc}
        alt={displayTitle}
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
        <p className="card-title">{displayTitle}</p>
      </div>
    </Link>
  );
}

function FolderCard({ folder, onOpen }) {
  const posterSrc = folder.poster || (folder.thumbnailId ? `/api/thumbnail/${folder.thumbnailId}` : null);
  const displayName = folder.cleanName || folder.name;

  return (
    <button className="card folder-card" onClick={() => onOpen(folder.path)}>
      {posterSrc ? (
        <img
          className="poster"
          src={posterSrc}
          alt={displayName}
          loading="lazy"
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = '/placeholder.svg';
          }}
        />
      ) : (
        <div className="folder-icon">📁</div>
      )}
      <div className="card-info">
        <p className="card-title">{displayName}</p>
      </div>
    </button>
  );
}

function GenreFilter({ genres, active, onToggle }) {
  if (genres.length === 0) return null;
  return (
    <div className="genre-filter">
      {genres.map((genre) => (
        <button
          key={genre}
          className={`chip ${active === genre ? 'chip-active' : ''}`}
          onClick={() => onToggle(genre)}
        >
          {genre}
        </button>
      ))}
    </div>
  );
}

function Breadcrumb({ dir, onNavigate }) {
  const segments = dir ? dir.split('/') : [];
  return (
    <div className="breadcrumb">
      <button className="crumb" onClick={() => onNavigate('')}>
        Inicio
      </button>
      {segments.map((segment, index) => {
        const path = segments.slice(0, index + 1).join('/');
        return (
          <span key={path}>
            <span className="crumb-sep">/</span>
            <button className="crumb" onClick={() => onNavigate(path)}>
              {segment}
            </button>
          </span>
        );
      })}
    </div>
  );
}

export default function CatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const dir = searchParams.get('dir') || '';
  const term = searchParams.get('q') || '';

  const genre = searchParams.get('genre') || '';

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [dir]);

  const [folders, setFolders] = useState([]);
  const [videos, setVideos] = useState([]);
  const [allVideos, setAllVideos] = useState([]);
  const [genres, setGenres] = useState([]);
  const [error, setError] = useState(null);

  const searching = term.trim().length > 0;

  useEffect(() => {
    fetch('/api/genres')
      .then((res) => res.json())
      .then(setGenres)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (searching) return;
    setError(null);
    fetch(`/api/videos/browse?dir=${encodeURIComponent(dir)}`)
      .then((res) => res.json())
      .then((data) => {
        setFolders(data.folders);
        setVideos(data.videos);
      })
      .catch(() => setError('No se pudo cargar el catálogo.'));
  }, [dir, searching]);

  useEffect(() => {
    // Se usa tanto para la búsqueda global como para "Continuar viendo".
    fetch('/api/videos')
      .then((res) => res.json())
      .then(setAllVideos)
      .catch(() => {
        if (searching) setError('No se pudo cargar el catálogo.');
      });
  }, []);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return allVideos.filter((v) => v.title.toLowerCase().includes(q));
  }, [allVideos, term]);

  const continueWatching = useMemo(() => {
    if (searching || dir || allVideos.length === 0) return [];
    const byId = new Map(allVideos.map((v) => [v.id, v]));
    return continueWatchingIds()
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, 12);
  }, [allVideos, searching, dir]);

  const goToDir = (newDir) => setSearchParams(newDir ? { dir: newDir } : {});
  const handleSearch = (value) => {
    if (value) setSearchParams({ q: value });
    else setSearchParams(dir ? { dir } : {});
  };
  const toggleGenre = (g) => {
    const params = {};
    if (dir) params.dir = dir;
    if (g !== genre) params.genre = g;
    setSearchParams(params);
  };

  const visibleFolders = genre ? folders.filter((f) => f.genres?.includes(genre)) : folders;
  const visibleVideos = genre ? videos.filter((v) => v.genres?.includes(genre)) : videos;

  const list = searching ? filtered : visibleVideos;
  const showFolders = !searching && visibleFolders.length > 0;
  const isEmpty = !error && list.length === 0 && (searching || visibleFolders.length === 0);

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
          onChange={(e) => handleSearch(e.target.value)}
        />
      </header>
      <main>
        {!searching && <Breadcrumb dir={dir} onNavigate={goToDir} />}
        {!searching && <GenreFilter genres={genres} active={genre} onToggle={toggleGenre} />}

        {searching && (
          <>
            <p className="section-title">Resultados</p>
            <div className="grid">
              {list.map((video) => (
                <VideoCard key={video.id} video={video} />
              ))}
            </div>
          </>
        )}

        {!searching && (
          <>
            {continueWatching.length > 0 && (
              <>
                <p className="section-title">Continuar viendo</p>
                <div className="grid">
                  {continueWatching.map((video) => (
                    <VideoCard key={video.id} video={video} />
                  ))}
                </div>
              </>
            )}

            {visibleVideos.length > 0 && (
              <>
                <p className="section-title">{dir ? 'Vídeos' : 'Películas'}</p>
                <div className="grid">
                  {visibleVideos.map((video) => (
                    <VideoCard key={video.id} video={video} />
                  ))}
                </div>
              </>
            )}

            {showFolders && (
              <>
                <p className="section-title">{dir ? 'Carpetas' : 'Series'}</p>
                <div className="grid folder-grid">
                  {visibleFolders.map((folder) => (
                    <FolderCard key={folder.path} folder={folder} onOpen={goToDir} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {error && <p className="empty-state">{error}</p>}
        {isEmpty && (
          <p className="empty-state">
            {searching ? 'No hay resultados para tu búsqueda.' : 'Esta carpeta está vacía.'}
          </p>
        )}
      </main>
    </>
  );
}
