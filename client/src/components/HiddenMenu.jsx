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
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    // Con Escape, el foco vuelve al botón que abrió el menú (si no, se
    // pierde en el body). Con un clic fuera o al elegir una opción no hace
    // falta: ahí el usuario ya decidió a propósito irse a otro sitio.
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    // Si se tabula con teclado hacia fuera del menú (sin ratón de por
    // medio), se cierra solo - si no, se quedaba visualmente abierto
    // aunque el foco ya estuviera en otra parte de la página.
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

  return (
    <div className="hidden-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
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
