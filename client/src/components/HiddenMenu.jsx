import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

// Páginas sin enlace visible en el catálogo (config, cola, estadísticas,
// perfiles): antes solo se llegaba a ellas escribiendo la URL a mano. Este
// menú las reúne en un sitio, sin ensuciar la cabecera del catálogo con
// más enlaces sueltos.
const PAGES = [
  { to: '/profiles', label: 'Cambiar perfil' },
  { to: '/queue', label: 'Preparación (HLS)' },
  { to: '/move-queue', label: 'Traslado de originales' },
  { to: '/stats', label: 'Estadísticas de uso' },
  { to: '/config', label: 'Configuración' },
];

export default function HiddenMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="hidden-menu" ref={rootRef}>
      <button
        type="button"
        className="hidden-menu-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Más páginas"
        onClick={() => setOpen((v) => !v)}
      >
        <span />
        <span />
        <span />
      </button>
      {open && (
        <nav className="hidden-menu-panel">
          {PAGES.map((page) => (
            <Link key={page.to} to={page.to} onClick={() => setOpen(false)}>
              {page.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
