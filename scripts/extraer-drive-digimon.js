#!/usr/bin/env node
// Extrae los enlaces de Google Drive de los capítulos de una temporada en
// digimonespana.x10host.com. Cada página de episodio no tiene el enlace de
// Drive directo en el HTML: tiene un enlace corto (tiny.cc/...) dentro de un
// iframe con contenido "srcDoc" escapado, que al visitarlo redirige (303) al
// verdadero https://drive.google.com/file/d/<id>/preview. Este script:
//   1. Descarga la página de la temporada y saca la lista de episodios.
//   2. Descarga cada página de episodio y extrae título + enlace corto.
//   3. Resuelve cada enlace corto siguiendo la redirección (sin descargar
//      el vídeo: solo lee la cabecera Location).
//
// Uso:
//   node scripts/extraer-drive-digimon.js <url-de-la-temporada> [salida.csv]
//
// Ejemplo:
//   node scripts/extraer-drive-digimon.js https://digimonespana.x10host.com/temporadas/digimon-3-tamers/ digimon-tamers.csv

const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DigimonLinkExtractor/1.0';

function decodeHtmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// Sigue la redirección del enlace corto sin descargar el cuerpo (el destino
// es un vídeo/preview de Drive, no hace falta traerlo entero).
async function resolveRedirect(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const location = res.headers.get('location');
  if (location) return location;
  if (res.status >= 200 && res.status < 300) return url; // ya era la URL final
  throw new Error(`No se pudo resolver ${url} (HTTP ${res.status})`);
}

function episodeUrlsFromSeasonPage(html, seasonUrl) {
  const base = new URL(seasonUrl);
  const seasonPath = base.pathname.replace(/\/$/, '');
  const re = new RegExp(`href="(${seasonPath}/(\\d+))"`, 'g');
  const seen = new Set();
  const episodes = [];
  let m;
  while ((m = re.exec(html))) {
    const [, path, num] = m;
    if (seen.has(num)) continue;
    seen.add(num);
    episodes.push({ num, url: new URL(path, base).toString() });
  }
  episodes.sort((a, b) => Number(a.num) - Number(b.num));
  return episodes;
}

function extractTitleAndShortLink(html) {
  const titleMatch = html.match(/<article title="([^"]*)"[^>]*>\s*<span class="_iframeVideo/);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;

  const srcDocMatch = html.match(/srcDoc="([^"]*)"/);
  if (!srcDocMatch) return { title, shortLink: null };
  const decoded = decodeHtmlEntities(srcDocMatch[1]);
  const hrefMatch = decoded.match(/<a href=['"]([^'"]+)['"]/);
  return { title, shortLink: hrefMatch ? hrefMatch[1] : null };
}

function driveIdFromUrl(url) {
  const m = url && url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

async function main() {
  const seasonUrl = process.argv[2];
  const outFile = process.argv[3];
  if (!seasonUrl) {
    console.error('Uso: node extraer-drive-digimon.js <url-de-la-temporada> [salida.csv]');
    process.exit(1);
  }

  console.log(`Descargando lista de episodios: ${seasonUrl}`);
  const seasonHtml = await fetchText(seasonUrl);
  const episodes = episodeUrlsFromSeasonPage(seasonHtml, seasonUrl);
  console.log(`Encontrados ${episodes.length} episodios.`);

  const rows = [];
  for (const ep of episodes) {
    process.stdout.write(`  Episodio ${ep.num}... `);
    try {
      const html = await fetchText(ep.url);
      const { title, shortLink } = extractTitleAndShortLink(html);
      if (!shortLink) {
        console.log('sin enlace de vídeo, se omite.');
        rows.push({ num: ep.num, title: title || '', driveUrl: '', driveId: '', error: 'sin enlace' });
        continue;
      }
      const finalUrl = await resolveRedirect(shortLink);
      const driveId = driveIdFromUrl(finalUrl);
      console.log(driveId ? `OK (${driveId})` : `enlace no es de Drive: ${finalUrl}`);
      rows.push({
        num: ep.num,
        title: title || '',
        driveUrl: driveId ? `https://drive.google.com/file/d/${driveId}/view` : finalUrl,
        driveId: driveId || '',
        error: driveId ? '' : 'destino no es drive.google.com',
      });
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      rows.push({ num: ep.num, title: '', driveUrl: '', driveId: '', error: err.message });
    }
  }

  const csvLines = ['episodio,titulo,drive_url,drive_id,error'];
  for (const r of rows) {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    csvLines.push([r.num, esc(r.title), r.driveUrl, r.driveId, esc(r.error)].join(','));
  }
  const csv = csvLines.join('\n') + '\n';

  if (outFile) {
    fs.writeFileSync(outFile, csv, 'utf-8');
    console.log(`\nGuardado en ${outFile}`);
  } else {
    console.log('\n' + csv);
  }

  const failed = rows.filter((r) => r.error);
  if (failed.length) {
    console.log(`\n${failed.length} episodio(s) con problemas (revisar columna "error").`);
  }
}

main().catch((err) => {
  console.error(`Error fatal: ${err.message}`);
  process.exit(1);
});
