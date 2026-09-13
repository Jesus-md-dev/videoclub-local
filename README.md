# Videoclub Local

Web local, accesible solo desde la red doméstica, para ver los vídeos de una carpeta concreta con una interfaz al estilo de un videoclub.

> El backlog de trabajo son los [issues de GitHub](https://github.com/Jesus-md-dev/videoclub-local/issues), replicados localmente en `Proyectos/issues-index/videoclub-local/`.

## Requisitos

- Node.js 18 o superior.
- No necesitas instalar `ffmpeg` aparte: se usa `ffmpeg-static`, que trae su propio binario para generar las carátulas.

## Instalación

```bash
npm install
```

## Configuración

Copia `.env.example` a `.env` y ajusta las variables:

```bash
cp .env.example .env
```

| Variable | Descripción | Ejemplo |
|---|---|---|
| `VIDEOS_PATH` | Ruta absoluta a la carpeta con los vídeos a servir | `C:\Users\tu_usuario\Videos` |
| `PORT` | Puerto en el que escucha el servidor | `3000` |

## Arranque

```bash
npm start
```

Al arrancar, la consola muestra las URLs de acceso, tanto local como desde la red:

```
Videoclub local escuchando en el puerto 3000
  Local:    http://localhost:3000
  Red:      http://192.168.1.X:3000
```

Desde cualquier otro dispositivo conectado a la misma red Wi-Fi/LAN, abre la URL de "Red" en el navegador.

## Funcionalidad

- Escaneo automático de `VIDEOS_PATH` (recursivo) al arrancar.
- Catálogo en cuadrícula con carátulas generadas automáticamente a partir de un fotograma del vídeo.
- Buscador para filtrar el catálogo por título.
- Reproductor con soporte de salto en la barra de progreso (streaming por rangos de bytes).
- "Continuar viendo": recuerda el punto de reproducción de cada vídeo (guardado en el navegador).
- `POST /api/scan` para volver a escanear la carpeta sin reiniciar el servidor.

## Aviso de seguridad

Esta aplicación **no tiene autenticación** ni está pensada para exponerse a Internet. Solo debe usarse dentro de una red local de confianza (tu propia red doméstica).
