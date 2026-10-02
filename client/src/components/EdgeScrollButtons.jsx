import { useEffect, useRef, useState } from 'react';

// Franjas en el borde de arriba (justo bajo la cabecera fija) y de abajo de
// la pantalla con un botón que aparece al pasar el puntero y sube/baja la
// página casi una pantalla entera. Pensado para teles con mando-puntero
// (tipo Magic Remote), donde no hay rueda ni barra de scroll cómoda.
// Mantenerlo pulsado sigue desplazando. Con teclado/cruceta no hacen falta
// (las flechas ya mueven el foco y la página), así que no entran en el Tab.
const STEP = 0.8;
const REPEAT_DELAY_MS = 450;
const REPEAT_EVERY_MS = 350;

export default function EdgeScrollButtons() {
  const [headerHeight, setHeaderHeight] = useState(0);
  const [canUp, setCanUp] = useState(false);
  const [canDown, setCanDown] = useState(false);
  const holdRef = useRef(null);

  useEffect(() => {
    const header = document.querySelector('header');
    const update = () => {
      setHeaderHeight(header ? header.getBoundingClientRect().height : 0);
      const doc = document.documentElement;
      setCanUp(window.scrollY > 4);
      setCanDown(window.scrollY + window.innerHeight < doc.scrollHeight - 4);
    };
    update();
    const observer = new ResizeObserver(update);
    if (header) observer.observe(header);
    observer.observe(document.body);
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const scroll = (dir) => {
    window.scrollBy({ top: dir * (window.innerHeight - headerHeight) * STEP, behavior: 'smooth' });
  };

  const stopHold = () => {
    clearTimeout(holdRef.current?.timeout);
    clearInterval(holdRef.current?.interval);
    holdRef.current = null;
  };

  const startHold = (dir) => {
    stopHold();
    scroll(dir);
    const timeout = setTimeout(() => {
      holdRef.current.interval = setInterval(() => scroll(dir), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
    holdRef.current = { timeout };
  };

  useEffect(() => stopHold, []);

  const buttonProps = (dir) => ({
    type: 'button',
    tabIndex: -1,
    className: 'edge-scroll-btn',
    onPointerDown: (e) => {
      if (e.button === 0) startHold(dir);
    },
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
    // Mandos que mandan un "click" sin pointerdown previo.
    onClick: (e) => {
      if (e.detail === 0) scroll(dir);
    },
  });

  return (
    <>
      {canUp && (
        <div className="edge-scroll edge-scroll-top" style={{ top: headerHeight }}>
          <button {...buttonProps(-1)} aria-label="Subir">
            ▲
          </button>
        </div>
      )}
      {canDown && (
        <div className="edge-scroll edge-scroll-bottom">
          <button {...buttonProps(1)} aria-label="Bajar">
            ▼
          </button>
        </div>
      )}
    </>
  );
}
