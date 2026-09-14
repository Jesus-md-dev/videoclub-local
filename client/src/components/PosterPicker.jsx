import { useEffect, useState } from 'react';

// Deja elegir a mano entre hasta 3 fichas candidatas de TMDB (nombre, año,
// carátula) para una clave del catálogo, para cuando la búsqueda
// automática se ha equivocado y no hay heurística que lo arregle sola.
export default function PosterPicker({ metadataKey, onClose, onApplied }) {
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(null);

  useEffect(() => {
    setError(null);
    setCandidates(null);
    fetch(`/api/metadata/candidates?key=${encodeURIComponent(metadataKey)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setCandidates(data.candidates || []);
      })
      .catch((err) => setError(err.message));
  }, [metadataKey]);

  const apply = async (candidate) => {
    setApplying(`${candidate.tmdbType}:${candidate.tmdbId}`);
    try {
      const res = await fetch('/api/metadata/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: metadataKey, tmdbType: candidate.tmdbType, tmdbId: candidate.tmdbId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      onApplied();
      onClose();
    } catch (err) {
      setError(err.message);
      setApplying(null);
    }
  };

  return (
    <div className="quickinfo-backdrop" onClick={onClose}>
      <div className="poster-picker" onClick={(e) => e.stopPropagation()}>
        <button className="quickinfo-close" onClick={onClose} aria-label="Cerrar">
          ✕
        </button>
        <p className="section-title">Elegir carátula</p>
        {error && <p className="config-message error">{error}</p>}
        {!error && !candidates && <p className="hint">Buscando en TMDB...</p>}
        {candidates && candidates.length === 0 && (
          <p className="hint">TMDB no ha encontrado nada para "{metadataKey}".</p>
        )}
        {candidates && candidates.length > 0 && (
          <div className="poster-picker-grid">
            {candidates.map((c) => {
              const busy = applying === `${c.tmdbType}:${c.tmdbId}`;
              return (
                <button
                  key={`${c.tmdbType}:${c.tmdbId}`}
                  className="poster-picker-option"
                  disabled={applying != null}
                  onClick={() => apply(c)}
                >
                  <img src={c.poster} alt={c.name} loading="lazy" />
                  <span className="poster-picker-name">
                    {c.name} {c.year ? `(${c.year})` : ''}
                  </span>
                  {busy && <span className="poster-picker-busy">Aplicando…</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
