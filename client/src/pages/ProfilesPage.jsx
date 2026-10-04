import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { clearActiveProfileId, getActiveProfileId, isAdminIn, refreshProfiles, setActiveProfileId } from '../profile';

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
    refreshProfiles().then((list) => {
      if (Array.isArray(list)) setProfiles(list);
      else setError('No se pudieron cargar los perfiles.');
    });
  };

  // Borrar y cambiar opciones de perfiles: solo si el último perfil
  // usado en este dispositivo es admin (#152). Para gestionar desde un
  // dispositivo nuevo, entra antes con un perfil admin y vuelve aquí desde
  // el menú ("Cambiar perfil").
  const canManage = profiles ? isAdminIn(profiles, lastProfileId) : false;

  // Respuesta de error del servidor (p.ej. el 403 de adminGuard) como texto.
  const failIfNotOk = async (res, fallback) => {
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  };

  const handleToggleAdmin = (profile) => {
    fetch(`/api/profiles/${profile.id}/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin: !profile.admin }),
    })
      .then((res) => failIfNotOk(res, 'No se pudo cambiar el administrador.'))
      .then(loadProfiles)
      .catch((err) => setError(err.message));
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

  // "Mostrar anime" (#150): desactivado de base; el servidor oculta el
  // anime del catálogo, la búsqueda y los géneros a quien no lo tenga.
  const handleToggleAnime = (profile) => {
    fetch(`/api/profiles/${profile.id}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ showAnime: !profile.settings?.showAnime }),
    })
      .then((res) => failIfNotOk(res, 'No se pudo cambiar la opción de anime.'))
      .then(loadProfiles)
      .catch((err) => setError(err.message));
  };

  const handleDelete = (id) => {
    fetch(`/api/profiles/${id}`, { method: 'DELETE' })
      .then((res) => failIfNotOk(res, 'No se pudo borrar el perfil.'))
      .then(() => {
        // Borrado el propio: este dispositivo se queda sin perfil activo.
        if (id === getActiveProfileId()) clearActiveProfileId();
      })
      .then(loadProfiles)
      .catch((err) => setError(err.message));
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
              <>
                {/* Admin y anime: solo un admin. Borrar: un admin, o el
                    propio perfil (#154). */}
                {canManage && (
                  <>
                    <button
                      className="profile-option"
                      aria-pressed={Boolean(profile.admin)}
                      onClick={() => handleToggleAdmin(profile)}
                    >
                      {profile.admin ? '✓ Administrador' : 'Sin permisos de admin'}
                    </button>
                    <button
                      className="profile-option"
                      aria-pressed={Boolean(profile.settings?.showAnime)}
                      onClick={() => handleToggleAnime(profile)}
                    >
                      {profile.settings?.showAnime ? '✓ Mostrar anime' : 'Anime oculto'}
                    </button>
                  </>
                )}
                {(canManage || profile.id === lastProfileId) && (
                  <button className="profile-delete" onClick={() => handleDelete(profile.id)}>
                    Borrar
                  </button>
                )}
              </>
            )}
          </div>
        ))}

        {/* Añadir perfiles: cualquiera (#153); nacen sin admin y sin anime. */}
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

      {/* Gestionar: cualquiera (#154); qué puede hacer cada uno, arriba. */}
      {profiles && profiles.length > 0 && (
        <button className="profiles-manage-toggle" onClick={() => setManaging((m) => !m)}>
          {managing ? 'Listo' : 'Gestionar perfiles'}
        </button>
      )}
    </div>
  );
}
