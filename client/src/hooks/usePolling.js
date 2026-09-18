import { useEffect, useState } from 'react';

// Sondea `url` cada `interval` ms mientras el componente esté montado, y
// reintenta a `errorInterval` ms si falla - mismo esqueleto que antes
// repetían por separado QueuePage y MoveQueuePage (cancelled/timer/load/
// cleanup), aquí compartido para no duplicarlo en cada página de "cola"
// nueva que se añada.
export default function usePolling(url, { interval = 3000, errorInterval = 5000, errorMessage } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const load = () => {
      fetch(url)
        .then((res) => res.json())
        .then((json) => {
          if (cancelled) return;
          setData(json);
          setError(null);
          timer = setTimeout(load, interval);
        })
        .catch(() => {
          if (!cancelled) {
            setError(errorMessage || 'No se pudo cargar los datos.');
            timer = setTimeout(load, errorInterval);
          }
        });
    };

    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, interval, errorInterval, errorMessage]);

  return { data, error };
}
