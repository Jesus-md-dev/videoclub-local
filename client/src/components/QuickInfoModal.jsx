import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PosterPicker from './PosterPicker';
import useFocusTrap from '../hooks/useFocusTrap';
import useBackButtonClose from '../hooks/useBackButtonClose';
import { episodeTitle } from '../utils/format';

// Ficha rápida ("más info" estilo Netflix): un vistazo sin salir del
// catálogo, en vez de tener que navegar y volver atrás solo para ver el
// género o cuántos episodios lleva vistos una serie.
export default function QuickInfoModal({ target, onClose, onOpenFolder, onMetadataChanged }) {
  const [pickingPoster, setPickingPoster] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState(null);
  const cardRef = useRef(null);

  // Mueve el foco dentro del modal al abrir, atrapa Tab mientras está
  // abierto, y lo devuelve a la carátula que lo abrió al cerrar.
  useFocusTrap(cardRef, Boolean(target) && !pickingPoster);

  // Atrás del mando (Fire TV) cierra la ficha en vez de salir del catálogo.
  useBackButtonClose(Boolean(target), onClose);

  // Como cualquier modal: Escape también cierra, no solo el botón ✕ o
  // hacer clic fuera. Mientras PosterPicker está abierto encima, es ÉSE el
  // que debe cerrarse primero con Escape, no los dos a la vez.
  useEffect(() => {
    if (!target || pickingPoster) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [target, pickingPoster, onClose]);

  // Sin esto, pasar de un episodio a otro sin cerrar el modal de por medio
  // (p.ej. desde la lista de episodios) podía dejar el "¿Seguro?" a medias
  // del episodio anterior activo sobre el nuevo.
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleting(false);
    setDeleteError(null);
    setEditingName(false);
    setNameError(null);
  }, [target?.data?.id, target?.data?.path]);

  // Nombre puesto a mano (p.ej. "Bleach (VOSE)" para distinguir una segunda
  // versión de la misma serie); vacío vuelve al nombre de TMDB.
  async function saveName(name) {
    setSavingName(true);
    setNameError(null);
    try {
      const res = await fetch('/api/metadata/custom-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: metadataKey, name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'No se pudo cambiar el nombre.');
      onMetadataChanged?.();
      onClose();
    } catch (err) {
      setNameError(err.message);
    } finally {
      setSavingName(false);
    }
  }

  // Marca a mano de anime (#151): para lo que TMDB da como película normal
  // (las de Berserk); así se oculta con el resto a los perfiles sin
  // "Mostrar anime".
  async function setAnimeMark(anime) {
    setSavingName(true);
    setNameError(null);
    try {
      const res = await fetch('/api/metadata/anime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: metadataKey, anime }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'No se pudo cambiar la marca de anime.');
      onMetadataChanged?.();
      onClose();
    } catch (err) {
      setNameError(err.message);
    } finally {
      setSavingName(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/catalog/delete-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.data.id, confirm: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'No se pudo borrar.');
      onMetadataChanged?.();
      onClose();
    } catch (err) {
      setDeleteError(err.message);
      setDeleting(false);
    }
  }

  const metadataKey = target ? target.data.metadataKey || (target.type === 'folder' ? target.data.name : null) : null;

  if (!target) return null;
  const { type, data, progress } = target;
  const isFolder = type === 'folder';
  const title = isFolder ? data.cleanName || data.name : data.seriesKey ? episodeTitle(data) : data.cleanName || data.title;
  const posterSrc = isFolder
    ? data.poster || (data.thumbnailId ? `/api/thumbnail/${data.thumbnailId}` : '/placeholder.svg')
    : data.poster || `/api/thumbnail/${data.id}`;
  const genres = data.genres || [];

  return (
    <div className="quickinfo-backdrop" onClick={onClose}>
      <div className="quickinfo-card" ref={cardRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
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
          {editingName ? (
            <form
              className="quickinfo-rename"
              onSubmit={(e) => {
                e.preventDefault();
                saveName(nameDraft);
              }}
            >
              <input
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                aria-label="Nombre"
                placeholder="Vacío = nombre de TMDB"
                autoFocus
                disabled={savingName}
              />
              <button type="submit" disabled={savingName}>
                {savingName ? 'Guardando…' : 'Guardar'}
              </button>
              <button type="button" className="secondary" onClick={() => setEditingName(false)} disabled={savingName}>
                Cancelar
              </button>
            </form>
          ) : (
            <h2>{title}</h2>
          )}
          {nameError && <p className="config-message error">{nameError}</p>}
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
            {metadataKey && (isFolder || !data.seriesKey) && (
              <button
                className="secondary"
                onClick={() => {
                  setNameDraft(data.customName || data.cleanName || metadataKey);
                  setEditingName(true);
                }}
              >
                Cambiar nombre
              </button>
            )}
            {metadataKey && (isFolder || !data.seriesKey) && data.customName && (
              <button className="secondary" onClick={() => saveName('')} disabled={savingName}>
                Quitar nombre propio
              </button>
            )}
            {metadataKey && (isFolder || !data.seriesKey) && (data.animeMarked || data.type !== 'anime') && (
              <button className="secondary" onClick={() => setAnimeMark(!data.animeMarked)} disabled={savingName}>
                {data.animeMarked ? 'Quitar marca de anime' : 'Marcar como anime'}
              </button>
            )}
            {!isFolder &&
              (confirmingDelete ? (
                <>
                  <button className="danger" onClick={handleDelete} disabled={deleting}>
                    {deleting ? 'Borrando…' : '¿Seguro? Sí, borrar'}
                  </button>
                  <button className="secondary" onClick={() => setConfirmingDelete(false)} disabled={deleting}>
                    Cancelar
                  </button>
                </>
              ) : (
                <button className="danger" onClick={() => setConfirmingDelete(true)}>
                  Borrar
                </button>
              ))}
          </div>
          {deleteError && <p className="config-message error">{deleteError}</p>}
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
