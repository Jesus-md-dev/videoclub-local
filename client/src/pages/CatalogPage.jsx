import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Hls from 'hls.js';
import { getActiveProfileId, withProfile } from '../profile';
import { getCatalogLayout, setCatalogLayout } from '../catalogLayout';
import { track } from '../analytics';
import { episodeTitle } from '../utils/format';
import HiddenMenu from '../components/HiddenMenu';
import ProfileButton from '../components/ProfileButton';
import Row from '../components/Row';
import QuickInfoModal from '../components/QuickInfoModal';
import ServerUnreachable from '../components/ServerUnreachable';
import ShortcutsHelp from '../components/ShortcutsHelp';
import { isTvMode, useArrowNavigation } from '../tvMode';

const CATALOG_SHORTCUTS = [
  { keys: '↑↓←→', label: 'Moverse por carátulas, filtros y cabecera' },
  { keys: '/', label: 'Ir al buscador' },
  { keys: 'Enter', label: 'Abrir la carátula enfocada' },
  { keys: 'Esc', label: 'Cerrar la ficha rápida' },
];

function processingBadgeLabel(state, percent) {
  if (state === 'active') return `Procesando… ${typeof percent === 'number' ? `${percent}%` : ''}`.trim();
  if (state === 'queued') return 'Pendiente de conversión';
  return null;
}

// Punto de la carátula de serie: verde si todos los episodios ya están
// procesados, rojo si ninguno lo está, naranja si es una mezcla real (solo
// algunos ya procesados) - no indica "hay actividad ahora mismo", solo el
// estado real de completitud.
function hlsDotClassAndTitle(completion) {
  if (completion === 'ready') return { cls: 'hls-dot-ready', title: 'Todos los episodios procesados' };
  if (completion === 'partial') return { cls: 'hls-dot-partial', title: 'Procesados a medias' };
  return { cls: 'hls-dot-pending', title: 'Ningún episodio procesado' };
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

// Cuánto hay que mantener el ratón encima antes de arrancar la vista
// previa (como Netflix: no salta a la primera pasada rápida del ratón).
const HOVER_PREVIEW_DELAY_MS = 500;

// Vista previa en movimiento al pasar el ratón (estilo Netflix): solo si el
// HLS de ese vídeo ya está generado (si no, tocaría esperar a que termine
// solo por pasar el ratón por encima, mala idea). Compartido entre
// VideoCard (su propio vídeo) y FolderCard (el primer episodio de la
// serie, para tener algo que previsualizar aunque la carpeta en sí no sea
// un vídeo).
function useHoverPreview(videoId, ready) {
  const [previewing, setPreviewing] = useState(false);
  const hoverTimer = useRef(null);
  const videoElRef = useRef(null);
  const hlsRef = useRef(null);

  const startHover = () => {
    if (!ready) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPreviewing(true), HOVER_PREVIEW_DELAY_MS);
  };
  const endHover = () => {
    clearTimeout(hoverTimer.current);
    setPreviewing(false);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!previewing) return undefined;
    const el = videoElRef.current;
    if (!el) return undefined;
    const masterUrl = `/api/hls/${videoId}/master.m3u8`;

    if (Hls.isSupported()) {
      const instance = new Hls();
      hlsRef.current = instance;
      // Sin manejo de error: es solo una vista previa silenciosa, si falla
      // simplemente se queda en la carátula fija, no hace falta avisar.
      instance.on(Hls.Events.ERROR, () => {});
      instance.loadSource(masterUrl);
      instance.attachMedia(el);
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = masterUrl;
    }
    el.play?.().catch(() => {});

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [previewing, videoId]);

  return { previewing, videoElRef, startHover, endHover };
}

// En modo tele no hay ratón: la vista previa arranca al llegar con el
// mando a la carátula y se para al salir.
function focusPreview(startHover, endHover) {
  return isTvMode() ? { onFocus: startHover, onBlur: endHover } : {};
}

