import { useEffect, useRef, useState } from 'react';

// Franjas en el borde de arriba (justo bajo la cabecera fija) y de abajo de
// la pantalla con un botón que aparece al pasar el puntero y sube/baja la
// página casi una pantalla entera. Pensado para teles con mando-puntero
// (tipo Magic Remote), donde no hay rueda ni barra de scroll cómoda.
// Mantenerlo pulsado sigue desplazando. Con teclado/cruceta no hacen falta
// (las flechas ya mueven el foco y la página), así que no entran en el Tab.
// Con alwaysVisible (vista cuadrícula, la que se elige para la tele) se ven
// siempre, sin esperar al hover: muchos navegadores de tele se declaran
// "hover: none" aunque tengan puntero, y escondidos no los encontraba nadie.
const STEP = 0.8;
const REPEAT_DELAY_MS = 450;
const REPEAT_EVERY_MS = 350;

export default function EdgeScrollButtons({ alwaysVisible = false }) {
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
    // Navegadores de tele antiguos no tienen ResizeObserver: ahí basta con
    // scroll/resize.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer && header) observer.observe(header);
    observer?.observe(document.body);
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
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

  // El desplazamiento de una pulsación lo hace onClick (funciona en
  // cualquier navegador, con o sin eventos de puntero); mantener pulsado
  // solo añade la repetición, y entonces el click al soltar no suma otro.
  const startHold = (dir) => {
    stopHold();
    const hold = { repeated: false };
    hold.timeout = setTimeout(() => {
      hold.repeated = true;
      scroll(dir);
      hold.interval = setInterval(() => scroll(dir), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
    holdRef.current = hold;
  };

  const handleClick = (dir) => {
    const repeated = holdRef.current?.repeated;
    stopHold();
    if (!repeated) scroll(dir);
  };

  useEffect(() => stopHold, []);

  const buttonProps = (dir) => ({
    type: 'button',
    tabIndex: -1,
    className: 'edge-scroll-btn',
    onPointerDown: (e) => {
      if (e.button === 0) startHold(dir);
    },
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
    onClick: () => handleClick(dir),
  });

  const zoneClass = `edge-scroll${alwaysVisible ? ' edge-scroll-visible' : ''}`;

  return (
    <>
      {canUp && (
        <div className={`${zoneClass} edge-scroll-top`} style={{ top: headerHeight }}>
          <button {...buttonProps(-1)} aria-label="Subir">
            ▲
          </button>
        </div>
      )}
      {canDown && (
        <div className={`${zoneClass} edge-scroll-bottom`}>
          <button {...buttonProps(1)} aria-label="Bajar">
            ▼
          </button>
        </div>
      )}
    </>
  );
}
