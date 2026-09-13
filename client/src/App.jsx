import { Routes, Route } from 'react-router-dom';
import CatalogPage from './pages/CatalogPage';
import WatchPage from './pages/WatchPage';
import ConfigPage from './pages/ConfigPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<CatalogPage />} />
      <Route path="/watch/:id" element={<WatchPage />} />
      <Route path="/config" element={<ConfigPage />} />
    </Routes>
  );
}
