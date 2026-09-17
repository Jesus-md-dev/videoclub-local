import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from '../components/HiddenMenu';

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

export default function MoveQueuePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const load = () => {
      fetch('/api/move-queue')
        .then((res) => res.json())
        .then((json) => {
          if (cancelled) return;
          setData(json);
          timer = setTimeout(load, 3000);
        })
        .catch(() => {
          if (!cancelled) {
            setError('No se pudo cargar el estado del traslado.');
            timer = setTimeout(load, 5000);
          }
        });
    };

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <header>
        <Link className="logo" to="/">
          VIDEO<span>CLUB</span>
        </Link>
        <div className="header-actions">
          <Link className="back-link" to="/">
            &larr; Volver al catálogo
          </Link>
          <HiddenMenu />
        </div>
      </header>
      <div className="config-wrap queue-wrap">
        <p className="section-title">Traslado de originales</p>

        {error && <p className="config-message error">{error}</p>}

        {data && !data.configured && (
          <p className="hint">
            No hay ninguna carpeta de respaldo configurada (MOVED_ORIGINALS_PATH): el traslado
            automático está desactivado, los originales se quedan donde están.
          </p>
        )}

        {data && data.configured && (
          <>
            <p className="hint">Destino: {data.destination}</p>

            <div className="queue-summary">
              <span>
                Moviendo: <strong>{data.moving.length}</strong>
              </span>
              <span>
                En cola: <strong>{data.queued.length}</strong>
              </span>
              <span>
                Hechos: <strong>{data.done.length}</strong>
              </span>
              <span>
                Fallidos: <strong>{data.failed.length}</strong>
              </span>
            </div>

            {data.moving.length > 0 ? (
              <>
                <p className="section-title">Moviendo ahora ({data.moving.length})</p>
                <div className="queue-list">
                  {data.moving.map((item) => (
                    <div className="queue-row queue-row-active" key={item.id}>
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">
                        {formatSize(item.size)}
                        {item.percent != null ? ` · ${item.percent.toFixed ? item.percent.toFixed(1) : item.percent}%` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="hint">Nada moviéndose ahora mismo.</p>
            )}

            {data.queued.length > 0 && (
              <>
                <p className="section-title">En cola ({data.queued.length})</p>
                <div className="queue-list">
                  {data.queued.map((item) => (
                    <div className="queue-row" key={item.id}>
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">{formatSize(item.size)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {data.failed.length > 0 && (
              <>
                <p className="section-title">Fallidos ({data.failed.length})</p>
                <p className="hint">
                  El original se ha dejado donde estaba en cada caso; se reintentan solos al
                  reiniciar el servidor.
                </p>
                <div className="queue-list">
                  {data.failed.map((item) => (
                    <div className="queue-row queue-row-failed queue-row-failed-detail" key={item.id}>
                      <div className="queue-failed-main">
                        <span className="queue-title">{item.title}</span>
                      </div>
                      {item.error && <p className="queue-error-detail">{item.error}</p>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {data.done.length > 0 && (
              <>
                <p className="section-title">Hechos ({data.done.length})</p>
                <div className="queue-list">
                  {data.done.slice(-50).map((item) => (
                    <div className="queue-row" key={item.id}>
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">{formatSize(item.size)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
