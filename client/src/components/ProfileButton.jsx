import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import useBackButtonClose from '../hooks/useBackButtonClose';
import { getActiveProfileId, profileColor, refreshProfiles, setActiveProfileId, useActiveProfile } from '../profile';

// Avatar del perfil activo en todas las cabeceras (#157), como Netflix: abre
// un menú con los demás perfiles para cambiar directamente, y "Gestionar
// perfiles". Antes solo se llegaba a "¿Quién ve ahora?" desde el menú ☰.
function Avatar({ profile, className }) {
  return (
    <span className={className} style={{ background: profileColor(profile) }} aria-hidden="true">
      {profile.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function ProfileButton() {
  const profile = useActiveProfile();
  const [open, setOpen] = useState(false);
  const [others, setOthers] = useState([]);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  // Atrás del mando cierra el menú en vez de salir de la página.
  useBackButtonClose(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return undefined;
    refreshProfiles().then((list) => {
      if (Array.isArray(list)) setOthers(list.filter((p) => p.id !== getActiveProfileId()));
    });
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onFocusOut = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.relatedTarget)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    const root = rootRef.current;
    root?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      root?.removeEventListener('focusout', onFocusOut);
    };
  }, [open]);

  if (!profile) return null;

  // Recarga completa al cambiar: el catálogo, "Continuar viendo", el anime
  // visible y los permisos dependen del perfil.
  const switchTo = (id) => {
    setActiveProfileId(id);
    window.location.assign('/');
  };

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="profile-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Perfil ${profile.name}. Cambiar de perfil`}
        title={profile.name}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar profile={profile} className="profile-button-avatar" />
        <span className="profile-button-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <nav className="hidden-menu-panel profile-menu-panel">
          <p className="profile-menu-current">
            <Avatar profile={profile} className="profile-menu-avatar" />
            {profile.name}
          </p>
          {others.map((p) => (
            <button key={p.id} type="button" className="profile-menu-item" onClick={() => switchTo(p.id)}>
              <Avatar profile={p} className="profile-menu-avatar" />
              {p.name}
            </button>
          ))}
          <Link to="/profiles" className="profile-menu-manage" onClick={() => setOpen(false)}>
            Gestionar perfiles
          </Link>
        </nav>
      )}
    </div>
  );
}
