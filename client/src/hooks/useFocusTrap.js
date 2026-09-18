import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Comportamiento estándar de cualquier modal para teclado de PC, que
// ninguno de los tres (QuickInfoModal, PosterPicker, FolderBrowser) tenía:
// al abrir, mueve el foco DENTRO del modal (si no, el usuario ve el modal
// pero su foco sigue en la carátula de detrás); mientras está abierto,
// Tab/Shift+Tab no se escapan al contenido de detrás (dan la vuelta dentro
// del propio modal); al cerrarse, el foco vuelve exactamente a donde
// estaba antes de abrirlo, en vez de perderse en el body.
export default function useFocusTrap(containerRef, active) {
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    previouslyFocused.current = document.activeElement;

    const container = containerRef.current;
    const focusable = () =>
      Array.from(container?.querySelectorAll(FOCUSABLE_SELECTOR) || []).filter((el) => el.offsetParent !== null);

    const first = focusable()[0];
    (first || container)?.focus();

    const handleKeyDown = (e) => {
      if (e.key !== 'Tab' || !container) return;
      const items = focusable();
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Si el elemento anterior ya no existe (p.ej. la carátula se quitó de
      // la lista mientras el modal estaba abierto), no pasa nada por
      // intentarlo: focus() en un nodo desmontado simplemente no hace nada.
      previouslyFocused.current?.focus?.();
    };
  }, [active, containerRef]);
}
