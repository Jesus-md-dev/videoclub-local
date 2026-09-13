import { useEffect, useState } from 'react';

export default function FolderBrowser({ startPath, onSelect, onClose }) {
  const [currentPath, setCurrentPath] = useState(startPath || null);
  const [parent, setParent] = useState(null);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const url = currentPath ? `/api/browse?path=${encodeURIComponent(currentPath)}` : '/api/browse';
    fetch(url)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al listar la carpeta');
        return data;
      })
      .then((data) => {
        setParent(data.parent);
        setEntries(data.entries);
        if (data.path) setCurrentPath(data.path);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [currentPath]);

  return (
    <div className="browser-overlay" onClick={onClose}>
      <div className="browser-modal" onClick={(e) => e.stopPropagation()}>
        <p className="section-title">Examinar carpetas</p>
        <p className="browser-current">{currentPath || 'Unidades disponibles'}</p>

        <div className="browser-list">
          {loading && <p className="hint">Cargando...</p>}
          {error && (
            <div>
              <p className="config-message error">{error}</p>
              <button className="browser-item" onClick={() => setCurrentPath(null)}>
                Ir a las unidades
              </button>
            </div>
          )}
          {!loading && !error && (
            <>
              {parent && (
                <button className="browser-item" onClick={() => setCurrentPath(parent)}>
                  .. Subir un nivel
                </button>
              )}
              {entries.length === 0 && !parent && (
                <p className="hint">No hay subcarpetas aquí.</p>
              )}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  className="browser-item"
                  onClick={() => setCurrentPath(entry.path)}
                >
                  {entry.name}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="browser-actions">
          <button className="secondary" onClick={onClose}>
            Cancelar
          </button>
          <button disabled={!currentPath} onClick={() => onSelect(currentPath)}>
            Seleccionar esta carpeta
          </button>
        </div>
      </div>
    </div>
  );
}
