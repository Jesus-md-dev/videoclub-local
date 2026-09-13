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

Esto también instala las dependencias del frontend en `client/` (vía `postinstall`).

## Configuración

La carpeta de vídeos se puede fijar de dos formas:

- **Desde la web** (recomendado): entra en `/config` (página sin enlace visible desde el catálogo) y usa el campo de texto o el botón "Examinar..." para elegirla. Se guarda en `data/settings.json` y no requiere reiniciar el servidor.
- **Por variable de entorno** (solo se usa si no hay nada guardado en `/config`): copia `.env.example` a `.env` y ajusta:

```bash
cp .env.example .env
```

| Variable | Descripción | Ejemplo |
|---|---|---|
| `VIDEOS_PATH` | Ruta absoluta a la carpeta con los vídeos a servir | `C:\Users\tu_usuario\Videos` |
| `PORT` | Puerto en el que escucha el servidor | `3000` |

## Arranque

El frontend (React) hay que compilarlo antes de arrancar el servidor:

```bash
npm run build
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

- Frontend en React (Vite), servido como estático desde Express (`client/dist`).
- Escaneo recursivo de la carpeta de vídeos configurada, al arrancar y cada vez que se cambia desde `/config`.
- Catálogo en cuadrícula con carátulas generadas automáticamente a partir de un fotograma del vídeo.
- Buscador para filtrar el catálogo por título.
- Reproductor con soporte de salto en la barra de progreso (streaming por rangos de bytes).
- "Continuar viendo": recuerda el punto de reproducción de cada vídeo (guardado en el navegador).
- Página de configuración oculta (`/config`) con explorador de carpetas para elegir la carpeta de vídeos sin escribir la ruta a mano.
- Navegación por carpetas (secciones "Series"/"Películas"), con carátula de carpeta = primer vídeo dentro.
- Categorías/géneros automáticos por título (TVmaze, Jikan/MyAnimeList y Wikidata; sin API key) con filtro por género en el catálogo. Cachea los resultados en `data/metadata.json`; si un título no se encuentra, simplemente no muestra género, sin errores.
- Selector de pista de audio y subtítulos (extraídos a WebVTT bajo demanda) en el reproductor.
- Conversión automática bajo demanda a H.264/MP4 para vídeos con códecs no compatibles con navegadores móviles (p.ej. HEVC en `.mkv`).
- `POST /api/scan` para volver a escanear la carpeta sin reiniciar el servidor.

## Desarrollo

Para trabajar en el frontend con recarga en caliente:

```bash
npm start            # backend en el puerto 3000
cd client && npm run dev   # frontend en modo desarrollo (proxy a /api hacia el puerto 3000)
```

## Aviso de seguridad

Esta aplicación **no tiene autenticación** ni está pensada para exponerse a Internet. Solo debe usarse dentro de una red local de confianza (tu propia red doméstica).
