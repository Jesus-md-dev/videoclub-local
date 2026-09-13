## Descripción

Escanear la carpeta configurada (`VIDEOS_PATH`) y generar un catálogo de vídeos disponibles.

## Tareas

- Recorrer recursivamente `VIDEOS_PATH` buscando archivos con extensiones soportadas (`.mp4`, `.mkv`, `.avi`, `.webm`, ...).
- Por cada vídeo, extraer: nombre de archivo, título (limpiando el nombre), ruta relativa, tamaño, fecha de modificación.
- Exponer `GET /api/videos` devolviendo el catálogo en JSON.
- Cachear el resultado en memoria (o en `data/catalogo.json`) y refrescar cuando cambie la carpeta (endpoint manual `POST /api/scan` o revisión periódica simple).

## Criterios de aceptación

- `GET /api/videos` devuelve un array con todos los vídeos encontrados en `VIDEOS_PATH`.
- Añadir/quitar un archivo de la carpeta y volver a escanear refleja el cambio.
