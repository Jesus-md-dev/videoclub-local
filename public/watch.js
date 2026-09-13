const titleEl = document.getElementById('title');
const content = document.getElementById('content');

const params = new URLSearchParams(window.location.search);
const id = params.get('id');

function showError(message) {
  titleEl.textContent = 'Error';
  content.innerHTML = `<div class="error-box"><p>${message}</p></div>`;
}

function progressKey(videoId) {
  return `progress:${videoId}`;
}

function saveProgress(videoId, video) {
  if (!video.duration) return;
  const ratio = video.currentTime / video.duration;
  localStorage.setItem(
    progressKey(videoId),
    JSON.stringify({ time: video.currentTime, ratio, updatedAt: Date.now() })
  );
}

function loadProgress(videoId) {
  try {
    const raw = localStorage.getItem(progressKey(videoId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

if (!id) {
  showError('No se ha especificado ningún vídeo.');
} else {
  fetch('/api/videos')
    .then((res) => res.json())
    .then((videos) => {
      const video = videos.find((v) => v.id === id);
      if (!video) {
        showError('El vídeo solicitado no existe en el catálogo.');
        return;
      }

      titleEl.textContent = video.title;
      document.title = `${video.title} - Videoclub Local`;

      const player = document.createElement('video');
      player.controls = true;
      player.autoplay = true;
      player.src = `/api/stream/${id}`;
      content.appendChild(player);

      const saved = loadProgress(id);
      if (saved && saved.ratio < 0.95) {
        player.addEventListener('loadedmetadata', () => {
          player.currentTime = saved.time;
        }, { once: true });
      }

      let saveTimer = setInterval(() => saveProgress(id, player), 5000);
      player.addEventListener('pause', () => saveProgress(id, player));
      player.addEventListener('ended', () => {
        localStorage.setItem(
          progressKey(id),
          JSON.stringify({ time: 0, ratio: 1, updatedAt: Date.now() })
        );
      });
      window.addEventListener('beforeunload', () => {
        clearInterval(saveTimer);
        saveProgress(id, player);
      });
    })
    .catch(() => showError('No se pudo cargar el catálogo.'));
}
