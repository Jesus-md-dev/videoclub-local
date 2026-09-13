const grid = document.getElementById('grid');
const emptyState = document.getElementById('empty');
const searchInput = document.getElementById('search');

let videos = [];

function progressFor(id) {
  try {
    const raw = localStorage.getItem(`progress:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function renderGrid(list) {
  grid.innerHTML = '';
  emptyState.hidden = list.length !== 0;

  for (const video of list) {
    const progress = progressFor(video.id);
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `watch.html?id=${video.id}`;

    const badge = progress && progress.ratio < 0.95
      ? `<span class="badge">Continuar</span>`
      : '';

    const progressBar = progress && progress.ratio < 0.95
      ? `<div class="progress-bar"><div style="width:${Math.round(progress.ratio * 100)}%"></div></div>`
      : '';

    card.innerHTML = `
      ${badge}
      <img class="poster" src="/api/thumbnail/${video.id}" alt="${video.title}" loading="lazy"
        onerror="this.onerror=null;this.src='placeholder.svg'" />
      ${progressBar}
      <div class="card-info">
        <p class="card-title">${video.title}</p>
      </div>
    `;
    grid.appendChild(card);
  }
}

function applyFilter() {
  const term = searchInput.value.trim().toLowerCase();
  const filtered = term
    ? videos.filter((video) => video.title.toLowerCase().includes(term))
    : videos;
  renderGrid(filtered);
}

searchInput.addEventListener('input', applyFilter);

fetch('/api/videos')
  .then((res) => res.json())
  .then((data) => {
    videos = data;
    renderGrid(videos);
  })
  .catch(() => {
    grid.innerHTML = '';
    emptyState.hidden = false;
    emptyState.textContent = 'No se pudo cargar el catálogo.';
  });
