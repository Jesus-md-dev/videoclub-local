// Genera los recursos sintéticos de la demo pública (client/public/demo/):
// carátulas SVG inventadas y dos clips HLS de unos segundos (patrón de test
// de ffmpeg, sin contenido de nadie). Uso: node scripts/make-demo-assets.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const out = path.join(__dirname, '..', 'client', 'demo-assets');
fs.mkdirSync(path.join(out, 'posters'), { recursive: true });

const POSTERS = [
  ['movie-1', 'Demo Movie 1', '#e63946', '#1d3557'],
  ['movie-2', 'Demo Movie 2', '#2a9d8f', '#264653'],
  ['movie-3', 'Demo Movie 3', '#e9c46a', '#6a4c93'],
  ['movie-4', 'Demo Movie 4', '#457b9d', '#0c1a33'],
  ['movie-5', 'Demo Movie 5', '#f4a261', '#3d405b'],
  ['series', 'Demo Series', '#8338ec', '#10002b'],
];
for (const [name, title, a, b] of POSTERS) {
  const words = title.split(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="300" height="450" fill="url(#g)"/>
<circle cx="150" cy="170" r="70" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="6"/>
<path d="M130 135 L130 205 L190 170 Z" fill="#fff" fill-opacity=".85"/>
<text x="150" y="320" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff">${words[0]}</text>
<text x="150" y="362" text-anchor="middle" font-family="sans-serif" font-size="34" font-weight="700" fill="#fff">${words.slice(1).join(' ')}</text>
<text x="150" y="420" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#fff" fill-opacity=".7">fictional demo content</text>
</svg>`;
  fs.writeFileSync(path.join(out, 'posters', `${name}.svg`), svg);
}

const CLIPS = { a: 'testsrc2=size=480x270:rate=24', b: 'smptebars=size=480x270:rate=24' };
const FREQ = { a: 440, b: 330 };
for (const [name, src] of Object.entries(CLIPS)) {
  const dir = path.join(out, 'hls', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(ffmpeg, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `${src}:duration=12`,
    '-f', 'lavfi', '-i', `sine=frequency=${FREQ[name]}:duration=12`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 'seg%d.ts'),
    path.join(dir, 'master.m3u8'),
  ]);
}
console.log('Demo assets written to', out);
