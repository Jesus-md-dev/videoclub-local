// Antes duplicado letra por letra en QueuePage.jsx y MoveQueuePage.jsx.
export function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

// "Bleach - S06E15" -> "Bleach - S06E15 · Cap. 124": el número del episodio
// contado desde el principio de la serie, si el servidor lo conoce (ver
// server/episodeNumbers.js).
export function episodeTitle(video) {
  return video.absoluteEpisode != null ? `${video.title} · Cap. ${video.absoluteEpisode}` : video.title;
}
