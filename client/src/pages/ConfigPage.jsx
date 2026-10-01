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
  const [deleteKey, setDeleteKey] = useState('');
  const [deleteConfirmTitle, setDeleteConfirmTitle] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState(null);
  const [autostart, setAutostart] = useState(null);
  const [autostartSaving, setAutostartSaving] = useState(false);
  const [autostartMessage, setAutostartMessage] = useState(null);
  const [power, setPower] = useState(null);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerMessage, setPowerMessage] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.videosPath) setVideosPath(data.videosPath);
      });
    fetch('/api/settings/autostart')
      .then((res) => res.json())
      .then(setAutostart)
      .catch(() => {});
    fetch('/api/power')
      .then((res) => res.json())
      .then(setPower)
      .catch(() => {});
  }, []);

  const shutdownAt = power?.scheduledFor ? new Date(power.scheduledFor).getTime() : null;
  const shutdownSecondsLeft = shutdownAt ? Math.max(0, Math.ceil((shutdownAt - now) / 1000)) : null;

  useEffect(() => {
    if (!shutdownAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shutdownAt]);

  // Antes de confirmar, avisa si hay trabajos a medias (HLS, traslados de
  // originales a otro disco): al apagar se cortan y se retoman en el
  // siguiente arranque, pero mejor saberlo.
  const describeRunningWork = async () => {
    const parts = [];
    try {
      const queue = await fetch('/api/queue').then((res) => res.json());
      const hlsLeft = (queue.summary?.processing || 0) + (queue.summary?.pending || 0);
      if (hlsLeft > 0) parts.push(`${hlsLeft} vídeo(s) generando o esperando HLS`);
    } catch {
      // Sin datos de la cola: se confirma igual, solo sin el aviso.
    }
    try {
      const moves = await fetch('/api/move-queue').then((res) => res.json());
      const movesLeft = (moves.moving?.length || 0) + (moves.queued?.length || 0);
      if (movesLeft > 0) parts.push(`${movesLeft} original(es) trasladándose a otro disco`);
    } catch {
      // Igual que arriba.
    }
    return parts;
  };

  const handleShutdown = async () => {
    setPowerBusy(true);
    setPowerMessage(null);
    try {
      const running = await describeRunningWork();
      const warning = running.length
        ? `\n\nHay trabajo en marcha que se cortará (se retoma al volver a encender): ${running.join(', ')}.`
        : '';
      // eslint-disable-next-line no-alert
      const confirmed = window.confirm(
        `¿Apagar el PC del servidor? Se apagará en ${power?.delaySeconds || 60} segundos y la web dejará de funcionar hasta que se vuelva a encender.${warning}`
      );
      if (!confirmed) return;
      const res = await fetch('/api/power/shutdown', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setNow(Date.now());
      setPower(data);
    } catch (err) {
      setPowerMessage({ text: err.message, ok: false });
    } finally {
      setPowerBusy(false);
    }
  };

  const handleCancelShutdown = async () => {
    setPowerBusy(true);
    setPowerMessage(null);
    try {
      const res = await fetch('/api/power/cancel', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setPower(data);
      setPowerMessage({ text: 'Apagado cancelado.', ok: true });
    } catch (err) {
      setPowerMessage({ text: err.message, ok: false });
    } finally {
      setPowerBusy(false);
    }
  };

  const handleAutostart = async (enabled) => {
    setAutostartSaving(true);
    setAutostartMessage(null);
    try {
      const res = await fetch('/api/settings/autostart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setAutostart(data);
      setAutostartMessage({
        text: data.enabled
          ? 'Activado: el servidor arrancará solo al iniciar sesión en Windows.'
          : 'Desactivado: ya no arrancará solo.',
        ok: true,
      });
    } catch (err) {
      setAutostartMessage({ text: err.message, ok: false });
    } finally {
      setAutostartSaving(false);
    }
  };

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

  // Borra el archivo de vídeo REAL (no solo sus metadatos, a diferencia de
  // handlePurge arriba). Sin deshacer y sin papelera, así que la única
  // protección contra un clic sin querer es escribir el título exacto en
  // "deleteConfirmTitle" - el botón ni siquiera se activa si no coincide
  // letra por letra, y el servidor lo vuelve a comprobar por su cuenta.
  const handleDelete = async () => {
    const key = deleteKey.trim();
    if (!key || deleteConfirmTitle.trim() !== key) return;
    setDeleting(true);
    setDeleteMessage(null);
    try {
      const res = await fetch('/api/catalog/delete-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, confirmTitle: deleteConfirmTitle.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setDeleteMessage({
        text: `Borrado "${key}": ${data.filesDeleted} archivo(s) de vídeo eliminados para siempre.`,
        ok: true,
      });
      setDeleteKey('');
      setDeleteConfirmTitle('');
    } catch (err) {
      setDeleteMessage({ text: err.message, ok: false });
    } finally {
      setDeleting(false);
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
          Inicio automático
        </p>
        <label className="checkbox-row" htmlFor="autostart">
          <input
            type="checkbox"
            id="autostart"
            checked={Boolean(autostart?.enabled)}
            disabled={!autostart?.supported || autostartSaving}
            onChange={(e) => handleAutostart(e.target.checked)}
          />
          Arrancar el servidor al encender el PC
        </label>
        <p className="hint">
          {autostart && !autostart.supported
            ? 'Solo disponible cuando el servidor corre en Windows.'
            : 'Pone un acceso directo a iniciar.bat en la carpeta Inicio de Windows: arranca al iniciar sesión, en segundo plano y sin avisos salvo si algo falla.'}
        </p>
        {autostartMessage && (
          <p className={`config-message ${autostartMessage.ok ? 'ok' : 'error'}`}>{autostartMessage.text}</p>
        )}

        <p className="section-title danger" style={{ marginTop: 32 }}>
          Apagar el PC
        </p>
        <p className="hint">
          {power && !power.supported
            ? 'Solo disponible cuando el servidor corre en Windows.'
            : `Apaga el equipo donde corre el servidor, con ${power?.delaySeconds || 60} segundos de margen para cancelarlo desde aquí.`}
        </p>
        {shutdownSecondsLeft !== null ? (
          <>
            <p className="config-message error">
              {shutdownSecondsLeft > 0 ? `El PC se apagará en ${shutdownSecondsLeft} s.` : 'Apagando el PC…'}
            </p>
            <button type="button" onClick={handleCancelShutdown} disabled={powerBusy}>
              Cancelar apagado
            </button>
          </>
        ) : (
          <button
            type="button"
            className="danger"
            onClick={handleShutdown}
            disabled={!power?.supported || powerBusy}
          >
            Apagar el PC
          </button>
        )}
        {powerMessage && (
          <p className={`config-message ${powerMessage.ok ? 'ok' : 'error'}`}>{powerMessage.text}</p>
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

        <p className="section-title danger" style={{ marginTop: 32 }}>
          Borrar contenido
        </p>
        <p className="hint">
          Borra PARA SIEMPRE el archivo de vídeo (esté en su carpeta original o ya trasladado a
          otro disco para ahorrar espacio) además de todo lo que purgar ya limpia. No hay papelera
          ni deshacer: solo para cuando de verdad no quieres volver a tener ese contenido.
        </p>
        <label htmlFor="deleteKey">Clave (nombre de carpeta/serie tal cual aparece en el catálogo)</label>
        <input
          type="text"
          id="deleteKey"
          autoComplete="off"
          value={deleteKey}
          onChange={(e) => {
            setDeleteKey(e.target.value);
            setDeleteConfirmTitle('');
          }}
        />
        {deleteKey.trim() && (
          <>
            <label htmlFor="deleteConfirmTitle">
              Escribe <strong>{deleteKey.trim()}</strong> para confirmar
            </label>
            <input
              type="text"
              id="deleteConfirmTitle"
              autoComplete="off"
              value={deleteConfirmTitle}
              onChange={(e) => setDeleteConfirmTitle(e.target.value)}
            />
          </>
        )}
        <button
          type="button"
          className="danger"
          onClick={handleDelete}
          disabled={deleting || !deleteKey.trim() || deleteConfirmTitle.trim() !== deleteKey.trim()}
        >
          {deleting ? 'Borrando…' : 'Borrar para siempre'}
        </button>
        {deleteMessage && (
          <p className={`config-message ${deleteMessage.ok ? 'ok' : 'error'}`}>{deleteMessage.text}</p>
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
