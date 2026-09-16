import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // El registro lo hace el propio plugin al montar el bundle - no hace
      // falta código manual en el cliente para darlo de alta.
      registerType: 'autoUpdate',
      manifest: {
        name: 'Videoclub Local',
        short_name: 'Videoclub',
        description: 'Videoclub casero: streaming de la biblioteca personal en la red local.',
        lang: 'es',
        start_url: '/',
        id: '/',
        display: 'standalone',
        // Misma paleta "videoclub de barrio" que el resto de la web (ver
        // client/src/index.css).
        theme_color: '#0c1a33',
        background_color: '#0c1a33',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Solo el shell de la app (HTML/JS/CSS ya generados) se precachea.
        // El catálogo, el streaming (/api, /stream, HLS) y /cert quedan
        // fuera a propósito: el servidor ya sirve todo eso con
        // "Cache-Control: no-store" (ver server/index.js) para no arrastrar
        // datos desactualizados - un Service Worker cacheándolo por su
        // cuenta reintroduciría justo ese problema.
        navigateFallback: '/offline.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/cert$/],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
