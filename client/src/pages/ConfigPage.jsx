import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import FolderBrowser from '../components/FolderBrowser';
import HiddenMenu from '../components/HiddenMenu';

export default function ConfigPage() {
  const [videosPath, setVideosPath] = useState('');
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [tmdbProgress, setTmdbProgress] = useState(null);
  const [normalizeProgress, setNormalizeProgress] = useState(null);
  const [subdlApiKey, setSubdlApiKey] = useState('');
  const [subtitlesStatus, setSubtitlesStatus] = useState(null);
  const [subtitlesSaving, setSubtitlesSaving] = useState(false);
  const [subtitlesMessage, setSubtitlesMessage] = useState(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResult, setHealthResult] = useState(null);

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.videosPath) setVideosPath(data.videosPath);
      });
  }, []);

  // Si ya había una pasada en marcha (p.ej. se recargó la página a medias),
  // se engancha a su progreso en vez de mostrar el botón como si no hubiera
  // nada corriendo.
  useEffect(() => {
    fetch('/api/metadata/force-tmdb-status')
      .then((res) => res.json())
      .then((data) => {
        if (data.running) setTmdbProgress(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!tmdbProgress?.running) return undefined;
    const timer = setInterval(() => {
      fetch('/api/metadata/force-tmdb-status')
        .then((res) => res.json())
        .then(setTmdbProgress)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [tmdbProgress?.running]);

  useEffect(() => {
    fetch('/api/normalize/status')
      .then((res) => res.json())
      .then((data) => {
        if (data.running) setNormalizeProgress(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!normalizeProgress?.running) return undefined;
    const timer = setInterval(() => {
      fetch('/api/normalize/status')
        .then((res) => res.json())
        .then(setNormalizeProgress)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [normalizeProgress?.running]);

  const handleNormalize = async () => {
    try {
      const res = await fetch('/api/normalize/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setNormalizeProgress({ running: true, total: data.total, done: 0, renamed: 0, errors: [] });
    } catch (err) {
      setMessage({ text: err.message, ok: false });
    }
  };

  const handleForceTmdb = async () => {
    try {
      const res = await fetch('/api/metadata/force-tmdb-all', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setTmdbProgress({ running: true, total: data.total, done: 0, updated: 0 });
    } catch (err) {
      setMessage({ text: err.message, ok: false });
    }
  };

  const loadSubtitlesConfig = () => {
    fetch('/api/subdl/config')
      .then((res) => res.json())
      .then((data) => setSubdlApiKey(data.apiKey || ''))
      .catch(() => {});
    fetch('/api/subdl/status')
      .then((res) => res.json())
      .then(setSubtitlesStatus)
      .catch(() => {});
  };

  useEffect(() => {
    loadSubtitlesConfig();
  }, []);

  const handleSaveSubtitles = async () => {
    setSubtitlesSaving(true);
    setSubtitlesMessage(null);
    try {
      const res = await fetch('/api/subdl/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: subdlApiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setSubtitlesMessage({
        text: data.configured ? 'Guardado y listo para usarse.' : 'Guardado, pero sin clave no se usará.',
        ok: data.configured,
      });
      loadSubtitlesConfig();
    } catch (err) {
      setSubtitlesMessage({ text: err.message, ok: false });
    } finally {
      setSubtitlesSaving(false);
    }
  };

  const handleHealthCheck = async () => {
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const res = await fetch('/api/health/archived-videos');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setHealthResult(data);
    } catch (err) {
      setHealthResult({ error: err.message });
    } finally {
      setHealthChecking(false);
    }
  };

  const handleSave = async () => {
    const value = videosPath.trim();
    if (!value) {
      setMessage({ text: 'Escribe una ruta de carpeta.', ok: false });
      return;
    }

    setSaving(true);
    setMessage({ text: 'Guardando y escaneando...', ok: true });

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videosPath: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setMessage({ text: `Guardado. ${data.count} vídeo(s) encontrados.`, ok: true });
    } catch (err) {
      setMessage({ text: err.message, ok: false });
    } finally {
      setSaving(false);
    }
  };

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
      <div className="config-wrap">
        <p className="section-title">Configuración</p>
        <label htmlFor="videosPath">Carpeta de vídeos (ruta absoluta en el servidor)</label>
        <div className="path-row">
          <input
            type="text"
            id="videosPath"
            placeholder="C:\Users\tu_usuario\Videos"
            autoComplete="off"
            value={videosPath}
            onChange={(e) => setVideosPath(e.target.value)}
          />
          <button type="button" className="secondary" onClick={() => setBrowsing(true)}>
            Examinar...
          </button>
        </div>
        <p className="hint">
          Debe ser una ruta accesible desde el equipo donde corre el servidor. Al guardar, se
          vuelve a escanear el catálogo y se generan las carátulas que falten.
        </p>
        <button onClick={handleSave} disabled={saving}>
          Guardar y escanear
        </button>
        {message && (
          <p className={`config-message ${message.ok ? 'ok' : 'error'}`}>{message.text}</p>
        )}

        <p className="section-title" style={{ marginTop: 32 }}>
          Metadatos
        </p>
        <p className="hint">
          Vuelve a buscar el nombre y la carátula de toda la biblioteca, solo en TMDB y en español.
          Lo que TMDB no encuentre se queda tal cual está ahora, sin borrar nada.
        </p>
        <button type="button" onClick={handleForceTmdb} disabled={tmdbProgress?.running}>
          {tmdbProgress?.running ? 'Actualizando…' : 'Forzar actualización TMDB'}
        </button>
        {tmdbProgress && (
          <>
            <div className="progress-bar" style={{ height: 8, marginTop: 12 }}>
              <div
                style={{
                  width: `${tmdbProgress.total ? Math.round((tmdbProgress.done / tmdbProgress.total) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="hint">
              {tmdbProgress.done} / {tmdbProgress.total} ({tmdbProgress.updated} actualizados)
              {!tmdbProgress.running && tmdbProgress.total > 0 ? ' — completado' : ''}
            </p>
          </>
        )}

        <p className="section-title" style={{ marginTop: 32 }}>
          Nombres de archivo
        </p>
        <p className="hint">
          Renombra episodios y películas a un nombre limpio y consistente (usa la carátula/nombre
          de TMDB cuando ya está en caché). Solo toca archivos donde reconoce con confianza el
          episodio (p.ej. "S06E12" o "E04"); si no está seguro, no los toca. Los archivos nuevos
          que aparezcan mientras el servidor está encendido se normalizan solos, sin necesidad de
          pulsar este botón.
        </p>
        <button type="button" onClick={handleNormalize} disabled={normalizeProgress?.running}>
          {normalizeProgress?.running ? 'Normalizando…' : 'Normalizar nombres'}
        </button>
        {normalizeProgress && (
          <>
            <div className="progress-bar" style={{ height: 8, marginTop: 12 }}>
              <div
                style={{
                  width: `${
                    normalizeProgress.total ? Math.round((normalizeProgress.done / normalizeProgress.total) * 100) : 0
                  }%`,
                }}
              />
            </div>
            <p className="hint">
              {normalizeProgress.done} / {normalizeProgress.total} ({normalizeProgress.renamed} renombrados)
              {!normalizeProgress.running && normalizeProgress.total > 0 ? ' — completado' : ''}
            </p>
            {normalizeProgress.errors?.length > 0 && (
              <p className="config-message error">
                {normalizeProgress.errors.length} con error (p.ej. "{normalizeProgress.errors[0].title}":{' '}
                {normalizeProgress.errors[0].message})
              </p>
            )}
          </>
        )}

        <p className="section-title" style={{ marginTop: 32 }}>
          Subtítulos
        </p>
        <p className="hint">
          Para buscar y descargar subtítulos de mejor calidad (o cuando el vídeo no lleva
          ninguno incrustado) desde el botón 🔍 del reproductor.
        </p>
        <label htmlFor="subdlApiKey">Clave de API de SubDL</label>
        <input
          type="text"
          id="subdlApiKey"
          autoComplete="off"
          value={subdlApiKey}
          onChange={(e) => setSubdlApiKey(e.target.value)}
        />
        <p className="hint">
          Gratis en{' '}
          <a href="https://subdl.com/panel/api" target="_blank" rel="noreferrer">
            subdl.com/panel/api
          </a>
          .
        </p>
        <button type="button" onClick={handleSaveSubtitles} disabled={subtitlesSaving}>
          Guardar
        </button>
        {subtitlesMessage && (
          <p className={`config-message ${subtitlesMessage.ok ? 'ok' : 'error'}`}>{subtitlesMessage.text}</p>
        )}
        {subtitlesStatus && !subtitlesMessage && (
          <p className="hint">SubDL: {subtitlesStatus.configured ? 'configurado' : 'sin configurar'}</p>
        )}

        <p className="section-title" style={{ marginTop: 32 }}>
          Vídeos archivados sin análisis
        </p>
        <p className="hint">
          Un vídeo "archivado" (su original se borró porque el HLS ya era el mismo vídeo, ver
          /queue) depende por completo de que se guardara antes su análisis (qué pistas de audio/
          subtítulos tenía): si ese dato se pierde, ya no hay forma de recuperarlo - no queda
          ningún archivo del que volver a sacarlo. Esto comprueba cuántos se han quedado así.
        </p>
        <button type="button" onClick={handleHealthCheck} disabled={healthChecking}>
          {healthChecking ? 'Comprobando…' : 'Comprobar'}
        </button>
        {healthResult?.error && <p className="config-message error">{healthResult.error}</p>}
        {healthResult && !healthResult.error && (
          <>
            <p className="hint">
              {healthResult.totalArchived} archivados en total · {healthResult.withoutCache} sin análisis guardado
              {healthResult.withoutAnything > 0 && (
                <> · {healthResult.withoutAnything} sin ni siquiera el HLS (irrecuperables del todo)</>
              )}
            </p>
            {healthResult.sample.length > 0 && (
              <ul className="queue-list" style={{ maxHeight: 260 }}>
                {healthResult.sample.map((v) => (
                  <li key={v.id} className="queue-row">
                    <span className="queue-title">{v.title}</span>
                    <span className="queue-meta">{v.hasHls ? 'con HLS' : 'sin HLS'}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {browsing && (
        <FolderBrowser
          startPath={videosPath}
          onClose={() => setBrowsing(false)}
          onSelect={(selectedPath) => {
            setVideosPath(selectedPath);
            setBrowsing(false);
          }}
        />
      )}
    </>
  );
}
