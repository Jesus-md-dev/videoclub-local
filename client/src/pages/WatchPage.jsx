import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Hls from 'hls.js';
import VideoControls from '../components/VideoControls';
import HiddenMenu from '../components/HiddenMenu';
import { getActiveProfileId } from '../profile';
import { DEFAULT_SUBTITLE_PREFS, SUBTITLE_SIZE_EM, SUBTITLE_BG_COLOR, fetchSubtitlePrefs, saveSubtitlePrefs } from '../subtitlePrefs';
import { track } from '../analytics';

// El progreso se guarda en el servidor por perfil (no en localStorage), así
// que se retoma igual desde cualquier dispositivo de la red.
function progressUrl(profileId, id) {
  return `/api/profiles/${profileId}/progress/${id}`;
}

function saveProgress(profileId, id, videoEl) {
  if (!profileId || !videoEl.duration) return;
  const ratio = videoEl.currentTime / videoEl.duration;
  fetch(progressUrl(profileId, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: videoEl.currentTime, ratio }),
  }).catch(() => {});
}

// Más fiable que fetch al cerrar la pestaña/navegar fuera: el navegador
// garantiza el envío aunque la página ya se esté descargando.
function saveProgressOnUnload(profileId, id, videoEl) {
  if (!profileId || !videoEl.duration || !navigator.sendBeacon) return;
  const ratio = videoEl.currentTime / videoEl.duration;
  const blob = new Blob([JSON.stringify({ time: videoEl.currentTime, ratio })], {
    type: 'application/json',
  });
  navigator.sendBeacon(progressUrl(profileId, id), blob);
}

function trackLabel(track) {
  return track.languageLabel || track.title || `Pista ${track.index}`;
}

// La posición de una pista en tracks.audio (venida de ffprobe, vía
// /api/tracks/:id) NO tiene por qué coincidir con la posición de esa misma
// pista en hls.js/audioTracks nativo del navegador (su propio análisis del
// manifiesto, con su propio orden interno) - usar el índice de una lista
// para indexar la otra podía acabar sin querer siempre en la pista por
// defecto, por mucho idioma distinto que se eligiera. Se busca por idioma
// (LANGUAGE="jpn", etc., el mismo valor en ambos sitios) directamente
// dentro de la lista real del reproductor, nunca por posición prestada.
function findByLanguage(list, language) {
  if (!language || !list) return -1;
  for (let i = 0; i < list.length; i += 1) {
    const trackLang = list[i].lang || list[i].language;
    if (trackLang && trackLang.toLowerCase() === language.toLowerCase()) return i;
  }
  return -1;
}

// Algunos archivos (ediciones de fans, sobre todo) no llevan la pista de
// audio etiquetada con un idioma real en el contenedor, solo un "título"
// (p.ej. "Castellano"/"Japones Flac") - ahí no hay idioma con el que
// buscar en ninguno de los dos lados. Además ffmpeg no traslada ese
// título tal cual al NAME del manifiesto HLS (siempre pone "audio_N"
// genérico), así que tampoco sirve para buscar por nombre. En ese caso se
// cae a la posición ordinal entre pistas de audio: sí es consistente
// entre tracks.audio y el manifiesto/audioTracks del reproductor, porque
// ambos se derivan del mismo análisis del archivo en el mismo orden.
function findAudioTrackPosition(list, wantedTrack, ordinalPosition) {
  if (!list) return -1;
  const byLanguage = findByLanguage(list, wantedTrack?.language);
  if (byLanguage >= 0) return byLanguage;
  if (ordinalPosition != null && ordinalPosition >= 0 && ordinalPosition < list.length) return ordinalPosition;
  return -1;
}

function formatRemaining(progress) {
  if (!progress || !progress.percent) return null;
  const { percent, elapsedMs } = progress;
  const totalEstimate = elapsedMs / (percent / 100);
  const remainingSec = Math.max(0, Math.round((totalEstimate - elapsedMs) / 1000));
  if (remainingSec < 60) return `~${remainingSec}s restantes`;
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  return `~${minutes}m ${seconds}s restantes`;
}

