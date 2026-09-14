import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from '../components/HiddenMenu';

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
        <div className="header-actions">
          <Link className="back-link" to="/">
            &larr; Volver al catálogo
          </Link>
          <HiddenMenu />
        </div>
      </header>
      <div className="config-wrap queue-wrap">
        <p className="section-title">Preparación de HLS</p>

        {error && <p className="config-message error">{error}</p>}

        {data && (
          <>
            <div className="queue-summary">
              <span>
                Listos: <strong>{data.summary.ready}</strong>
              </span>
              <span>
                Procesando: <strong>{data.summary.processing}</strong>
              </span>
              <span>
                Fallidos: <strong>{data.summary.failed}</strong>
              </span>
              <span>
                Pendientes: <strong>{data.summary.pending}</strong>
              </span>
              <span>
                Total: <strong>{data.summary.total}</strong>
              </span>
            </div>

            <p className="hint">
              Hasta {data.maxConcurrentFfmpeg} procesos de ffmpeg a la vez en toda la app
              (carátulas, subtítulos y esto comparten el mismo tope); sin forzar nada, se
              procesan primero los archivos más ligeros. Un vídeo abierto para verlo ahora
              mismo siempre adelanta a este precalentamiento de fondo.
            </p>

            {data.processing.length > 0 ? (
              <>
                <p className="section-title">Procesando ({data.processing.length})</p>
                <div className="queue-list">
                  {data.processing.map((item) => (
                    <div className="queue-row queue-row-active" key={item.id}>
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">
                        {formatSize(item.size)}
                        {item.percent != null ? ` · ${item.percent}%` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="hint">Nada procesándose ahora mismo.</p>
            )}

            {data.failed.length > 0 && (
              <>
                <p className="section-title">Fallidos ({data.failed.length})</p>
                <div className="queue-list">
                  {data.failed.map((item) => (
                    <div className="queue-row queue-row-failed" key={item.id}>
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
