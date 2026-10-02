import { useRef, useState } from 'react';

// Carril horizontal deslizable (estilo Netflix) en vez de una rejilla que
// se corta en varias filas: cada categoría es una cinta que se recorre
// hacia los lados, con flechas que aparecen al pasar el ratón por encima o
// al llegar por teclado/mando a una carátula suya (en touch, el
// deslizamiento normal ya vale, no hacen falta) - antes solo se montaban
// con el hover de ratón, así que quien navegaba solo con Tab no podía
// alcanzarlas nunca, ni siquiera "a ciegas".
// Con layout="grid" (elegido a mano en el menú, pensado para la tele) la
// categoría se muestra como una cuadrícula normal, sin carrusel ni flechas.
export default function Row({ title, layout = 'carousel', children }) {
  const trackRef = useRef(null);
  const sectionRef = useRef(null);
  const [revealed, setRevealed] = useState(false);

  const scrollBy = (dir) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: 'smooth' });
  };

  // Con onBlur (en React, se comporta como "focusout": sí burbujea desde
  // cualquier carátula hija) hay que comprobar a dónde va el foco - si
  // sigue dentro del carril (moverse de una carátula a la siguiente), no
  // se ocultan las flechas solo porque el foco cambió de elemento hijo.
  const handleBlur = (e) => {
    if (sectionRef.current && !sectionRef.current.contains(e.relatedTarget)) setRevealed(false);
  };

  if (layout === 'grid') {
    return (
      <section className="row row-grid">
        <p className="section-title">{title}</p>
        <div className="grid">{children}</div>
      </section>
    );
  }

  return (
    <section
      className="row"
      ref={sectionRef}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={() => setRevealed(false)}
      onFocus={() => setRevealed(true)}
      onBlur={handleBlur}
    >
      <p className="section-title">{title}</p>
      <div className="row-viewport">
        {revealed && (
          <button className="row-arrow row-arrow-left" onClick={() => scrollBy(-1)} aria-label="Desplazar a la izquierda">
            ‹
          </button>
        )}
        <div className="row-track" ref={trackRef}>
          {children}
        </div>
        {revealed && (
          <button className="row-arrow row-arrow-right" onClick={() => scrollBy(1)} aria-label="Desplazar a la derecha">
            ›
          </button>
        )}
      </div>
    </section>
  );
}
