import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import HiddenMenu from '../components/HiddenMenu';

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds}s`;
}

// Misma fórmula que WatchPage.jsx (pantalla de "preparando..." al abrir un
// vídeo): con el % ya avanzado y el tiempo que ha llevado llegar hasta ahí,
// se estima linealmente cuánto falta. Un vídeo compatible con copia directa
// (sin recodificar, la mayoría) se remuxea tan rápido que el % casi nunca
// llega a rellenarse a tiempo (ver hls.js) - para esos se muestra al menos
// el tiempo ya transcurrido, más honesto que no mostrar nada.
function formatRemaining(item) {
  if (!item.elapsedMs) return null;
  if (!item.percent) return `${formatDuration(item.elapsedMs)} transcurridos`;
  const totalEstimate = item.elapsedMs / (item.percent / 100);
  const remainingSec = Math.max(0, Math.round((totalEstimate - item.elapsedMs) / 1000));
  if (remainingSec < 60) return `~${remainingSec}s restantes`;
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  return `~${minutes}m ${seconds}s restantes`;
}

export default function QueuePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(new Set());
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState(null);

  const handleRetry = (id) => {
    setRetrying((prev) => new Set(prev).add(id));
    fetch(`/api/hls/${id}/retry`, { method: 'POST' }).catch(() => {});
  };

  // Para cada fallido: si el archivo ya no existe (se borró/movió a mano
  // tras el fallo), se quita solo de la lista; si sigue ahí, se reintenta
  // de verdad - un solo botón en vez de revisarlos uno a uno.
  const handleResolveFailed = () => {
    setResolving(true);
    setResolveResult(null);
    fetch('/api/queue/resolve-failed', { method: 'POST' })
      .then((res) => res.json())
      .then((result) => setResolveResult(result))
      .catch(() => setResolveResult(null))
      .finally(() => setResolving(false));
  };

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
                        {formatRemaining(item) ? ` · ${formatRemaining(item)}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="hint">Nada procesándose ahora mismo.</p>
            )}

            {data.pending.length > 0 && (
              <>
                <p className="section-title">
                  Pendientes ({data.summary.pending}
                  {data.summary.pending > data.pending.length ? `, mostrando los ${data.pending.length} próximos` : ''})
                </p>
                <p className="hint">En el orden en que les tocará turno (los más ligeros primero).</p>
                <div className="queue-list">
                  {data.pending.map((item) => (
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
                <div className="queue-failed-header">
                  <p className="section-title">Fallidos ({data.failed.length})</p>
                  <button className="secondary" disabled={resolving} onClick={handleResolveFailed}>
                    {resolving ? 'Revisando…' : 'Resolver fallidos'}
                  </button>
                </div>
                {resolveResult && (
                  <p className="queue-resolve-hint">
                    {resolveResult.retried > 0 && `${resolveResult.retried} reintentado(s)`}
                    {resolveResult.retried > 0 && resolveResult.missing > 0 && ', '}
                    {resolveResult.missing > 0 && `${resolveResult.missing} quitado(s) de la lista (el archivo ya no existe)`}
                    {resolveResult.retried === 0 && resolveResult.missing === 0 && 'Nada que resolver.'}
                  </p>
                )}
                <div className="queue-list">
                  {data.failed.map((item) => (
                    <div className="queue-row queue-row-failed queue-row-failed-detail" key={item.id}>
                      <div className="queue-failed-main">
                        <span className="queue-title">{item.title}</span>
                        <button
                          className="queue-retry-btn"
                          disabled={retrying.has(item.id)}
                          onClick={() => handleRetry(item.id)}
                        >
                          {retrying.has(item.id) ? 'Reintentando…' : 'Reintentar'}
                        </button>
                      </div>
                      {item.error && <p className="queue-error-detail">{item.error}</p>}
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
