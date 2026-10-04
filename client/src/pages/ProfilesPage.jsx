import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getActiveProfileId, setActiveProfileId } from '../profile';

const COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#457b9d', '#8338ec', '#f4a261', '#06d6a0', '#ef476f'];

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export default function ProfilesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const lastProfileId = getActiveProfileId();
  const [profiles, setProfiles] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [managing, setManaging] = useState(false);

  const loadProfiles = () => {
    fetch('/api/profiles')
      .then((res) => res.json())
      .then(setProfiles)
      .catch(() => setError('No se pudieron cargar los perfiles.'));
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  const handleSelect = (id) => {
    if (managing) return;
    setActiveProfileId(id);
    // replace: Atrás desde el catálogo no vuelve a "¿Quién ve ahora?".
    navigate(location.state?.from || '/', { replace: true });
  };

  const handleCreate = (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo crear el perfil.');
        return data;
      })
      .then(() => {
        setName('');
        setCreating(false);
        loadProfiles();
      })
      .catch((err) => setError(err.message));
  };

  const handleDelete = (id) => {
    fetch(`/api/profiles/${id}`, { method: 'DELETE' })
      .then(loadProfiles)
      .catch(() => setError('No se pudo borrar el perfil.'));
  };

  return (
    <div className="profiles-page">
      <h1 className="profiles-title">¿Quién ve ahora?</h1>
      {error && <p className="empty-state">{error}</p>}
      <div className="profiles-grid">
        {(profiles || []).map((profile) => (
          <div key={profile.id} className="profile-card-wrap">
            <button
              className="profile-card"
              style={{ background: colorFor(profile.id) }}
              onClick={() => handleSelect(profile.id)}
              data-tv-start={profile.id === lastProfileId ? '' : undefined}
            >
              {profile.name.slice(0, 1).toUpperCase()}
            </button>
            <p className="profile-name">{profile.name}</p>
            {managing && (
              <button className="profile-delete" onClick={() => handleDelete(profile.id)}>
                Borrar
              </button>
            )}
          </div>
        ))}

        {creating ? (
          <form className="profile-card-wrap" onSubmit={handleCreate}>
            <label htmlFor="profile-name-input" className="sr-only">
              Nombre del perfil
            </label>
            <input
              id="profile-name-input"
              className="profile-name-input"
              autoFocus
              maxLength={30}
              placeholder="Nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="profile-create-actions">
              <button type="submit">Crear</button>
              <button type="button" className="secondary" onClick={() => setCreating(false)}>
                Cancelar
              </button>
            </div>
          </form>
        ) : (
          <div className="profile-card-wrap">
            <button className="profile-card profile-add" onClick={() => setCreating(true)}>
              +
            </button>
            <p className="profile-name">Añadir perfil</p>
          </div>
        )}
      </div>

      {profiles && profiles.length > 0 && (
        <button className="profiles-manage-toggle" onClick={() => setManaging((m) => !m)}>
          {managing ? 'Listo' : 'Gestionar perfiles'}
        </button>
      )}
    </div>
  );
}