function VideoCard({ video, progress, onRemove, onQuickInfo }) {
  const showProgress = progress && progress.ratio < 0.95;
  // Terminado del todo (no a medias, eso ya lo cubre "Continuar"): se
  // excluyen del todo los mismos que "showProgress", así que nunca
  // coinciden en la misma carátula.
  const showWatched = progress && progress.ratio >= 0.95;
  const posterSrc = video.poster || `/api/thumbnail/${video.id}`;
  // El nombre limpio es el de la serie (mismo para todos sus episodios), así
  // que en un episodio taparía el número; solo se usa en películas sueltas.
  const displayTitle = video.seriesKey ? episodeTitle(video) : video.cleanName || video.title;
  const processingLabel = processingBadgeLabel(video.processingState, video.processingPercent);

  const { previewing, videoElRef, startHover, endHover } = useHoverPreview(video.id, video.hlsReady);

  return (
    <Link className="card" to={`/watch/${video.id}`} onMouseEnter={startHover} onMouseLeave={endHover} {...focusPreview(startHover, endHover)}>
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
      <button
        className="card-info-btn"
        title="Más información"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onQuickInfo();
        }}
      >
        ⓘ
      </button>
      {previewing ? (
        <video ref={videoElRef} className="poster poster-preview" muted loop playsInline autoPlay />
      ) : (
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
      )}
      <span
        className={`hls-dot ${video.hlsReady ? 'hls-dot-ready' : 'hls-dot-pending'}`}
        title={video.hlsReady ? 'Ya procesado' : 'Pendiente de procesar'}
      />
      {showProgress && (
        <div className="card-resume-overlay">
          <span className="card-resume-play">▶</span>
        </div>
      )}
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

function FolderCard({ folder, onOpen, onQuickInfo }) {
  const posterSrc = folder.poster || (folder.thumbnailId ? `/api/thumbnail/${folder.thumbnailId}` : null);
  const displayName = folder.cleanName || folder.name;
  const processingLabel = processingBadgeLabel(folder.processingState, folder.processingPercent);
  // Fracción de episodios ya vistos de la serie completa (no del episodio
  // suelto, eso ya lo cubre "Continuar viendo"); null si no hay perfil
  // activo, o si aún no se ha empezado ninguno.
  const seriesProgress = folder.seriesProgress;
  const showSeriesProgress = seriesProgress && seriesProgress.watched > 0;
  const showSeriesWatched = seriesProgress && seriesProgress.ratio >= 1;

  // Una carpeta no es un vídeo en sí, pero folder.thumbnailId ya es el
  // primer episodio (ver catalog.js buildLibrary) - se usa ese HLS para la
  // vista previa, igual que en VideoCard con su propio vídeo.
  const { previewing, videoElRef, startHover, endHover } = useHoverPreview(folder.thumbnailId, folder.firstVideoReady);

  return (
    <button
      className="card folder-card"
      onClick={() => onOpen(folder.path)}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      {...focusPreview(startHover, endHover)}
    >
      {showSeriesWatched && <span className="badge badge-watched">✓ Completa</span>}
      {processingLabel && (
        <span className={`badge badge-processing badge-${folder.processingState}`}>{processingLabel}</span>
      )}
      <span
        className="card-info-btn"
        role="button"
        tabIndex={0}
        title="Más información"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onQuickInfo();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onQuickInfo();
          }
        }}
      >
        ⓘ
      </span>
      {posterSrc ? (
        previewing ? (
          <video ref={videoElRef} className="poster poster-preview" muted loop playsInline autoPlay />
        ) : (
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
        )
      ) : (
        <div className="folder-icon">📁</div>
      )}
      {folder.hlsCompletion && (() => {
        const { cls, title } = hlsDotClassAndTitle(folder.hlsCompletion);
        return <span className={`hls-dot ${cls}`} title={title} />;
      })()}
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

// Dentro de una serie todos los episodios comparten género/tipo (son la
// misma obra), así que el filtro de género no aporta nada ahí - solo tiene
// sentido en la raíz del catálogo, donde sí se mezclan obras distintas. Lo
// único que puede variar dentro de una serie es la temporada (o, en series
// con ediciones de fans reordenadas por arco argumental en vez de por
// temporada numerada - ver extractGroup -, el arco).
function EpisodeGroupFilter({ groups, active, onToggle }) {
  if (groups.length < 2) return null;
  return (
    <div className="genre-filter">
      {groups.map((group) => (
        <button
          key={group.key}
          className={`chip ${active === group.key ? 'chip-active' : ''}`}
          onClick={() => onToggle(group.key)}
        >
          {group.label}
        </button>
      ))}
    </div>
  );
}

