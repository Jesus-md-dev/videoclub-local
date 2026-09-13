## Descripción

Inicializar el proyecto base en Node.js con Express, que servirá tanto la API como el frontend.

## Tareas

- Crear `package.json` con scripts `start` y `dev`.
- Instalar dependencias base: `express`.
- Estructura de carpetas inicial:
  - `server/` (código del backend)
  - `public/` (frontend estático)
  - `data/` (catálogo/caché generado, no versionado)
- Servidor mínimo que responda en `/health` con `200 OK`.

## Criterios de aceptación

- `npm start` levanta el servidor sin errores.
- `GET /health` responde `200`.
