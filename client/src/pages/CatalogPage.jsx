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

function FolderCard({ folder, onOpen }) {
  return (
    <button className="card folder-card" onClick={() => onOpen(folder.path)}>
      {folder.thumbnailId ? (
        <img
          className="poster"
          src={`/api/thumbnail/${folder.thumbnailId}`}
          alt={folder.name}
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
        <p className="card-title">{folder.name}</p>
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
    if (!searching) return;
    setError(null);
    fetch('/api/videos')
      .then((res) => res.json())
      .then(setAllVideos)
      .catch(() => setError('No se pudo cargar el catálogo.'));
  }, [searching]);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return allVideos.filter((v) => v.title.toLowerCase().includes(q));
  }, [allVideos, term]);

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