// El catálogo no modela "temporada"/"arco" como campo propio (ver
// catalog.js: groupKeyFor trata las subcarpetas de temporada como
// genéricas, agrupando todo bajo la obra) - se extrae del propio título del
// episodio. Dos patrones reales en la biblioteca:
// - "SxxEyy" (la inmensa mayoría, p.ej. "S01E02").
// - Ediciones de fans tipo "One Pace" (One Piece reordenado por arco
//   argumental en vez de por temporada de emisión), en dos formatos según
//   si ya pasaron por el normalizador de nombres o no:
//     "One Piece [One Pace] - Dressrosa - E01" (normalizado)
//     "[One Pace][700-800] Dressrosa 01 [720p][Es Sub][XXXX]" (en bruto)
function extractGroup(title) {
  const seasonMatch = title.match(/S(\d{1,2})E\d{1,3}/i);
  if (seasonMatch) {
    const n = Number(seasonMatch[1]);
    return { key: `s${n}`, label: `Temporada ${n}`, order: n };
  }
  const arcMatch =
    title.match(/\[One Pace\]\s*-\s*(.+?)\s*-\s*E\d+/i) || title.match(/\[One Pace\]\[\d+-\d+\]\s*(.+?)\s+\d+\s*\[/i);
  if (arcMatch) {
    const name = arcMatch[1].trim();
    return { key: `arc:${name}`, label: name, order: null };
  }
  return null;
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
  const groupKey = searchParams.get('group') || null;

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [dir]);

  const [layout, setLayout] = useState(getCatalogLayout);
  const toggleLayout = () => {
    const next = layout === 'grid' ? 'carousel' : 'grid';
    setCatalogLayout(next);
    setLayout(next);
  };
  const [folders, setFolders] = useState([]);
  const [videos, setVideos] = useState([]);
  const [allVideos, setAllVideos] = useState([]);
  const [genres, setGenres] = useState([]);
  const [error, setError] = useState(null);
  const [quickInfoTarget, setQuickInfoTarget] = useState(null);
  // Se incrementa tras cambiar una carátula a mano (PosterPicker) para
  // forzar una recarga inmediata, sin esperar al sondeo periódico.
  const [catalogVersion, setCatalogVersion] = useState(0);

  // Flechas de mando/teclado por toda la página (carátulas, filtros,
  // cabecera); con una ventana abierta, solo dentro de ella (tvMode.js).
  useArrowNavigation();

  // Atajo "/" para saltar directo al buscador desde cualquier sitio de la
  // página (patrón habitual en sitios con mucho contenido) - antes solo se
  // llegaba tabulando desde el principio. Se ignora si ya se está
  // escribiendo en un campo de texto (para no robarle la propia "/").
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== '/') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      document.getElementById('search')?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const searching = term.trim().length > 0;

  useEffect(() => {
    fetch(withProfile('/api/genres'))
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
    // cuanto no quede nada procesándose, deja de sondear. También se sigue
    // sondeando mientras haya una actualización masiva de metadatos en
    // marcha (ver ConfigPage "Forzar actualización TMDB"), para que los
    // títulos y carátulas de las tarjetas se vayan poniendo al día solos,
    // sin tener que recargar la página a mano.
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
          if (stillProcessing) {
            timer = setTimeout(load, 5000);
            return;
          }
          fetch('/api/metadata/force-tmdb-status')
            .then((res) => res.json())
            .then((status) => {
              if (!cancelled && status.running) timer = setTimeout(load, 4000);
            })
            .catch(() => {});
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
  }, [dir, searching, profileId, catalogVersion]);

  useEffect(() => {
    // Se usa tanto para la búsqueda global como para "Continuar viendo".
    // Igual que el catálogo por carpetas: se sigue sondeando mientras haya
    // una actualización masiva de metadatos en marcha, para que los
    // títulos también se pongan al día solos aquí.
    let cancelled = false;
    let timer;
    const load = () => {
      fetch(withProfile('/api/videos'))
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          setAllVideos(data);
          return fetch('/api/metadata/force-tmdb-status').then((res) => res.json());
        })
        .then((status) => {
          if (!cancelled && status?.running) timer = setTimeout(load, 4000);
        })
        .catch(() => {
          if (!cancelled && searching) setError('No se pudo cargar el catálogo.');
        });
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searching, catalogVersion]);

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
    if (g !== genre) {
      params.genre = g;
      track('genre_filter', { genre: g });
    }
    setSearchParams(params);
  };
  const toggleGroup = (key) => {
    const params = { dir };
    if (key !== groupKey) {
      params.group = key;
      track('episode_group_filter', { group: key });
    }
    setSearchParams(params);
  };

  // Se registra la búsqueda solo cuando el usuario deja de teclear un
  // momento (no en cada pulsación), para saber qué se busca sin llenar el
  // registro de eventos a medio escribir.
  useEffect(() => {
    if (!term.trim()) return undefined;
    const timer = setTimeout(() => track('search', { term: term.trim() }), 800);
    return () => clearTimeout(timer);
  }, [term]);

  const visibleFolders = genre ? folders.filter((f) => f.genres?.includes(genre)) : folders;
  const genreFilteredVideos = genre ? videos.filter((v) => v.genres?.includes(genre)) : videos;

  // Solo tiene sentido dentro de una serie (fuera de ahí "genre" ya filtra
  // obras completas, no episodios sueltos de una misma obra).
  const groups = useMemo(() => {
    if (!dir) return [];
    const map = new Map();
    for (const v of videos) {
      const g = extractGroup(v.title);
      if (g && !map.has(g.key)) map.set(g.key, g);
    }
    const list = [...map.values()];
    // Temporadas numeradas: orden numérico. Arcos con nombre (sin número
    // que ordenar): se dejan en el orden en que aparecen los episodios
    // (videos ya viene ordenado por nombre de archivo/relativePath, que es
    // el orden real de la historia para estas ediciones de fans).
    if (list.every((g) => g.order != null)) list.sort((a, b) => a.order - b.order);
    return list;
  }, [dir, videos]);

  const visibleVideos =
    dir && groupKey != null
      ? genreFilteredVideos.filter((v) => extractGroup(v.title)?.key === groupKey)
      : genreFilteredVideos;

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
      <a className="skip-link" href="#main">
        Saltar al contenido
      </a>
      <header>
        <Link className="logo" to="/">
          VIDEO<span>CLUB</span>
        </Link>
        <input
          id="search"
          type="search"
          placeholder="Buscar título... (atajo: /)"
          autoComplete="off"
          value={term}
          onChange={(e) => handleSearch(e.target.value)}
        />
        <div className="header-actions">
          <button
            type="button"
            className="layout-toggle"
            aria-pressed={layout === 'grid'}
            onClick={toggleLayout}
            title={layout === 'grid' ? 'Cambiar a carrusel' : 'Cambiar a cuadrícula'}
          >
            {layout === 'grid' ? '☰ Carrusel' : '▦ Cuadrícula'}
          </button>
          <ProfileButton />
          <HiddenMenu />
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {!searching && <Breadcrumb dir={dir} onNavigate={goToDir} />}
        {!searching && !dir && <GenreFilter genres={genres} active={genre} onToggle={toggleGenre} />}
        {!searching && dir && <EpisodeGroupFilter groups={groups} active={groupKey} onToggle={toggleGroup} />}

        {searching && (
          <>
            <p className="section-title">Resultados</p>
            <div className="grid">
              {list.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  progress={progressMap[video.id]}
                  onQuickInfo={() => setQuickInfoTarget({ type: 'video', data: video, progress: progressMap[video.id] })}
                />
              ))}
            </div>
          </>
        )}

        {!searching && (
          <>
            {continueWatching.length > 0 && (
              <Row title="Continuar viendo" layout={layout}>
                {continueWatching.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    progress={progressMap[video.id]}
                    onRemove={handleRemoveFromContinueWatching}
                    onQuickInfo={() => setQuickInfoTarget({ type: 'video', data: video, progress: progressMap[video.id] })}
                  />
                ))}
              </Row>
            )}

            {visibleVideos.length > 0 && (
              <Row title={dir ? 'Vídeos' : 'Películas'} layout={layout}>
                {visibleVideos.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    progress={progressMap[video.id]}
                    onQuickInfo={() => setQuickInfoTarget({ type: 'video', data: video, progress: progressMap[video.id] })}
                  />
                ))}
              </Row>
            )}

            {showFolders && seriesFolders.length > 0 && (
              <Row title={dir ? 'Carpetas' : 'Series'} layout={layout}>
                {seriesFolders.map((folder) => (
                  <FolderCard
                    key={folder.path}
                    folder={folder}
                    onOpen={goToDir}
                    onQuickInfo={() => setQuickInfoTarget({ type: 'folder', data: folder })}
                  />
                ))}
              </Row>
            )}

            {showFolders && animeFolders.length > 0 && (
              <Row title="Animes" layout={layout}>
                {animeFolders.map((folder) => (
                  <FolderCard
                    key={folder.path}
                    folder={folder}
                    onOpen={goToDir}
                    onQuickInfo={() => setQuickInfoTarget({ type: 'folder', data: folder })}
                  />
                ))}
              </Row>
            )}
          </>
        )}

        {error && <ServerUnreachable onRetry={() => setCatalogVersion((v) => v + 1)} />}
        {isEmpty && (
          <p className="empty-state">
            {searching ? 'No hay resultados para tu búsqueda.' : 'Esta carpeta está vacía.'}
          </p>
        )}
      </main>
      <QuickInfoModal
        target={quickInfoTarget}
        onClose={() => setQuickInfoTarget(null)}
        onOpenFolder={goToDir}
        onMetadataChanged={() => setCatalogVersion((v) => v + 1)}
      />
      <ShortcutsHelp shortcuts={CATALOG_SHORTCUTS} />
    </>
  );
}
