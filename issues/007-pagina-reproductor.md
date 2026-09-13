## Descripción

Página de reproducción de un vídeo concreto, con reproductor HTML5 nativo apuntando al endpoint de streaming.

## Tareas

- Ruta `GET /watch/:id` (o `?id=`) que muestre un `<video controls>` apuntando a `GET /api/stream/:id`.
- Mostrar título del vídeo y botón de "volver al catálogo".
- Manejo de error si el `id` no existe (mensaje claro, no pantalla en blanco).

## Criterios de aceptación

- Desde el catálogo se puede abrir cualquier vídeo y reproducirlo con controles nativos (play/pausa, volumen, pantalla completa, barra de progreso).
- Un id inexistente muestra un mensaje de error legible.
