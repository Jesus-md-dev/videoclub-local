import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { trackDeviceInfo } from './analytics'
import { setupTvMode } from './tvMode'
import { getActiveProfileId } from './profile'

// Perfil activo en cada petición a la API: el servidor deja hacer las
// acciones de administrador solo a perfiles admin (#152, adminGuard.js).
const originalFetch = window.fetch.bind(window)
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || ''
  const profileId = getActiveProfileId()
  if (!profileId || !url.startsWith('/api/')) return originalFetch(input, init)
  const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers))
  headers.set('X-Profile-Id', profileId)
  return originalFetch(input, { ...init, headers })
}

trackDeviceInfo()
setupTvMode()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
