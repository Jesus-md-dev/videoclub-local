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
  const [showSubdlKey, setShowSubdlKey] = useState(false);
  const [adminStatus, setAdminStatus] = useState(null);
  const [adminUnreachable, setAdminUnreachable] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMessage, setAdminMessage] = useState(null);
  const [storage, setStorage] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState(null);

  // Medir el espacio recorre decenas de miles de archivos: se pide aparte
  // para no retrasar el resto de la página.
  useEffect(() => {
    fetch('/api/storage')
      .then((res) => res.json())
      .then(setStorage)
      .catch(() => {});
  }, []);

  // Estado del servidor (GET /api/admin/status). Mientras hay un reinicio
  // programado o una compilación en marcha se refresca solo; si el servidor
  // no responde (p.ej. reiniciándose) se sigue intentando.
  const loadAdminStatus = () =>
    fetch('/api/admin/status')
      .then((res) => {
        if (!res.ok) throw new Error(res.status);
        return res.json();
      })
      .then((data) => {
        setAdminStatus(data);
        setAdminUnreachable(false);
      })
      .catch(() => setAdminUnreachable(true));

  useEffect(() => {
    loadAdminStatus();
  }, []);

  const adminWaiting = adminUnreachable || adminStatus?.restart?.pending || adminStatus?.updates?.build?.running;
  useEffect(() => {
    if (!adminWaiting) return undefined;
    const timer = setInterval(loadAdminStatus, 5000);
    return () => clearInterval(timer);
  }, [adminWaiting]);

  const adminAction = async (url, body, describe) => {
    setAdminBusy(true);
    setAdminMessage(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setAdminMessage({ text: describe(data), ok: true });
    } catch (err) {
      setAdminMessage({ text: err.message, ok: false });
    } finally {
      setAdminBusy(false);
      loadAdminStatus();
    }
  };

  const handleUpdate = () =>
    adminAction('/api/admin/update', { pull: true }, (r) => {
      const parts = [];
      parts.push(r.pulled && !/Already up to date|Ya está actualizado/i.test(r.pulled) ? 'Descargada la última versión.' : 'Ya estaba en la última versión.');
      if (r.depsInstalled) parts.push('Dependencias instaladas.');
      if (r.clientRebuilt) parts.push('Web recompilada: recarga la página para verla.');
      if (r.restart?.pending) parts.push('El servidor se reiniciará cuando esté libre.');
      if (r.restart?.error) parts.push(r.restart.error);
      return parts.join(' ');
    });

  const handleRestart = (mode) => {
    if (mode === 'now') {
      // eslint-disable-next-line no-alert
      const ok = window.confirm('¿Reiniciar el servidor ahora? Se cortará lo que se esté viendo o convirtiendo; vuelve en unos segundos.');
      if (!ok) return;
    }
    adminAction('/api/admin/restart', { mode }, (r) => {
      if (mode === 'cancel') return 'Reinicio cancelado.';
      if (mode === 'now') return 'Reiniciando…';
      return r.busy?.length ? `Se reiniciará cuando esté libre (ahora: ${r.busy.join(', ')}).` : 'Reiniciando…';
    });
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanupMessage(null);
    try {
      const res = await fetch('/api/storage/cleanup', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      setStorage({ usage: data.usage, cleanup: data.cleanup });
      setCleanupMessage({ text: describeCleanup(data.result), ok: !data.result.skippedOrphans });
    } catch (err) {
      setCleanupMessage({ text: err.message, ok: false });
    } finally {
      setCleaning(false);
    }
  };

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

  // Los botones van dentro de <form> para que Enter en el campo envíe,
  // como en cualquier formulario.
  const onSubmit = (fn) => (e) => {
    e.preventDefault();
    fn();
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
      <main id="main" tabIndex={-1} className="config-wrap config-page">
        <h1 className="config-title">Configuración</h1>

        <section className="config-card" aria-labelledby="cfg-library">
          <h2 id="cfg-library">Biblioteca</h2>
          <form onSubmit={onSubmit(handleSave)}>
            <label htmlFor="videosPath">Carpeta de vídeos</label>
            <div className="path-row">
              <input
                type="text"
                id="videosPath"
                placeholder="C:\Users\tu_usuario\Videos"
                autoComplete="off"
                aria-describedby="videosPath-hint"
                value={videosPath}
                onChange={(e) => setVideosPath(e.target.value)}
              />
              <button type="button" className="secondary" onClick={() => setBrowsing(true)}>
                Examinar…
              </button>
            </div>
            <p className="hint" id="videosPath-hint">
              Ruta absoluta en el equipo del servidor. Al guardar se vuelve a escanear el catálogo y se
              generan las carátulas que falten.
            </p>
            <button type="submit" disabled={saving}>
              {saving ? 'Guardando…' : 'Guardar y escanear'}
            </button>
          </form>
          <Status message={message} />
        </section>

        <section className="config-card" aria-labelledby="cfg-server">
          <h2 id="cfg-server">Servidor</h2>
          <div aria-live="polite">
            {adminUnreachable && <p className="config-message error">El servidor no responde (¿reiniciándose?). Reintentando…</p>}
          </div>
          {adminStatus && (
            <>
              <dl className="storage-list">
                <div className="storage-row">
                  <dt>Versión en marcha</dt>
                  <dd>
                    {adminStatus.updates.runningCommit?.slice(0, 7) || '—'}{' '}
                    <span className="storage-files">
                      · desde {new Date(adminStatus.server.startedAt).toLocaleString('es-ES')}
                    </span>
                  </dd>
                </div>
                <div className="storage-row">
                  <dt>Vigilante (se relanza solo si se cae)</dt>
                  <dd>{adminStatus.restart.supervised ? 'Activo' : 'No: arráncalo con iniciar.bat'}</dd>
                </div>
                {adminStatus.disks.map((disk) => (
                  <div key={disk.drive} className="storage-row">
                    <dt title={disk.uses.join(', ')}>
                      Disco {disk.drive.replace(/\\$/, '')} <span className="storage-files">({disk.uses.join(', ')})</span>
                    </dt>
                    <dd className={disk.freeBytes < 20e9 ? 'disk-low' : undefined}>
                      {disk.error ? 'no accesible' : `${formatBytes(disk.freeBytes)} libres de ${formatBytes(disk.totalBytes)}`}
                    </dd>
                  </div>
                ))}
              </dl>
              {adminStatus.updates.serverChanged && !adminStatus.restart.pending && (
                <p className="hint">Hay cambios del servidor sin aplicar: hace falta reiniciar.</p>
              )}
              {adminStatus.updates.build?.running && <p className="hint">Recompilando la web…</p>}
              {adminStatus.restart.pending && (
                <p className="hint">
                  <strong>Reinicio programado</strong> ({adminStatus.restart.pending.reason}).{' '}
                  {adminStatus.restart.busy.length
                    ? `Esperando a que termine: ${adminStatus.restart.busy.join(', ')}.`
                    : 'Reiniciando en unos segundos…'}
                </p>
              )}
            </>
          )}
          <div className="button-row">
            <button type="button" onClick={handleUpdate} disabled={adminBusy || adminUnreachable}>
              Buscar actualizaciones
            </button>
            {adminStatus?.restart?.pending ? (
              <button type="button" className="secondary" onClick={() => handleRestart('cancel')} disabled={adminBusy}>
                Cancelar reinicio
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                onClick={() => handleRestart('idle')}
                disabled={adminBusy || !adminStatus?.restart?.supervised}
              >
                Reiniciar cuando esté libre
              </button>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => handleRestart('now')}
              disabled={adminBusy || !adminStatus?.restart?.supervised}
            >
              Reiniciar ahora
            </button>
          </div>
          <Status message={adminMessage} />

          <div className="config-divider" />

          <label className="checkbox-row" htmlFor="autostart">
            <input
              type="checkbox"
              id="autostart"
              aria-describedby="autostart-hint"
              checked={Boolean(autostart?.enabled)}
              disabled={!autostart?.supported || autostartSaving}
              onChange={(e) => handleAutostart(e.target.checked)}
            />
            Arrancar el servidor al encender el PC
          </label>
          <p className="hint" id="autostart-hint">
            {autostart && !autostart.supported
              ? 'Solo disponible cuando el servidor corre en Windows.'
              : 'Arranca al iniciar sesión en Windows, en segundo plano y sin avisos salvo si algo falla.'}
          </p>
          <Status message={autostartMessage} />

          <div className="config-divider" />

          <h3>Apagar el PC</h3>
          <p className="hint" id="power-hint">
            {power && !power.supported
              ? 'Solo disponible cuando el servidor corre en Windows.'
              : `Apaga el equipo del servidor, con ${power?.delaySeconds || 60} segundos de margen para cancelarlo desde aquí.`}
          </p>
          <div aria-live="polite">
            {shutdownSecondsLeft !== null && (
              <p className="config-message error">
                {shutdownSecondsLeft > 0 ? `El PC se apagará en ${shutdownSecondsLeft} s.` : 'Apagando el PC…'}
              </p>
            )}
          </div>
          {shutdownSecondsLeft !== null ? (
            <button type="button" onClick={handleCancelShutdown} disabled={powerBusy}>
              Cancelar apagado
            </button>
          ) : (
            <button
              type="button"
              className="danger"
              aria-describedby="power-hint"
              onClick={handleShutdown}
              disabled={!power?.supported || powerBusy}
            >
              Apagar el PC
            </button>
          )}
          <Status message={powerMessage} />
        </section>

        <section className="config-card" aria-labelledby="cfg-subtitles">
          <h2 id="cfg-subtitles">Subtítulos</h2>
          <form onSubmit={onSubmit(handleSaveSubtitles)}>
            <label htmlFor="subdlApiKey">Clave de API de SubDL</label>
            <div className="path-row">
              <input
                type={showSubdlKey ? 'text' : 'password'}
                id="subdlApiKey"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="subdlApiKey-hint"
                value={subdlApiKey}
                onChange={(e) => setSubdlApiKey(e.target.value)}
              />
              <button
                type="button"
                className="secondary"
                aria-pressed={showSubdlKey}
                onClick={() => setShowSubdlKey((v) => !v)}
              >
                {showSubdlKey ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            <p className="hint" id="subdlApiKey-hint">
              Para buscar subtítulos mejores (o cuando el vídeo no trae) desde el reproductor. Gratis en{' '}
              <a href="https://subdl.com/panel/api" target="_blank" rel="noreferrer">
                subdl.com/panel/api
                <span className="sr-only"> (se abre en otra pestaña)</span>
              </a>
              .{' '}
              {subtitlesStatus && (
                <strong className={subtitlesStatus.configured ? 'status-ok' : 'status-off'}>
                  {subtitlesStatus.configured ? 'Configurado.' : 'Sin configurar.'}
                </strong>
              )}
            </p>
            <button type="submit" disabled={subtitlesSaving}>
              {subtitlesSaving ? 'Guardando…' : 'Guardar'}
            </button>
          </form>
          <Status message={subtitlesMessage} />
        </section>

        <section className="config-card" aria-labelledby="cfg-auto">
          <h2 id="cfg-auto">Tareas automáticas</h2>
          <p className="hint">Se hacen solas; aquí solo se ve su progreso mientras están en marcha.</p>
          <h3>Metadatos de TMDB</h3>
          <p className="hint">Nombre y carátula en español, una vez al día. Respeta las carátulas fijadas a mano.</p>
          {tmdbProgress && (
            <Progress
              label="Metadatos de TMDB"
              done={tmdbProgress.done}
              total={tmdbProgress.total}
              detail={`${tmdbProgress.updated} actualizados`}
              finished={!tmdbProgress.running && tmdbProgress.total > 0}
            />
          )}
          <h3>Nombres de archivo</h3>
          <p className="hint">
            Al arrancar, al llegar un archivo nuevo y una vez al día. Solo renombra lo que reconoce con
            seguridad (p.ej. «S06E12»).
          </p>
          {normalizeProgress && (
            <>
              <Progress
                label="Nombres de archivo"
                done={normalizeProgress.done}
                total={normalizeProgress.total}
                detail={`${normalizeProgress.renamed} renombrados`}
                finished={!normalizeProgress.running && normalizeProgress.total > 0}
              />
              {normalizeProgress.errors?.length > 0 && (
                <p className="config-message error">
                  {normalizeProgress.errors.length} con error (p.ej. «{normalizeProgress.errors[0].title}»:{' '}
                  {normalizeProgress.errors[0].message})
                </p>
              )}
            </>
          )}
        </section>

        <section className="config-card" aria-labelledby="cfg-maintenance">
          <h2 id="cfg-maintenance">Mantenimiento</h2>

          <h3>Espacio en disco</h3>
          <p className="hint" id="cleanup-hint">
            Una vez al día se mueven a una papelera (que se vacía a los 7 días) las carátulas, vistas previas y
            subtítulos de vídeos que ya no existen, y se borran las instantáneas viejas (se guardan 7 diarias y 4
            semanales). Nunca toca nada de vídeos archivados o perdidos.
          </p>
          {storage ? (
            <dl className="storage-list">
              {storage.usage.items.map((item) => (
                <div key={item.key} className="storage-row">
                  <dt title={item.path}>{item.label}</dt>
                  <dd>
                    {formatBytes(item.bytes)} <span className="storage-files">· {item.files.toLocaleString('es-ES')} archivos</span>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="hint">Midiendo…</p>
          )}
          {storage?.cleanup?.lastRunAt && (
            <p className="hint">
              Última limpieza: {new Date(storage.cleanup.lastRunAt).toLocaleString('es-ES')}
              {storage.cleanup.lastResult && <> — {describeCleanup(storage.cleanup.lastResult)}</>}
            </p>
          )}
          <button type="button" aria-describedby="cleanup-hint" onClick={handleCleanup} disabled={cleaning}>
            {cleaning ? 'Limpiando…' : 'Limpiar ahora'}
          </button>
          <Status message={cleanupMessage} />

          <div className="config-divider" />

          <h3>Vídeos archivados sin análisis</h3>
          <p className="hint" id="health-hint">
            Un vídeo archivado (sin original, solo HLS) necesita su análisis de pistas guardado; si se pierde,
            no se puede recuperar. Comprueba cuántos están así.
          </p>
          <button type="button" aria-describedby="health-hint" onClick={handleHealthCheck} disabled={healthChecking}>
            {healthChecking ? 'Comprobando…' : 'Comprobar'}
          </button>
          <div aria-live="polite">
            {healthResult?.error && <p className="config-message error">{healthResult.error}</p>}
            {healthResult && !healthResult.error && (
              <p className="config-message">
                {healthResult.totalArchived} archivados en total · {healthResult.withoutCache} sin análisis guardado
                {healthResult.withoutAnything > 0 && (
                  <> · {healthResult.withoutAnything} sin ni siquiera el HLS (irrecuperables del todo)</>
                )}
              </p>
            )}
          </div>
          {healthResult?.sample?.length > 0 && (
            <ul className="queue-list" style={{ maxHeight: 260 }}>
              {healthResult.sample.map((v) => (
                <li key={v.id} className="queue-row">
                  <span className="queue-title">{v.title}</span>
                  <span className="queue-meta">{v.hasHls ? 'con HLS' : 'sin HLS'}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="config-divider" />

          <h3>Desagrupar carpeta</h3>
          <form onSubmit={onSubmit(() => handleUngroup(true))}>
            <label htmlFor="ungroupKey">Nombre de la carpeta, tal cual sale en el catálogo</label>
            <input
              type="text"
              id="ungroupKey"
              autoComplete="off"
              aria-describedby="ungroupKey-hint"
              value={ungroupKey}
              onChange={(e) => setUngroupKey(e.target.value)}
            />
            <p className="hint" id="ungroupKey-hint">
              Para una carpeta con varios vídeos que son títulos sueltos y no una serie (p.ej. «Berserk» con sus 3
              películas): cada uno pasa a listarse por su cuenta.
            </p>
            <div className="button-row">
              <button type="submit" disabled={ungrouping || !ungroupKey.trim()}>
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
          </form>
          <Status message={ungroupMessage} />
        </section>

        <section className="config-card danger-zone" aria-labelledby="cfg-danger">
          <h2 id="cfg-danger">Zona peligrosa</h2>
          <p className="hint">Lo de aquí no tiene deshacer.</p>

          <h3>Purgar obra</h3>
          <form onSubmit={onSubmit(handlePurge)}>
            <label htmlFor="purgeKey">Nombre de la carpeta o serie, tal cual sale en el catálogo</label>
            <input
              type="text"
              id="purgeKey"
              autoComplete="off"
              aria-describedby="purgeKey-hint"
              value={purgeKey}
              onChange={(e) => setPurgeKey(e.target.value)}
            />
            <p className="hint" id="purgeKey-hint">
              Quita del catálogo una obra cuya carpeta ya no existe en disco: progreso, carátula, HLS y
              metadatos. No toca ningún archivo de vídeo.
            </p>
            <button type="submit" className="danger" disabled={purging || !purgeKey.trim()}>
              {purging ? 'Purgando…' : 'Purgar'}
            </button>
          </form>
          <Status message={purgeMessage} />

          <div className="config-divider" />

          <h3>Borrar contenido</h3>
          <form onSubmit={onSubmit(handleDelete)}>
            <label htmlFor="deleteKey">Nombre de la carpeta o serie, tal cual sale en el catálogo</label>
            <input
              type="text"
              id="deleteKey"
              autoComplete="off"
              aria-describedby="deleteKey-hint"
              value={deleteKey}
              onChange={(e) => {
                setDeleteKey(e.target.value);
                setDeleteConfirmTitle('');
              }}
            />
            <p className="hint" id="deleteKey-hint">
              Borra para siempre los archivos de vídeo (en su carpeta o ya trasladados a otro disco) además de
              todo lo que purgar limpia. Sin papelera.
            </p>
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
              type="submit"
              className="danger"
              disabled={deleting || !deleteKey.trim() || deleteConfirmTitle.trim() !== deleteKey.trim()}
            >
              {deleting ? 'Borrando…' : 'Borrar para siempre'}
            </button>
          </form>
          <Status message={deleteMessage} />
        </section>
      </main>
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

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

function describeCleanup(result) {
  const parts = [
    `${result.files} archivo(s) sobrantes a la papelera (${formatBytes(result.bytes)})`,
    `${result.snapshotsRemoved.length} instantánea(s) borradas`,
  ];
  if (result.snapshotsSlimmed) parts.push(`${result.snapshotsSlimmed} aligeradas`);
  if (result.trashEmptied.length) parts.push(`papelera vaciada (${result.trashEmptied.length} día/s)`);
  const text = `${parts.join(', ')}.`;
  return result.skippedOrphans ? `No se quitaron archivos sobrantes: ${result.skippedOrphans}. ${text}` : text;
}

// La región aria-live existe siempre (vacía si no hay mensaje): si se
// creara junto con el texto, los lectores de pantalla no lo anunciarían.
function Status({ message }) {
  return (
    <div aria-live="polite">
      {message && <p className={`config-message ${message.ok ? 'ok' : 'error'}`}>{message.text}</p>}
    </div>
  );
}

function Progress({ label, done, total, detail, finished }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <>
      <div
        className="progress-bar config-progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div style={{ width: `${pct}%` }} />
      </div>
      <p className="hint">
        {done} / {total} ({detail})
        {finished ? ' — completado' : ''}
      </p>
    </>
  );
}
