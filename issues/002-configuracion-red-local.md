## Descripción

Configurar la aplicación para que solo sea accesible desde la red local (LAN), y para que la carpeta de vídeos y el puerto sean configurables.

## Tareas

- Añadir soporte de variables de entorno (`.env` + `dotenv`):
  - `VIDEOS_PATH`: ruta absoluta a la carpeta de vídeos.
  - `PORT`: puerto de escucha (por defecto `3000`).
- El servidor debe hacer `listen` en `0.0.0.0` (no solo `localhost`) para ser accesible desde otros dispositivos de la LAN.
- Añadir `.env.example` documentando las variables.
- Al arrancar, loguear en consola la IP local y el puerto de acceso (ej. `http://192.168.1.x:3000`).

## Criterios de aceptación

- Cambiar `VIDEOS_PATH` y `PORT` en `.env` cambia el comportamiento sin tocar código.
- La app es accesible desde otro dispositivo de la misma red usando la IP local mostrada en consola.
