import { useEffect, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';

// Los atajos de teclado (flechas del catálogo, espacio/flechas/M/F del
// reproductor...) no estaban documentados en ningún sitio de la interfaz -
// "?" (el atajo más extendido para esto: GitHub, Gmail, YouTube...) abre un
// resumen de los que aplican a la página actual.
export default function ShortcutsHelp({ shortcuts }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  useFocusTrap(panelRef, open);

  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === '?') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="quickinfo-backdrop" onClick={() => setOpen(false)}>
      <div className="shortcuts-help" ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <button className="quickinfo-close" onClick={() => setOpen(false)} aria-label="Cerrar">
          ✕
        </button>
        <p className="section-title">Atajos de teclado</p>
        <ul className="shortcuts-list">
          {shortcuts.map(({ keys, label }) => (
            <li key={label}>
              <span className="shortcut-keys">{keys}</span>
              <span>{label}</span>
            </li>
          ))}
          <li>
            <span className="shortcut-keys">?</span>
            <span>Mostrar/ocultar esta ayuda</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
