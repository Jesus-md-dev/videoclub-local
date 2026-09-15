import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PosterPicker from './PosterPicker';

// Ficha rápida ("más info" estilo Netflix): un vistazo sin salir del
// catálogo, en vez de tener que navegar y volver atrás solo para ver el
// género o cuántos episodios lleva vistos una serie.
export default function QuickInfoModal({ target, onClose, onOpenFolder, onMetadataChanged }) {
  const [pickingPoster, setPickingPoster] = useState(false);

  // Como cualquier modal: Escape también cierra, no solo el botón ✕ o
  // hacer clic fuera.
  useEffect(() => {
    if (!target) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [target, onClose]);

  if (!target) return null;
  const { type, data, progress } = target;
  const isFolder = type === 'folder';
  const title = isFolder ? data.cleanName || data.name : data.seriesKey ? data.title : data.cleanName || data.title;
  const posterSrc = isFolder
    ? data.poster || (data.thumbnailId ? `/api/thumbnail/${data.thumbnailId}` : '/placeholder.svg')
    : data.poster || `/api/thumbnail/${data.id}`;
  const genres = data.genres || [];
  const metadataKey = data.metadataKey || (isFolder ? data.name : null);

  return (
    <div className="quickinfo-backdrop" onClick={onClose}>
      <div className="quickinfo-card" onClick={(e) => e.stopPropagation()}>
        <button className="quickinfo-close" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>
        <img
          className="quickinfo-poster"
          src={posterSrc}
          alt={title}
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = '/placeholder.svg';
          }}
        />
        <div className="quickinfo-body">
          <h2>{title}</h2>
          {genres.length > 0 && (
            <div className="quickinfo-genres">
              {genres.map((g) => (
                <span key={g} className="chip">
                  {g}
                </span>
              ))}
            </div>
          )}
          {isFolder && data.seriesProgress && data.seriesProgress.watched > 0 && (
            <p className="hint">
              {data.seriesProgress.watched} de {data.seriesProgress.total} episodios vistos
            </p>
          )}
          {!isFolder && progress && progress.ratio > 0.02 && progress.ratio < 0.95 && (
            <p className="hint">Por donde lo dejaste: {Math.round(progress.ratio * 100)}%</p>
          )}
          <div className="quickinfo-actions">
            {isFolder ? (
              <button
                className="quickinfo-play"
                onClick={() => {
                  onOpenFolder(data.path);
                  onClose();
                }}
              >
                ▶ Ver episodios
              </button>
            ) : (
              <Link className="quickinfo-play" to={`/watch/${data.id}`}>
                ▶ Reproducir
              </Link>
            )}
            {metadataKey && (
              <button className="secondary" onClick={() => setPickingPoster(true)}>
                Cambiar carátula
              </button>
            )}
          </div>
        </div>
      </div>
      {pickingPoster && (
        <PosterPicker
          metadataKey={metadataKey}
          onClose={() => setPickingPoster(false)}
          onApplied={() => onMetadataChanged?.()}
        />
      )}
    </div>
  );
}
