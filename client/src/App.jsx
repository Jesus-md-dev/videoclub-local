import { Routes, Route, Navigate } from 'react-router-dom';
import CatalogPage from './pages/CatalogPage';
import WatchPage from './pages/WatchPage';
import ConfigPage from './pages/ConfigPage';
import ProfilesPage from './pages/ProfilesPage';
import QueuePage from './pages/QueuePage';
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
    </Routes>
  );
}
