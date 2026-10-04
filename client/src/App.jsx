import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import CatalogPage from './pages/CatalogPage';
import WatchPage from './pages/WatchPage';
import ConfigPage from './pages/ConfigPage';
import ProfilesPage from './pages/ProfilesPage';
import QueuePage from './pages/QueuePage';
import MoveQueuePage from './pages/MoveQueuePage';
import StatsPage from './pages/StatsPage';
import { getActiveProfileId, isProfileChosenThisSession } from './profile';
import { useTvFocus } from './tvMode';

function RequireProfile({ children }) {
  const location = useLocation();
  if (!getActiveProfileId() || !isProfileChosenThisSession()) {
    // Tras elegir, se sigue a donde se iba (p.ej. un enlace a un vídeo).
    return <Navigate to="/profiles" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

export default function App() {
  useTvFocus();
  return (
    <Routes>
      <Route path="/profiles" element={<ProfilesPage />} />
      <Route
        path="/"
        element={
          <RequireProfile>
            <CatalogPage />
          </RequireProfile>
        }
      />
      <Route
        path="/watch/:id"
        element={
          <RequireProfile>
            <WatchPage />
          </RequireProfile>
        }
      />
      <Route path="/config" element={<ConfigPage />} />
      <Route path="/queue" element={<QueuePage />} />
      <Route path="/move-queue" element={<MoveQueuePage />} />
      <Route path="/stats" element={<StatsPage />} />
      {/* Cualquier ruta no reconocida: antes se quedaba en blanco (React
          Router no tenía ninguna coincidencia ni fallback). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
