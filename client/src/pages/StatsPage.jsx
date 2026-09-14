import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

function TopList({ title, entries, emptyText }) {
  return (
    <>
      <p className="section-title">{title}</p>
      {!entries || entries.length === 0 ? (
        <p className="hint">{emptyText}</p>
      ) : (
        <div className="queue-list">
          {entries.map((e) => (
            <div className="queue-row" key={e.key}>
              <span className="queue-title">{e.key}</span>
              <span className="queue-meta">{e.count}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function StatsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/analytics/summary')
      .then((res) => res.json())
      .then(setData)
      .catch(() => setError('No se pudo cargar la analítica.'));
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
        <p className="section-title">Analítica de uso</p>
        <p className="hint">
          Datos propios, guardados solo en este servidor: nada se envía fuera. Sirve para ver qué se
          usa y qué falla, y así decidir qué mejorar.
        </p>

        {error && <p className="config-message error">{error}</p>}

        {data && (
          <>
            <div className="queue-summary">
              <span>
                Eventos totales: <strong>{data.totalEvents}</strong>
              </span>
              {Object.entries(data.byEvent).map(([event, count]) => (
                <span key={event}>
                  {event}: <strong>{count}</strong>
                </span>
              ))}
            </div>

            <TopList title="Más reproducidos" entries={data.topPlayed} emptyText="Todavía no hay reproducciones." />
            <TopList title="Más terminados" entries={data.topCompleted} emptyText="Todavía no hay vídeos terminados." />
            <TopList title="Búsquedas más frecuentes" entries={data.topSearches} emptyText="Todavía no hay búsquedas." />
            <TopList title="Géneros más filtrados" entries={data.topGenres} emptyText="Todavía no se ha filtrado por género." />
            <TopList
              title="Vídeos con más tirones"
              entries={data.topStalls}
              emptyText="Sin tirones registrados."
            />
            <TopList title="Vídeos con más errores" entries={data.topErrors} emptyText="Sin errores registrados." />
          </>
        )}
      </div>
    </>
  );
}
