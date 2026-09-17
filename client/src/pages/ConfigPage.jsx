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
  const [purgeKey, setPurgeKey] = useState('');
  const [purging, setPurging] = useState(false);
  const [purgeMessage, setPurgeMessage] = useState(null);
  const [ungroupKey, setUngroupKey] = useState('');
  const [ungrouping, setUngrouping] = useState(false);
  const [ungroupMessage, setUngroupMessage] = useState(null);

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

  // Borra PERMANENTEMENTE el progreso/carátula/HLS/metadatos de una obra
  // (para cuando su carpeta ya no existe en disco y se ha quedado como
  // "archivada" para siempre en el catálogo sin poder reproducirse). No
  // tiene deshacer, por eso pide confirmar escribiendo la clave exacta.
  const handlePurge = async () => {
    const key = purgeKey.trim();
    if (!key) return;
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(
      `Esto borra PARA SIEMPRE el progreso, carátula, HLS y metadatos de "${key}". No se puede deshacer. ¿Seguro?`
    );
    if (!confirmed) return;
    setPurging(true);
    setPurgeMessage(null);
    try {
      const res = await fetch('/api/catalog/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setPurgeMessage({ text: `Purgado "${key}".`, ok: true });
      setPurgeKey('');
    } catch (err) {
      setPurgeMessage({ text: err.message, ok: false });
    } finally {
      setPurging(false);
    }
  };

  // Marca (o desmarca) una carpeta con varios vídeos como "no es una serie,
  // son títulos sueltos" (p.ej. Berserk con sus 3 películas): a partir de
  // ahí cada vídeo se lista como su propia película, no agrupados.
  const handleUngroup = async (ungrouped) => {
    const key = ungroupKey.trim();
    if (!key) return;
    setUngrouping(true);
    setUngroupMessage(null);
    try {
      const res = await fetch('/api/catalog/ungroup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, ungrouped }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setUngroupMessage({
        text: ungrouped ? `"${key}" marcada como títulos sueltos.` : `"${key}" vuelve a agruparse como serie.`,
        ok: true,
      });
    } catch (err) {
      setUngroupMessage({ text: err.message, ok: false });
    } finally {
      setUngrouping(false);
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
          Busca el nombre y la carátula de toda la biblioteca en TMDB (en español) una vez al día,
          automáticamente. Respeta cualquier carátula que hayas fijado a mano ("Cambiar carátula");
          lo que TMDB no encuentre se queda tal cual está, sin borrar nada.
        </p>
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
          episodio (p.ej. "S06E12" o "E04"); si no está seguro, no los toca. Se ejecuta sola: al
          arrancar el servidor, al aparecer un archivo nuevo, y una vez al día para lo demás.
        </p>
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
          ninguno incrustado) desde el propio desplegable de subtítulos del reproductor.
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

        <p className="section-title" style={{ marginTop: 32 }}>
          Desagrupar carpeta
        </p>
        <p className="hint">
          Para una carpeta con varios vídeos que en realidad son títulos sueltos, no una serie
          (p.ej. "Berserk" con sus 3 películas): a partir de ahí cada uno se lista por su cuenta.
          Es una decisión editorial tuya, no se hace sola.
        </p>
        <label htmlFor="ungroupKey">Clave (nombre de carpeta tal cual aparece en el catálogo)</label>
        <input
          type="text"
          id="ungroupKey"
          autoComplete="off"
          value={ungroupKey}
          onChange={(e) => setUngroupKey(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={() => handleUngroup(true)} disabled={ungrouping || !ungroupKey.trim()}>
            Desagrupar
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => handleUngroup(false)}
            disabled={ungrouping || !ungroupKey.trim()}
          >
            Volver a agrupar
          </button>
        </div>
        {ungroupMessage && (
          <p className={`config-message ${ungroupMessage.ok ? 'ok' : 'error'}`}>{ungroupMessage.text}</p>
        )}

        <p className="section-title" style={{ marginTop: 32 }}>
          Purgar obra
        </p>
        <p className="hint">
          Quita para siempre del catálogo una obra cuya carpeta ya no existe en disco (progreso,
          carátula, HLS generado y metadatos incluidos). No tiene deshacer: solo para cuando ya
          sabes que ese contenido no va a volver.
        </p>
        <label htmlFor="purgeKey">Clave (nombre de carpeta/serie tal cual aparece en el catálogo)</label>
        <input
          type="text"
          id="purgeKey"
          autoComplete="off"
          value={purgeKey}
          onChange={(e) => setPurgeKey(e.target.value)}
        />
        <button type="button" onClick={handlePurge} disabled={purging || !purgeKey.trim()}>
          {purging ? 'Purgando…' : 'Purgar'}
        </button>
        {purgeMessage && <p className={`config-message ${purgeMessage.ok ? 'ok' : 'error'}`}>{purgeMessage.text}</p>}
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
