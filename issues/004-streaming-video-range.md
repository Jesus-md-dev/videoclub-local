## Descripción

Implementar el endpoint que sirve el contenido de vídeo con soporte de peticiones `Range`, imprescindible para poder reproducir y avanzar/retroceder sin descargar el archivo completo.

## Tareas

- `GET /api/stream/:id` (o por ruta codificada) que localice el archivo correspondiente en `VIDEOS_PATH`.
- Soporte de cabecera `Range` devolviendo `206 Partial Content` con `Content-Range`, `Accept-Ranges` y `Content-Length` correctos.
- Content-Type adecuado según extensión del archivo.
- Validar que la ruta solicitada no permite salir de `VIDEOS_PATH` (evitar path traversal).

## Criterios de aceptación

- El vídeo se reproduce correctamente en un `<video>` HTML5 y permite saltar a cualquier punto de la barra de progreso.
- Una petición con `Range` recibe `206` y el rango correcto de bytes.
- Peticiones con rutas manipuladas (`../../`) devuelven error controlado, no acceden a archivos fuera de `VIDEOS_PATH`.
