## Descripción

Generar automáticamente una carátula (thumbnail) para cada vídeo, para que la interfaz tipo videoclub muestre portadas en vez de solo el nombre del archivo.

## Tareas

- Usar `ffmpeg` (vía `ffmpeg-static` + `fluent-ffmpeg`, o binario del sistema) para extraer un fotograma representativo (ej. segundo 10 o al 10% de la duración).
- Guardar las carátulas generadas en `data/thumbnails/` con nombre derivado del vídeo (hash o id).
- Generar carátulas de forma diferida (no bloquear el arranque): al escanear el catálogo, generar en segundo plano las que falten.
- Exponer `GET /api/thumbnail/:id` sirviendo la imagen (o directamente como estático desde `data/thumbnails/`).
- Carátula por defecto/placeholder mientras se genera o si ffmpeg falla para un archivo.

## Criterios de aceptación

- Cada vídeo del catálogo tiene una carátula asociada visible en la API.
- Si `ffmpeg` no está disponible o falla, la app sigue funcionando mostrando un placeholder, sin romper el resto del catálogo.
