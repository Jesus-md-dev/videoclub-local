import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getActiveProfileId } from '../profile';

function processingBadgeLabel(state, percent) {
  if (state === 'active') return `Procesando… ${typeof percent === 'number' ? `${percent}%` : ''}`.trim();
  if (state === 'queued') return 'Pendiente de conversión';
  return null;
}

// El progreso ya no vive en localStorage: se guarda en el servidor por
// perfil, así que se ve igual desde cualquier dispositivo de la red.
// `progressMap` es { [videoId]: { time, ratio, updatedAt, dismissedAt? } },
// cargado una vez desde /api/profiles/:id/progress.
function continueWatchingIds(progressMap) {
  const entries = Object.entries(progressMap)
    .filter(([, data]) => data.ratio > 0.02 && data.ratio < 0.95)
    .filter(([, data]) => !data.dismissedAt || data.dismissedAt < (data.updatedAt || 0))
    .map(([id, data]) => ({ id, updatedAt: data.updatedAt || 0 }));
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.map((e) => e.id);
}

function VideoCard({ video, progress, onRemove }) {
  const showProgress = progress && progress.ratio < 0.95;
  // Terminado del todo (no a medias, eso ya lo cubre "Continuar"): se
  // excluyen del todo los mismos que "showProgress", así que nunca
  // coinciden en la misma carátula.
  const showWatched = progress && progress.ratio >= 0.95;
  const posterSrc = video.poster || `/api/thumbnail/${video.id}`;
  // El nombre limpio es el de la serie (mismo para todos sus episodios), así
  // que en un episodio taparía el número; solo se usa en películas sueltas.
  const displayTitle = video.seriesKey ? video.title : video.cleanName || video.title;
  const processingLabel = processingBadgeLabel(video.processingState, video.processingPercent);

  return (
    <Link className="card" to={`/watch/${video.id}`}>
      {showProgress && <span className="badge">Continuar</span>}
      {showWatched && <span className="badge badge-watched">✓ Visto</span>}
      {processingLabel && (
        <span className={`badge badge-processing badge-${video.processingState}`}>{processingLabel}</span>
      )}
      {onRemove && (
        <button
          className="card-remove"
          title="Quitar de Continuar viendo"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove(video.id);
          }}
        >
          ✕
        </button>
      )}
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
  const processingLabel = processingBadgeLabel(folder.processingState, folder.processingPercent);
  // Fracción de episodios ya vistos de la serie completa (no del episodio
  // suelto, eso ya lo cubre "Continuar viendo"); null si no hay perfil
  // activo, o si aún no se ha empezado ninguno.
  const seriesProgress = folder.seriesProgress;
  const showSeriesProgress = seriesProgress && seriesProgress.watched > 0;
  const showSeriesWatched = seriesProgress && seriesProgress.ratio >= 1;

  return (
    <button className="card folder-card" onClick={() => onOpen(folder.path)}>
      {showSeriesWatched && <span className="badge badge-watched">✓ Completa</span>}
      {processingLabel && (
        <span className={`badge badge-processing badge-${folder.processingState}`}>{processingLabel}</span>
      )}
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
      {showSeriesProgress && (
        <div className="progress-bar" title={`${seriesProgress.watched} de ${seriesProgress.total} episodios vistos`}>
          <div style={{ width: `${Math.round(seriesProgress.ratio * 100)}%` }} />
        </div>
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

  const profileId = getActiveProfileId();

  useEffect(() => {
    if (searching) return undefined;
    setError(null);
    let cancelled = false;
    let timer;

    // Mientras haya algo convirtiéndose o en cola, se vuelve a pedir cada
    // pocos segundos para que el porcentaje avance solo en la lista; en
    // cuanto no quede nada procesándose, deja de sondear.
    const load = () => {
      const params = new URLSearchParams({ dir });
      if (profileId) params.set('profileId', profileId);
      fetch(`/api/videos/browse?${params.toString()}`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          setFolders(data.folders);
          setVideos(data.videos);
          const stillProcessing =
            data.folders.some((f) => f.processingState) || data.videos.some((v) => v.processingState);
          if (stillProcessing) timer = setTimeout(load, 5000);
        })
        .catch(() => {
          if (!cancelled) setError('No se pudo cargar el catálogo.');
        });
    };

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dir, searching, profileId]);

  useEffect(() => {
    // Se usa tanto para la búsqueda global como para "Continuar viendo".
    fetch('/api/videos')
      .then((res) => res.json())
      .then(setAllVideos)
      .catch(() => {
        if (searching) setError('No se pudo cargar el catálogo.');
      });
  }, []);

  const [progressMap, setProgressMap] = useState({});

  useEffect(() => {
    if (!profileId) return;
    fetch(`/api/profiles/${profileId}/progress`)
      .then((res) => res.json())
      .then(setProgressMap)
      .catch(() => {});
  }, [profileId]);

  const filtered = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return allVideos.filter((v) => v.title.toLowerCase().includes(q));
  }, [allVideos, term]);

  const continueWatching = useMemo(() => {
    if (searching || dir || allVideos.length === 0) return [];
    const byId = new Map(allVideos.map((v) => [v.id, v]));
    return continueWatchingIds(progressMap)
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, 12);
  }, [allVideos, searching, dir, progressMap]);

  // Quita un vídeo de "Continuar viendo" sin tocar su progreso guardado: si
  // se retoma más adelante (el progreso se actualiza después de este
  // momento), vuelve a aparecer solo.
  const handleRemoveFromContinueWatching = (id) => {
    if (!profileId) return;
    setProgressMap((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), dismissedAt: Date.now() },
    }));
    fetch(`/api/profiles/${profileId}/progress/${id}/dismiss`, { method: 'POST' }).catch(() => {});
  };

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

  // En la raíz, las carpetas (series/anime) se separan en dos filas según
  // el tipo detectado por las fuentes de metadatos; dentro de una carpeta
  // concreta (episodios de una sola obra) no aplica la distinción.
  const animeFolders = !dir ? visibleFolders.filter((f) => f.type === 'anime') : [];
  const seriesFolders = !dir ? visibleFolders.filter((f) => f.type !== 'anime') : visibleFolders;

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
        <Link className="switch-profile-link" to="/profiles">
          Cambiar perfil
        </Link>
      </header>
      <main>
        {!searching && <Breadcrumb dir={dir} onNavigate={goToDir} />}
        {!searching && <GenreFilter genres={genres} active={genre} onToggle={toggleGenre} />}

        {searching && (
          <>
            <p className="section-title">Resultados</p>
            <div className="grid">
              {list.map((video) => (
                <VideoCard key={video.id} video={video} progress={progressMap[video.id]} />
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
                    <VideoCard
                      key={video.id}
                      video={video}
                      progress={progressMap[video.id]}
                      onRemove={handleRemoveFromContinueWatching}
                    />
                  ))}
                </div>
              </>
            )}

            {visibleVideos.length > 0 && (
              <>
                <p className="section-title">{dir ? 'Vídeos' : 'Películas'}</p>
                <div className="grid">
                  {visibleVideos.map((video) => (
                    <VideoCard key={video.id} video={video} progress={progressMap[video.id]} />
                  ))}
                </div>
              </>
            )}

            {showFolders && seriesFolders.length > 0 && (
              <>
                <p className="section-title">{dir ? 'Carpetas' : 'Series'}</p>
                <div className="grid folder-grid">
                  {seriesFolders.map((folder) => (
                    <FolderCard key={folder.path} folder={folder} onOpen={goToDir} />
                  ))}
                </div>
              </>
            )}

            {showFolders && animeFolders.length > 0 && (
              <>
                <p className="section-title">Animes</p>
                <div className="grid folder-grid">
                  {animeFolders.map((folder) => (
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
