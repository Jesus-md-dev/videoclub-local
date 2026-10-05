# videoclub-local

Videoclub casero (Node/Express + React/Vite) solo para la red local; nunca expuesto a internet (SECURITY.md). Se habla en español con el usuario y en los textos del proyecto.

## Dónde está cada cosa en este PC

- Vídeos: `E:\Videoclub`. Datos (perfiles, progreso, carátulas, trickplay, registros): `E:\VideoclubDatos` (`DATA_PATH`, se busca solo por nombre de carpeta). HLS: `E:\VideoclubHLS`. Originales ya trasladados: `D:\VideoclubOriginales`.
- `data-backup/` (en C:, dentro del proyecto): espejo de los datos + instantáneas diarias. No hay carpeta `data/` en el proyecto; si apareciera, es que E: no se encontró al arrancar.
- Logs: `server.log` y `server-error.log` en la raíz. Las líneas `[vigilante …]` son de `server/supervisor.js`.

## Estado del servidor: no preguntes, consulta

`curl -s http://127.0.0.1:3000/api/admin/status`: versión en marcha, cambios sin aplicar, reinicio programado y qué lo retiene, espacio libre de cada disco, colas de HLS y traslados, fallidos, última limpieza. Usa siempre `127.0.0.1`, no `localhost` (el servidor solo escucha en IPv4 y desde PowerShell `localhost` tarda ~2 s en caer a IPv4).

## Aplicar cambios sin pedir permiso para reiniciar

- El servidor corre bajo un vigilante (`iniciar.bat` → `server/supervisor.js`) que lo relanza si se cae o se cuelga.
- **Después de un commit no hace falta hacer nada**: en menos de un minuto `server/updater.js` lo detecta, recompila la web si cambió `client/` (sin reiniciar) y, si cambió el servidor, lo reinicia **cuando esté libre** (sin emisiones a la tele por Chromecast/DLNA, sin conversiones que alguien espera, sin traslados ni renombrados en curso; ver algo en la web o la APK no lo retiene: el reproductor reconecta solo). Comprueba con `/api/admin/status` que se aplicó (`updates.runningCommit`).
- Para forzarlo sin commit: `POST /api/admin/update` (body `{"pull": true}` para traer antes lo de GitHub) o `POST /api/admin/rebuild-client` (solo la web).
- Reiniciar: `POST /api/admin/restart` con `{"mode": "idle"}` (cuando esté libre; úsalo sin preguntar), `{"mode": "now"}` (corta lo que haya: solo si el usuario lo pide) o `{"mode": "cancel"}`.
- Si editas JSON de datos a mano: `POST /api/admin/reload` (recarga sin reiniciar).
- No mates procesos `node` sueltos ni lances una segunda instancia del servidor: renombraría archivos y generaría HLS a la vez que la buena. Si el servidor no está en marcha, arráncalo con `Start-Process iniciar.bat -ArgumentList silencioso`.

## Tareas automáticas (ya no hay que pedirlas)

Cada hora se comprueba si toca (una vez al día, aunque el PC se apague cada noche): normalizar nombres, refrescar TMDB, importar subtítulos sueltos, reintentar HLS y traslados fallidos (`maintenance-state.json`), y la limpieza de archivos sobrantes e instantáneas viejas (`cleanup-state.json`, `server/cleanup.js`). Al copiar vídeos a `E:\Videoclub` el watcher los encola solo.

## Reglas que no se negocian

- **Nunca borrar un archivo de vídeo original** (se perdieron ~180 episodios una vez, #97/#100). Para un vídeo de `hls-archived.json`, su carpeta HLS es la única copia.
- Cada feature o bug: issue en GitHub (`gh issue create`) + archivo en `C:/Users/jesus/Documents/Proyectos/issues-index/videoclub-local/` y fila en su `INDEX.md` (ver su AGENTS.md). Antes de depurar, buscar ahí: `python C:/Users/jesus/Documents/Proyectos/issues-index/similar_issues.py query "<error>"`.
- Commit y push siempre al terminar, con `Closes #N`.

## Trampas conocidas al editar

- Los `.bat` deben quedar con saltos CRLF. El repo guarda LF (`core.autocrlf=true`).
- Al reemplazar texto con Python, usa cadenas raw (`r'...'`) si contienen rutas de Windows: `'client\vite.config.js'` metió un tabulador vertical en `iniciar.bat` (#140).
- Capturas de la web: Edge headless (`msedge --headless=new --screenshot`). Para el ancho de móvil no sirve `--window-size=390` (Edge tiene un ancho mínimo): carga la página en un `<iframe>` de 390 px.
