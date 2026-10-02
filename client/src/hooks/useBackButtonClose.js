import { useEffect, useRef } from 'react';

// El botón Atrás del mando de la Fire TV (y el de Android, y el del
// navegador) es un "atrás" del historial: con una ventana o menú abierto
// sacaba de la página entera en vez de cerrarlo. Al abrir se añade una
// entrada al historial con la MISMA URL (solo cambia el state), así Atrás la
// consume y cierra; si se cierra de otra forma (✕, Escape, clic fuera) se
// quita esa entrada con history.back() para no dejarla colgando.
//
// Se conserva el state de React Router (idx/key) para que su contador de
// historial siga cuadrando al volver a la entrada original.
export default function useBackButtonClose(open, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const marker = `${Date.now()}-${Math.random()}`;
    window.history.pushState({ ...window.history.state, videoclubOverlay: marker }, '');
    let closedByBack = false;
    const onPopState = () => {
      // Con una ventana encima de otra (selector de carátula sobre la ficha
      // rápida), Atrás quita solo la entrada de la de arriba: si seguimos en
      // la nuestra, no va con esta.
      if (window.history.state?.videoclubOverlay === marker) return;
      closedByBack = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      // Si se cerró navegando a otra página (un enlace dentro de la
      // ventana), la entrada actual ya no es la nuestra: no se toca.
      if (!closedByBack && window.history.state?.videoclubOverlay === marker) window.history.back();
    };
  }, [open]);
}
