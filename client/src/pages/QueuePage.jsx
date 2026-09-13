import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

export default function QueuePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const load = () => {
      fetch('/api/queue')
        .then((res) => res.json())
        .then((json) => {
          if (cancelled) return;
          setData(json);
          timer = setTimeout(load, 3000);
        })
        .catch(() => {
          if (!cancelled) {
            setError('No se pudo cargar el estado de la cola.');
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
        <Link className="back-link" to="/">
          &larr; Volver al catálogo
        </Link>
      </header>
      <div className="config-wrap queue-wrap">
        <p className="section-title">Cola de conversión</p>

        {error && <p className="config-message error">{error}</p>}

        {data && (
          <>
            <div className="queue-summary">
              <span>
                Listos: <strong>{data.summary.ready + data.summary.compatible}</strong>
              </span>
              <span>
                Procesando: <strong>{data.summary.active}</strong>
              </span>
              <span>
                En cola: <strong>{data.summary.queued}</strong>
              </span>
              <span>
                Fallidos: <strong>{data.summary.failed}</strong>
              </span>
              <span>
                Sin comprobar: <strong>{data.summary.unknown}</strong>
              </span>
              <span>
                Total: <strong>{data.summary.total}</strong>
              </span>
            </div>

            <p className="hint">
              Sin forzar prioridad manualmente sobre ningún vídeo, se procesan primero los
              archivos más ligeros.
            </p>

            {data.active ? (
              <>
                <p className="section-title">Convirtiéndose ahora</p>
                <div className="queue-list">
                  <div className="queue-row queue-row-active">
                    <span className="queue-title">{data.active.title}</span>
                    <span className="queue-meta">
                      {formatSize(data.active.size)} · {data.active.percent ?? 0}%
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <p className="hint">Nada convirtiéndose ahora mismo.</p>
            )}

            <p className="section-title">
              En cola ({data.queued.length}, por orden de turno)
            </p>
            {data.queued.length === 0 ? (
              <p className="hint">La cola está vacía.</p>
            ) : (
              <div className="queue-list">
                {data.queued.map((item) => (
                  <div className="queue-row" key={item.key}>
                    <span className="queue-position">{item.position}</span>
                    <span className="queue-title">{item.title}</span>
                    <span className="queue-meta">{formatSize(item.size)}</span>
                  </div>
                ))}
              </div>
            )}

            {data.failed.length > 0 && (
              <>
                <p className="section-title">Fallidos ({data.failed.length})</p>
                <div className="queue-list">
                  {data.failed.map((item) => (
                    <div className="queue-row queue-row-failed" key={item.key}>
                      <span className="queue-title">{item.title}</span>
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