export default function WatchPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [video, setVideo] = useState(null);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [prepProgress, setPrepProgress] = useState(null);
  const [tracks, setTracks] = useState({ audio: [], subtitles: [] });
  const [audioIndex, setAudioIndex] = useState(null);
  const [playbackKey, setPlaybackKey] = useState(0);
  const [stuck, setStuck] = useState(false);
  const [prevEpisodeId, setPrevEpisodeId] = useState(null);
  const [nextEpisodeId, setNextEpisodeId] = useState(null);
  const [autoAdvanceIn, setAutoAdvanceIn] = useState(null);
  const [subtitlePrefs, setSubtitlePrefs] = useState(DEFAULT_SUBTITLE_PREFS);
  const playerRef = useRef(null);
  const hlsRef = useRef(null);
  const shellRef = useRef(null);
  const resumeTimeRef = useRef(null);
  const savedProgressRef = useRef(null);
  const profileId = getActiveProfileId();

  useEffect(() => {
    fetchSubtitlePrefs(profileId).then(setSubtitlePrefs);
  }, [profileId]);

  const handleSubtitlePrefsChange = (patch) => {
    setSubtitlePrefs((prev) => {
      const next = { ...prev, ...patch };
      saveSubtitlePrefs(profileId, patch);
      return next;
    });
  };

  // Tras descargar un subtítulo de SubDL hace falta volver a pedir
  // /api/tracks (ya lo incluirá) para que aparezca en el selector - se
  // reutiliza tanto al cargar la página como después de una descarga.
  const reloadTracks = () =>
    fetch(`/api/tracks/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((t) => t && setTracks(t))
      .catch(() => {});

  useEffect(() => {
    fetch('/api/videos')
      .then((res) => res.json())
      .then((videos) => {
        const found = videos.find((v) => v.id === id);
        if (!found) {
          setError('El vídeo solicitado no existe en el catálogo.');
          return;
        }
        setVideo(found);
        document.title = `${found.title} - Videoclub Local`;
      })
      .catch(() => setError('No se pudo cargar el catálogo.'));

    fetch(`/api/tracks/${id}`)
      .then((res) => {
        // Un 500 (p.ej. no se pudo analizar el archivo) también trae un
        // cuerpo JSON válido ({ error: "..." }), así que sin este chequeo
        // se leía como si fuera { audio, subtitles } de verdad y rompía la
        // página entera al intentar recorrer "audio" (undefined).
        if (!res.ok) throw new Error('tracks no disponibles');
        return res.json();
      })
      .then((t) => setTracks(t))
      .catch(() => {});

    savedProgressRef.current = null;
    if (profileId) {
      fetch(progressUrl(profileId, id))
        .then((res) => res.json())
        .then((data) => {
          savedProgressRef.current = data;
        })
        .catch(() => {});
    }

    setAutoAdvanceIn(null);
    // El idioma preferido (audio/subtítulos) se vuelve a aplicar en cuanto
    // lleguen las pistas de este vídeo, ver el efecto de abajo - aquí solo
    // se limpia el de la posición del vídeo anterior, que ya no vale (los
    // índices de pista no coinciden entre archivos).
    setAudioIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Aplica el idioma de audio elegido la última vez (guardado por perfil,
  // no por dispositivo: mismo criterio que el aspecto de los subtítulos) en
  // cuanto se sabe qué pistas trae este vídeo en concreto - se busca por
  // idioma, no por posición, porque el orden de pistas no tiene por qué
  // coincidir entre archivos. Si el archivo no trae idioma real en el
  // contenedor (ediciones de fans, solo "título": "Castellano"/"Japones
  // Flac"...), se cae al título - no sirve entre TODOS los archivos, pero
  // sí es habitual que coincida el texto entre varios de una misma serie.
  useEffect(() => {
    const lang = subtitlePrefs.audioLanguage;
    const title = subtitlePrefs.audioTitle;
    if ((!lang && !title) || tracks.audio.length === 0) return;
    const match = (lang && tracks.audio.find((t) => t.language === lang)) || (title && tracks.audio.find((t) => t.title === title));
    if (match) setAudioIndex(match.index);
  }, [id, tracks.audio, subtitlePrefs.audioLanguage, subtitlePrefs.audioTitle]);

  useEffect(() => {
    if (!video?.seriesKey) {
      setPrevEpisodeId(null);
      setNextEpisodeId(null);
      return;
    }
    fetch(`/api/videos/browse?dir=${encodeURIComponent(video.seriesKey)}`)
      .then((res) => res.json())
      .then((data) => {
        const list = data.videos || [];
        const idx = list.findIndex((v) => v.id === id);
        setPrevEpisodeId(idx > 0 ? list[idx - 1].id : null);
        setNextEpisodeId(idx >= 0 && idx < list.length - 1 ? list[idx + 1].id : null);
      })
      .catch(() => {
        setPrevEpisodeId(null);
        setNextEpisodeId(null);
      });
  }, [video, id]);

  useEffect(() => {
    if (autoAdvanceIn == null) return undefined;
    if (autoAdvanceIn <= 0) {
      navigate(`/watch/${nextEpisodeId}`);
      return undefined;
    }
    const timer = setTimeout(() => setAutoAdvanceIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [autoAdvanceIn, nextEpisodeId, navigate]);

  useEffect(() => {
    if (!video) return undefined;
    let cancelled = false;
    let timer;
    setReady(false);
    setPrepProgress(null);

    // HLS (server/hls.js): no depende de audioIndex, todas las pistas de
    // audio van en el mismo manifiesto, se elige luego sin recargar.
    const streamUrl = `/api/hls/${id}/status`;

    const checkStatus = () => {
      fetch(streamUrl)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.status === 'ready' || data.status === 'compatible') {
            setReady(true);
          } else if (data.status === 'failed') {
            setError('No se pudo preparar este vídeo para reproducirlo.');
          } else {
            setPrepProgress(data.progress || null);
            timer = setTimeout(checkStatus, 2000);
          }
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(checkStatus, 3000);
        });
    };

    checkStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [video, id, audioIndex]);

  useEffect(() => {
    if (ready && video) track('play_start', { videoId: id, title: video.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, id]);

  // Conecta hls.js al <video>: sustituye al <video src=...> directo.
  // Chrome/Firefox necesitan hls.js; Safari reproduce HLS de forma nativa,
  // sin librería. El cambio de pista de audio (handleAudioChange) usa la
  // API de pistas de hls.js en vez de cambiar el src, así no hay recarga
  // ni se pierde la posición.
  useEffect(() => {
    const player = playerRef.current;
    if (!video || !ready || !player) return undefined;

    const masterUrl = `/api/hls/${id}/master.m3u8`;

    if (Hls.isSupported()) {
      // Por defecto hls.js precarga tan por delante como la red permita
      // (hasta 600s / ~60MB) - con una red local rápida y un archivo pesado
      // (BD 1080p), eso llena el SourceBuffer del navegador en pocos
      // segundos de verdad reproducidos, mucho antes de que la posición
      // avance lo suficiente para poder liberar espacio. El resultado
      // ("SourceBuffer is full") es un error no fatal que hls.js sabe
      // recuperar solo para que el vídeo no se corte, pero como efecto
      // colateral reinicia también la pista de audio a la de por defecto -
      // dando la sensación de que cambiar de idioma "no hacía nada" en
      // archivos grandes. Un margen de precarga más conservador evita
      // llegar a ese límite sin perder fluidez real.
      const instance = new Hls({ maxBufferLength: 60, maxMaxBufferLength: 90 });
      hlsRef.current = instance;
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) console.warn(`hls.js FATAL (${data.type}): ${data.details}`);
      });
      // Si el idioma preferido (guardado de otro episodio) no es el que
      // trae por defecto este archivo, se aplica en cuanto se conocen las
      // pistas reales - así el primer episodio que se abre ya suena en el
      // idioma guardado, no solo los siguientes cambios. AUDIO_TRACKS_UPDATED,
      // no MANIFEST_PARSED: verificado en directo que en el momento exacto
      // de MANIFEST_PARSED "instance.audioTracks" todavía puede estar vacío
      // (hls.js lo rellena en un paso posterior), así que la búsqueda por
      // idioma fallaba siempre en silencio (position=-1) y se quedaba con
      // la pista por defecto sin que nada avisara del fallo.
      instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        if (audioIndex == null) return;
        const wanted = tracks.audio.find((t) => t.index === audioIndex);
        const ordinal = tracks.audio.findIndex((t) => t.index === audioIndex);
        const position = findAudioTrackPosition(instance.audioTracks, wanted, ordinal);
        if (position >= 0 && instance.audioTrack !== position) instance.audioTrack = position;
      });
      instance.loadSource(masterUrl);
      instance.attachMedia(player);
      return () => {
        instance.destroy();
        if (hlsRef.current === instance) hlsRef.current = null;
      };
    }

    if (player.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari: soporte nativo, sin hls.js. El cambio de pista de audio en
      // Safari usa player.audioTracks (ver handleAudioChange) en vez de la
      // API de hls.js.
      player.src = masterUrl;
      if (audioIndex != null) {
        const wanted = tracks.audio.find((t) => t.index === audioIndex);
        const ordinal = tracks.audio.findIndex((t) => t.index === audioIndex);
        const onLoadedMeta = () => {
          const position = findAudioTrackPosition(player.audioTracks, wanted, ordinal);
          if (position >= 0 && player.audioTracks) {
            for (let i = 0; i < player.audioTracks.length; i += 1) {
              player.audioTracks[i].enabled = i === position;
            }
          }
        };
        player.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
        return () => player.removeEventListener('loadedmetadata', onLoadedMeta);
      }
      return undefined;
    }

    setError('Este navegador no puede reproducir vídeo HLS.');
    return undefined;
  }, [video, ready, id, playbackKey]);

  useEffect(() => {
    const player = playerRef.current;
    if (!video || !ready || !player) return undefined;

    const onLoadedMetadata = () => {
      const saved = savedProgressRef.current;
      if (resumeTimeRef.current != null) {
        player.currentTime = resumeTimeRef.current;
        resumeTimeRef.current = null;
      } else if (saved && saved.ratio < 0.95) {
        player.currentTime = saved.time;
      }
    };
    const onPause = () => saveProgress(profileId, id, player);
    const onEnded = () => {
      if (profileId) {
        fetch(progressUrl(profileId, id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ time: 0, ratio: 1 }),
        }).catch(() => {});
      }
      track('play_complete', { videoId: id, title: video.title });
      if (nextEpisodeId) {
        setAutoAdvanceIn(5);
      }
    };

    // Si la reproducción se queda esperando datos, se reintenta sola una vez
    // (útil para cortes de red puntuales); si vuelve a atascarse, se ofrece
    // el botón manual en vez de reintentar en bucle sin avisar.
    let stallTimer;
    let autoRetried = false;
    const doRetry = () => {
      resumeTimeRef.current = player.currentTime;
      setPlaybackKey((k) => k + 1);
    };
    const onWaiting = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!autoRetried) {
          autoRetried = true;
          doRetry();
        } else {
          setStuck(true);
          track('stall', { videoId: id, title: video.title });
        }
      }, 15000);
    };
    const clearStall = () => {
      clearTimeout(stallTimer);
      setStuck(false);
    };
    const onError = () => {
      track('play_error', { videoId: id, title: video.title });
      if (!autoRetried) {
        autoRetried = true;
        doRetry();
      } else {
        setStuck(true);
      }
    };

    player.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    player.addEventListener('waiting', onWaiting);
    player.addEventListener('playing', clearStall);
    player.addEventListener('timeupdate', clearStall);
    player.addEventListener('error', onError);

    const interval = setInterval(() => saveProgress(profileId, id, player), 5000);
    const onBeforeUnload = () => saveProgressOnUnload(profileId, id, player);
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      player.removeEventListener('loadedmetadata', onLoadedMetadata);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      player.removeEventListener('waiting', onWaiting);
      player.removeEventListener('playing', clearStall);
      player.removeEventListener('timeupdate', clearStall);
      player.removeEventListener('error', onError);
      window.removeEventListener('beforeunload', onBeforeUnload);
      clearInterval(interval);
      clearTimeout(stallTimer);
      saveProgress(profileId, id, player);
    };
  }, [video, ready, id, playbackKey, nextEpisodeId, profileId]);

  const handleAudioChange = (e) => {
    const value = e.target.value;
    const newIndex = value === '' ? null : Number(value);

    // Se recuerda por idioma (no por índice) y por perfil (no por
    // dispositivo), para aplicarlo en el siguiente episodio/vídeo que se
    // abra en cualquier aparato con este mismo perfil.
    const chosenTrack = tracks.audio.find((t) => t.index === newIndex);
    handleSubtitlePrefsChange({ audioLanguage: chosenTrack?.language || null, audioTitle: chosenTrack?.title || null });

    // El cambio "en caliente" (hls.audioTrack = posición, sin recargar
    // nada) resultó NO ser fiable en la práctica - verificado en directo:
    // la pista pedida por red y la seleccionada en hls.js eran las
    // correctas, pero el sonido seguía siendo el de la pista anterior. En
    // vez de perseguir ese fallo de hls.js/el navegador, se fuerza una
    // recarga completa del reproductor (mismo mecanismo que la recuperación
    // ante un corte, ver retryPlayback) con la posición actual guardada: la
    // ruta de "carga inicial con idioma preferido" (ver MANIFEST_PARSED más
    // abajo) sí aplica bien la pista desde el principio.
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setAudioIndex(newIndex);
    setPlaybackKey((k) => k + 1);
  };

  const retryPlayback = () => {
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setStuck(false);
    setPlaybackKey((k) => k + 1);
  };

  const backTo = video?.seriesKey ? `/?dir=${encodeURIComponent(video.seriesKey)}` : '/';
  const backLabel = video?.seriesKey ? '← Volver a episodios' : '← Volver al catálogo';

  // La cabecera fija solo hace falta mientras no hay reproductor todavía
  // (cargando/preparando/error): en cuanto hay vídeo listo, todo eso pasa a
  // vivir dentro del reproductor como una barra superior que aparece y
  // desaparece con el resto de controles (estilo Netflix/Prime), no una
  // cabecera aparte siempre visible.
  const showFixedHeader = !ready || error;

  return (
    <>
      {showFixedHeader && (
        <div className="watch-header">
          <Link className="back-link" to={backTo}>
            {backLabel}
          </Link>
          <h1 className="watch-title">{error ? 'Error' : video ? video.title : 'Cargando...'}</h1>
          {(prevEpisodeId || nextEpisodeId) && (
            <div className="episode-nav">
              <button disabled={!prevEpisodeId} onClick={() => navigate(`/watch/${prevEpisodeId}`)}>
                ← Anterior
              </button>
              <button disabled={!nextEpisodeId} onClick={() => navigate(`/watch/${nextEpisodeId}`)}>
                Siguiente →
              </button>
            </div>
          )}
          {tracks.audio.length > 1 && (
            <select className="track-select" value={audioIndex ?? ''} onChange={handleAudioChange}>
              {tracks.audio.map((track) => (
                <option key={track.index} value={track.index}>
                  Audio: {trackLabel(track)}
                </option>
              ))}
            </select>
          )}
          <HiddenMenu />
        </div>
      )}
      <div className="player-wrap">
        {error && <div className="error-box">{error}</div>}
        {!error && video && !ready && (
          <div className="prep-box">
            <div className="spinner" />
            <p>Preparando vídeo para este dispositivo...</p>
            {prepProgress?.percent != null ? (
              <>
                <div className="prep-bar">
                  <div style={{ width: `${prepProgress.percent}%` }} />
                </div>
                <p className="prep-detail">
                  {prepProgress.percent}%{formatRemaining(prepProgress) ? ` · ${formatRemaining(prepProgress)}` : ''}
                </p>
              </>
            ) : (
              <p className="prep-detail">Analizando el vídeo, puede tardar unos minutos la primera vez...</p>
            )}
          </div>
        )}
        {!error && video && ready && (
          <div className="player-column player-column-fill">
            <div className="player-shell" ref={shellRef}>
              {/* Los subtítulos nativos (<track>) los pinta el propio
                  navegador vía el pseudo-elemento ::cue - no hay otra forma
                  de darle tamaño/color propios que con CSS scopeado así. */}
              <style>{`
                .player-shell video::cue {
                  font-size: ${SUBTITLE_SIZE_EM[subtitlePrefs.size] ?? SUBTITLE_SIZE_EM.medium}em;
                  color: ${subtitlePrefs.color};
                  background-color: ${SUBTITLE_BG_COLOR[subtitlePrefs.background] ?? SUBTITLE_BG_COLOR.semi};
                }
              `}</style>
              <video
                key={playbackKey}
                ref={playerRef}
                autoPlay
                playsInline
                onClick={(e) => (e.currentTarget.paused ? e.currentTarget.play() : e.currentTarget.pause())}
              >
                {tracks.subtitles.map((track) => (
                  <track
                    key={track.index}
                    kind="subtitles"
                    src={`/api/subtitle/${id}/${track.index}`}
                    srcLang={track.language || 'und'}
                    label={trackLabel(track)}
                  />
                ))}
              </video>
              <VideoControls
                key={playbackKey}
                videoRef={playerRef}
                shellRef={shellRef}
                id={id}
                subtitleTracks={tracks.subtitles}
                title={video?.title}
                backTo={backTo}
                backLabel={backLabel}
                prevEpisodeId={prevEpisodeId}
                nextEpisodeId={nextEpisodeId}
                onNavigate={navigate}
                audioTracks={tracks.audio}
                audioIndex={audioIndex}
                onAudioChange={handleAudioChange}
                subtitlePrefs={subtitlePrefs}
                onSubtitlePrefsChange={handleSubtitlePrefsChange}
                onSubtitlesDownloaded={reloadTracks}
                initialSubtitleLanguage={subtitlePrefs.subtitleLanguage}
                initialSubtitleTitle={subtitlePrefs.subtitleTitle}
                onSubtitleLanguageChange={(track) =>
                  handleSubtitlePrefsChange({ subtitleLanguage: track?.language || null, subtitleTitle: track?.title || null })
                }
              />
            </div>
            {stuck && (
              <div className="stall-banner">
                <span>La reproducción parece atascada.</span>
                <button onClick={retryPlayback}>Reintentar</button>
              </div>
            )}
            {autoAdvanceIn != null && (
              <div className="stall-banner">
                <span>Siguiente episodio en {autoAdvanceIn}s...</span>
                <button onClick={() => navigate(`/watch/${nextEpisodeId}`)}>Reproducir ahora</button>
                <button className="secondary" onClick={() => setAutoAdvanceIn(null)}>
                  Cancelar
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
