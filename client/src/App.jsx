import { Routes, Route, Navigate } from 'react-router-dom';
import CatalogPage from './pages/CatalogPage';
import WatchPage from './pages/WatchPage';
import ConfigPage from './pages/ConfigPage';
import ProfilesPage from './pages/ProfilesPage';
import QueuePage from './pages/QueuePage';
import MoveQueuePage from './pages/MoveQueuePage';
import UpscaleQueuePage from './pages/UpscaleQueuePage';
import StatsPage from './pages/StatsPage';
import { getActiveProfileId } from './profile';

function RequireProfile({ children }) {
  if (!getActiveProfileId()) return <Navigate to="/profiles" replace />;
  return children;
}

export default function App() {
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
      <Route path="/upscale-queue" element={<UpscaleQueuePage />} />
      <Route path="/stats" element={<StatsPage />} />
      {/* Cualquier ruta no reconocida: antes se quedaba en blanco (React
          Router no tenía ninguna coincidencia ni fallback). */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
