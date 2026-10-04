import { useEffect } from 'react';
import { isTvMode } from '../tvMode';

// Navegación por flechas entre carátulas (estilo mando de TV/D-pad): sin
// esto, la única forma de moverse por el catálogo con teclado/mando era el
// Tab secuencial del navegador, que además para en 2-3 paradas dentro de
// cada carátula (el propio enlace, el botón "quitar", el botón "info") -
// demasiado largo para recorrer varios carriles. Aquí las flechas mueven el
// foco directamente de una carátula a la siguiente/anterior/arriba/abajo
// más cercana geométricamente, tratando cada `.card` como una sola parada.
//
// Algoritmo: de entre las carátulas en la dirección pulsada (a un lado del
// eje correspondiente), se elige la más cercana en línea recta,
// penalizando el desvío en el eje perpendicular más que la distancia en el
// eje principal - así "abajo" prefiere la carátula justo debajo en vez de
// una bastante más a un lado aunque esté más cerca en línea recta pura.
function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function findBestCandidate(current, direction, candidates) {
  const curCenter = centerOf(current.getBoundingClientRect());
  let best = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === current) continue;
    const center = centerOf(el.getBoundingClientRect());
    const dx = center.x - curCenter.x;
    const dy = center.y - curCenter.y;
    if (direction === 'right' && dx <= 1) continue;
    if (direction === 'left' && dx >= -1) continue;
    if (direction === 'down' && dy <= 1) continue;
    if (direction === 'up' && dy >= -1) continue;
    const horizontal = direction === 'left' || direction === 'right';
    const primary = Math.abs(horizontal ? dx : dy);
    const perpendicular = Math.abs(horizontal ? dy : dx);
    const score = primary + perpendicular * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

const KEY_TO_DIRECTION = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// Algunos navegadores de TV (sobre todo motores WebKit/Chromium más
// antiguos en modelos de hace años) no rellenan "key" en KeyboardEvent como
// exige el estándar actual - se quedan en la propiedad numérica ya obsoleta
// (keyCode/which), o a veces directamente no disparan nada reconocible.
// Sin este resguardo, el mando de esas teles no podía mover el foco a
// ningún sitio (ni carátulas ni desplegables): las flechas nunca
// encontraban su dirección en KEY_TO_DIRECTION y no pasaba nada.
const KEYCODE_TO_DIRECTION = {
  37: 'left',
  38: 'up',
  39: 'right',
  40: 'down',
};

function directionFor(e) {
  return KEY_TO_DIRECTION[e.key] || KEYCODE_TO_DIRECTION[e.keyCode] || KEYCODE_TO_DIRECTION[e.which];
}

// No interceptar flechas mientras el foco está en un control que ya las usa
// para su propio cometido (texto, desplegable, control con su propio
// role="slider"...): ahí deben funcionar como siempre.
function ownsArrowKeys(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (el.getAttribute('role') === 'slider') return true;
  return false;
}

// `selector` decide qué cuenta como "una parada" para las flechas (p.ej.
// ".card" en el catálogo: cada carátula es una parada, no cada botón
// interno suyo). `enabled` permite activar/desactivar sin desmontar el
// efecto (p.ej. mientras un modal está abierto encima).
export default function useSpatialNavigation(selector, { enabled = true } = {}) {
  useEffect(() => {
    // En modo tele ya lo hace tvMode.js para toda la página.
    if (!enabled || isTvMode()) return undefined;

    const handleKeyDown = (e) => {
      const direction = directionFor(e);
      if (!direction) return;
      if (ownsArrowKeys(document.activeElement)) return;

      const candidates = Array.from(document.querySelectorAll(selector)).filter((el) => el.offsetParent !== null);
      if (candidates.length === 0) return;

      const current = document.activeElement;
      const from = current && candidates.includes(current) ? current : candidates[0];
      if (!current || !candidates.includes(current)) {
        e.preventDefault();
        from.focus();
        from.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        return;
      }

      const next = findBestCandidate(from, direction, candidates);
      if (!next) return;
      e.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selector, enabled]);
}
