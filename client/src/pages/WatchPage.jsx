import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Hls from 'hls.js';
import VideoControls from '../components/VideoControls';
import { getActiveProfileId } from '../profile';
import { getPreferredAudioLanguage, setPreferredAudioLanguage } from '../audioPreference';
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
  const [rawMode, setRawMode] = useState(false);
  const playerRef = useRef(null);
  const hlsRef = useRef(null);
  const shellRef = useRef(null);
  const resumeTimeRef = useRef(null);
  const savedProgressRef = useRef(null);
  const profileId = getActiveProfileId();

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
      .then((res) => res.json())
      .then((t) => {
        setTracks(t);
        // Aplica el idioma elegido la última vez (en otro episodio/vídeo,
        // los índices de pista no tienen por qué coincidir entre archivos,
        // así que se busca por idioma, no por índice) - si no hay uno
        // igual, se deja la pista por defecto del archivo.
        const preferredLang = getPreferredAudioLanguage();
        const match = preferredLang && t.audio.find((track) => track.language === preferredLang);
        setAudioIndex(match ? match.index : null);
      })
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
    setRawMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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

    // Modo normal: HLS (server/hls.js), no depende de audioIndex (todas las
    // pistas de audio van en el mismo manifiesto, se elige luego sin
    // recargar). Modo "sin convertir": pipeline antiguo, sí depende de la
    // pista de audio elegida (cada una es un remux aparte).
    let streamUrl;
    if (rawMode) {
      const params = new URLSearchParams();
      if (audioIndex != null) params.set('audio', audioIndex);
      params.set('raw', '1');
      streamUrl = `/api/stream/${id}/status?${params.toString()}`;
    } else {
      streamUrl = `/api/hls/${id}/status`;
    }

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
  }, [video, id, audioIndex, rawMode]);

  useEffect(() => {
    if (ready && video) track('play_start', { videoId: id, title: video.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, id]);

  // Conecta hls.js al <video> (modo normal, no "sin convertir"): sustituye
  // al <video src=...> directo. Chrome/Firefox necesitan hls.js; Safari
  // reproduce HLS de forma nativa, sin librería. El cambio de pista de
  // audio (handleAudioChange) usa la API de pistas de hls.js en vez de
  // cambiar el src, así no hay recarga ni se pierde la posición.
  useEffect(() => {
    const player = playerRef.current;
    if (!video || !ready || !player || rawMode) return undefined;

    const masterUrl = `/api/hls/${id}/master.m3u8`;

    if (Hls.isSupported()) {
      const instance = new Hls();
      hlsRef.current = instance;
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) console.warn(`hls.js: error fatal (${data.type}): ${data.details}`);
      });
      // Si el idioma preferido (guardado de otro episodio) no es el que
      // trae por defecto este archivo, se aplica en cuanto se conocen las
      // pistas reales del manifiesto - así el primer episodio que se abre
      // ya suena en el idioma guardado, no solo los siguientes cambios.
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (audioIndex == null) return;
        const position = tracks.audio.findIndex((t) => t.index === audioIndex);
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
        const position = tracks.audio.findIndex((t) => t.index === audioIndex);
        const onLoadedMeta = () => {
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
  }, [video, ready, id, playbackKey, rawMode]);

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

    // Se recuerda por idioma (no por índice) para aplicarlo solo al
    // siguiente episodio/vídeo que se abra.
    const chosenTrack = tracks.audio.find((t) => t.index === newIndex);
    setPreferredAudioLanguage(chosenTrack?.language || null);

    // Modo normal (HLS): cambia de pista sin recargar el vídeo ni perder la
    // posición, usando la API de pistas del reproductor en marcha.
    if (!rawMode) {
      const position = tracks.audio.findIndex((t) => t.index === newIndex);
      if (position >= 0) {
        if (hlsRef.current) {
          hlsRef.current.audioTrack = position;
        } else if (playerRef.current?.audioTracks) {
          // Safari nativo: sin hls.js, la selección va por audioTracks.
          for (let i = 0; i < playerRef.current.audioTracks.length; i += 1) {
            playerRef.current.audioTracks[i].enabled = i === position;
          }
        }
      }
      setAudioIndex(newIndex);
      return;
    }

    // Modo "sin convertir" (pipeline antiguo): cada pista es un archivo
    // remuxado aparte, así que sí hace falta recargar.
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setAudioIndex(newIndex);
  };

  const retryPlayback = () => {
    const player = playerRef.current;
    resumeTimeRef.current = player ? player.currentTime : null;
    setStuck(false);
    setPlaybackKey((k) => k + 1);
  };

  const streamParams = new URLSearchParams();
  if (audioIndex != null) streamParams.set('audio', audioIndex);
  if (rawMode) streamParams.set('raw', '1');
  const streamQuery = streamParams.toString();
  const streamSrc = `/api/stream/${id}${streamQuery ? `?${streamQuery}` : ''}`;
  const backTo = video?.seriesKey ? `/?dir=${encodeURIComponent(video.seriesKey)}` : '/';
  const backLabel = video?.seriesKey ? '← Volver a episodios' : '← Volver al catálogo';

  return (
    <>
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
      </div>
      <div className="player-wrap">
        {error && <div className="error-box">{error}</div>}
        {!error && video && !ready && (
          <div className="prep-box">
            <div className="spinner" />
            <p>{rawMode ? 'Cambiando de idioma...' : 'Preparando vídeo para este dispositivo...'}</p>
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
              <p className="prep-detail">
                {rawMode
                  ? 'Preparando esa pista de audio, no hace falta convertir el vídeo entero...'
                  : 'Analizando el vídeo, puede tardar unos minutos la primera vez...'}
              </p>
            )}
            {!rawMode && (
              <>
                <button className="raw-mode-btn" onClick={() => setRawMode(true)}>
                  Reproducir sin convertir
                </button>
                <p className="prep-detail">Formato original: puede no funcionar en este dispositivo/navegador.</p>
              </>
            )}
          </div>
        )}
        {!error && video && ready && (
          <div className="player-column">
            {rawMode && <p className="prep-detail">Reproduciendo en formato original (sin convertir).</p>}
            <div className="player-shell" ref={shellRef}>
              <video
                key={playbackKey}
                ref={playerRef}
                autoPlay
                playsInline
                src={rawMode ? streamSrc : undefined}
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
