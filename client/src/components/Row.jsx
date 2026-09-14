import { useRef, useState } from 'react';

// Carril horizontal deslizable (estilo Netflix) en vez de una rejilla que
// se corta en varias filas: cada categoría es una cinta que se recorre
// hacia los lados, con flechas que solo aparecen al pasar el ratón por
// encima (en touch, el deslizamiento normal ya vale, no hacen falta).
export default function Row({ title, children }) {
  const trackRef = useRef(null);
  const [hovering, setHovering] = useState(false);

  const scrollBy = (dir) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: dir * track.clientWidth * 0.9, behavior: 'smooth' });
  };

  return (
    <section className="row" onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <p className="section-title">{title}</p>
      <div className="row-viewport">
        {hovering && (
          <button className="row-arrow row-arrow-left" onClick={() => scrollBy(-1)} aria-label="Desplazar a la izquierda">
            ‹
          </button>
        )}
        <div className="row-track" ref={trackRef}>
          {children}
        </div>
        {hovering && (
          <button className="row-arrow row-arrow-right" onClick={() => scrollBy(1)} aria-label="Desplazar a la derecha">
            ›
          </button>
        )}
      </div>
    </section>
  );
}
