import { Link } from 'react-router-dom';
import HiddenMenu from '../components/HiddenMenu';
import usePolling from '../hooks/usePolling';

function percentText(item) {
  return item.percent != null ? `${item.percent.toFixed(1)}%` : '';
}

export default function UpscaleQueuePage() {
  const { data, error } = usePolling('/api/upscale-queue', {
    errorMessage: 'No se pudo cargar el estado del reescalado.',
  });

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
        <p className="section-title">Reescalado a 720p (IA)</p>

        {error && <p className="config-message error">{error}</p>}

        {data && !data.configured && (
          <p className="hint">
            El reescalado está desactivado: hace falta una carpeta &quot;VideoclubUpscaled&quot; en algún
            disco (o UPSCALE_PATH) y Real-ESRGAN en &quot;VideoclubTools\realesrgan&quot; (o
            REALESRGAN_PATH).
          </p>
        )}

        {data && data.configured && (
          <>
            <p className="hint">
              Todo lo que se sirve por debajo de 720p se reescala con Real-ESRGAN y se rehace su HLS. Mientras
              tanto se sigue viendo la versión anterior; el original no se toca.
            </p>

            <div className="queue-summary">
              <span>
                Reescalando: <strong>{data.processing.length}</strong>
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

            {data.processing.length > 0 ? (
              <>
                <p className="section-title">Reescalando ahora</p>
                <div className="queue-list">
                  {data.processing.map((item) => (
                    <div className="queue-row queue-row-active" key={item.id}>
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">
                        {item.fromHeight}p → 720p{item.phase ? ` · ${item.phase}` : ''} · {percentText(item)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="hint">Nada reescalándose ahora mismo.</p>
            )}

            {data.queued.length > 0 && (
              <>
                <p className="section-title">En cola ({data.queued.length})</p>
                <div className="queue-list">
                  {data.queued.map((item) => (
                    <div className="queue-row" key={item.id}>
                      <span className="queue-title">{item.title}</span>
                      <span className="queue-meta">{item.fromHeight}p</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {data.failed.length > 0 && (
              <>
                <p className="section-title">Fallidos ({data.failed.length})</p>
                <p className="hint">Se sigue sirviendo la versión anterior; se reintentan solos al reiniciar el servidor.</p>
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
                      <span className="queue-meta">{item.fromHeight}p → 720p</span>
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
