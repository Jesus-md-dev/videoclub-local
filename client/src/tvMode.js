import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Modo tele (#146): manejar toda la web con la cruceta del mando, como
// Netflix. Se activa solo dentro de la APK nativa de tele (añade
// "VideoclubTV" al user agent, ver android-tv/) o a mano con ?tv=1 (se
// recuerda en este navegador; ?tv=0 lo quita), para probarlo en el PC o en
// navegadores de tele que sí entreguen las flechas como teclas.
//
// En escritorio no cambia nada: ahí las flechas siguen desplazando la
// página y solo el catálogo mueve el foco entre carátulas
// (useSpatialNavigation).
const STORAGE_KEY = 'videoclub-tv-mode';

let tvMode = null;

export function isTvMode() {
  if (tvMode !== null) return tvMode;
  let stored = null;
  try {
    const param = new URLSearchParams(window.location.search).get('tv');
    if (param === '1') localStorage.setItem(STORAGE_KEY, '1');
    if (param === '0') localStorage.removeItem(STORAGE_KEY);
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Sin almacenamiento: solo cuenta el user agent.
  }
  tvMode = /VideoclubTV/.test(navigator.userAgent) || stored === '1';
  return tvMode;
}

// Puente con la APK (MainActivity.java, objeto "VideoclubApp"): fuera de
// la app no existe y no se hace nada.
export function setKeepScreenOn(on) {
  try {
    window.VideoclubApp?.setKeepScreenOn?.(Boolean(on));
  } catch {
    // Puente no disponible.
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Lo que no es una parada: lo de dentro de una carátula (la carátula
// entera es una sola parada; su ⓘ se abre con OK largo o Menú), las
// flechas de los carriles (el carril se desplaza solo al mover el foco) y
// lo que esté oculto con los controles del reproductor.
const SKIP = '.card *, .row-arrow, .skip-link, .video-controls-hidden *, .player-topbar-hidden *';

// Ventanas abiertas encima: mientras haya una, las flechas no salen de
// ella (la última del DOM es la de más arriba).
const MODALS = '.quickinfo-card, .poster-picker, .browser-modal, .shortcuts-help, .hidden-menu-panel';

function currentScope() {
  const modals = document.querySelectorAll(MODALS);
  if (modals.length === 0) return document;
  const top = modals[modals.length - 1];
  // El menú incluye su propio botón, que es donde suele estar el foco.
  return top.classList.contains('hidden-menu-panel') ? top.parentElement : top;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function candidatesIn(scope) {
  return Array.from(scope.querySelectorAll(FOCUSABLE)).filter((el) => !el.matches(SKIP) && isVisible(el));
}

function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Igual que useSpatialNavigation, pero midiendo desde el borde que mira en
// esa dirección y con solape: así de un botón ancho de la cabecera se baja
// a lo que tiene justo debajo y no a lo más cercano a su centro.
function findBest(from, direction, candidates) {
  const a = from.getBoundingClientRect();
  const ac = centerOf(a);
  const horizontal = direction === 'left' || direction === 'right';
  let best = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    if (el === from || el.contains(from) || from.contains(el)) continue;
    const b = el.getBoundingClientRect();
    const bc = centerOf(b);
    let primary;
    if (direction === 'right') primary = b.left - a.right;
    else if (direction === 'left') primary = a.left - b.right;
    else if (direction === 'down') primary = b.top - a.bottom;
    else primary = a.top - b.bottom;
    // Delante en esa dirección (con margen por solapes pequeños), y que el
    // centro también avance, para no "volver" a algo que solo asoma.
    const centerDelta = horizontal ? bc.x - ac.x : bc.y - ac.y;
    const sign = direction === 'right' || direction === 'down' ? 1 : -1;
    if (primary < -8 || centerDelta * sign <= 1) continue;
    const overlap = horizontal
      ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const perpendicular = overlap > 0 ? 0 : horizontal ? Math.abs(bc.y - ac.y) : Math.abs(bc.x - ac.x);
    const score = Math.max(primary, 0) + perpendicular * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function focusElement(el) {
  el.focus({ preventScroll: true });
  // Centrado en vertical (como Netflix, y así nada queda bajo la cabecera
  // fija); la cabecera en sí, subiendo del todo.
  if (el.closest('header')) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }
}

// Primera parada de una página: la primera carátula visible, o si no hay,
// lo primero enfocable.
function preferredStart(candidates) {
  const viewportBottom = window.innerHeight;
  const visibleCard = candidates.find((el) => {
    if (!el.classList.contains('card')) return false;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= viewportBottom;
  });
  return visibleCard || candidates.find((el) => el.classList.contains('card')) || candidates[0];
}

const KEY_TO_DIRECTION = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const KEYCODE_TO_DIRECTION = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

function directionFor(e) {
  return KEY_TO_DIRECTION[e.key] || KEYCODE_TO_DIRECTION[e.keyCode];
}

// Controles que usan ellos mismos alguna flecha: un campo de texto mueve
// el cursor con ←/→, un deslizador cambia su valor. ↑/↓ salen siempre.
function ownsArrow(el, direction) {
  if (!el) return false;
  const horizontal = direction === 'left' || direction === 'right';
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    if (el.type === 'range') return horizontal;
    if (el.type === 'checkbox' || el.type === 'radio') return false;
    return horizontal && el.value !== '';
  }
  if (el.getAttribute('role') === 'slider') return horizontal;
  return false;
}

function isTextField(el) {
  return el?.tagName === 'TEXTAREA' || (el?.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type));
}

function handleKeyDown(e) {
  // OK sobre un campo de texto: en la tele el teclado en pantalla no sale
  // solo con el foco, hay que pedírselo a la APK.
  if ((e.key === 'Enter' || e.keyCode === 13) && isTextField(document.activeElement)) {
    try {
      window.VideoclubApp?.showKeyboard?.();
    } catch {
      // Puente no disponible.
    }
    return;
  }
  const direction = directionFor(e);
  if (!direction) return;
  // Ya lo ha usado otro (el reproductor para avanzar ±10 s, por ejemplo).
  if (e.defaultPrevented) return;
  const active = document.activeElement;
  if (ownsArrow(active, direction)) return;

  const scope = currentScope();
  const candidates = candidatesIn(scope);
  if (candidates.length === 0) return;
  e.preventDefault();

  const inScope = active && active !== document.body && candidates.includes(active);
  if (!inScope) {
    // Foco perdido (página recién cargada, o en el reproductor): se entra
    // por la parada inicial. Dentro de una tarjeta, por la propia tarjeta.
    const card = active?.closest?.('.card');
    focusElement(card && candidates.includes(card) ? card : preferredStart(candidates));
    return;
  }
  const next = findBest(active, direction, candidates);
  if (next) {
    focusElement(next);
  } else if (active.closest('.video-controls')) {
    // Saliendo de los controles por arriba/abajo: vuelta al vídeo (←/→
    // vuelven a avanzar y retroceder).
    active.closest('.player-shell')?.focus({ preventScroll: true });
  }
}

// OK largo o botón Menú del mando (los manda la APK): la ficha rápida de
// la carátula enfocada.
function handleRemote(e) {
  if (e.detail !== 'menu') return;
  const card = document.activeElement?.closest?.('.card');
  const infoButton = card?.querySelector('.card-info-btn');
  if (!infoButton) return;
  infoButton.click();
  // Con el mando, mejor empezar en "Reproducir" que en la ✕ de cerrar.
  setTimeout(() => document.querySelector('.quickinfo-play')?.focus(), 50);
}

export function setupTvMode() {
  if (!isTvMode()) return;
  document.documentElement.classList.add('tv-mode');
  // En window (después de los de document): así el reproductor y las
  // ventanas usan antes las teclas que les tocan.
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('videoclub-remote', handleRemote);
}

// Foco al cambiar de página: al volver atrás, en la carátula de la que se
// salió (como Netflix); en una página nueva, en la parada inicial. Se
// reintenta un rato porque el catálogo tarda en pintarse.
const lastFocusByKey = new Map();

function isOffscreen(el) {
  const rect = el.getBoundingClientRect();
  return rect.bottom > window.innerHeight || rect.top < 0;
}

function focusKey(el) {
  return el.getAttribute('href') || el.querySelector?.('.card-title')?.textContent || el.textContent?.trim().slice(0, 60);
}

export function useTvFocus() {
  const location = useLocation();
  useEffect(() => {
    if (!isTvMode()) return undefined;
    const key = location.key;
    const remember = () => {
      const el = document.activeElement;
      if (el && el !== document.body) lastFocusByKey.set(key, focusKey(el));
    };
    document.addEventListener('focusin', remember);

    // Mientras la página se sigue pintando, se corrige la elección (las
    // filas del catálogo llegan por tandas: "Continuar viendo" puede
    // aparecer encima de la que ya tenía el foco), salvo que se haya tocado
    // el mando o la propia página haya puesto el foco (el reproductor).
    const wanted = lastFocusByKey.get(key);
    const limit = wanted || location.pathname === '/' ? 15 : 3;
    let tries = 0;
    let autoFocused = null;
    let touched = false;
    const onKey = () => {
      touched = true;
    };
    window.addEventListener('keydown', onKey, true);
    const timer = setInterval(() => {
      tries += 1;
      const active = document.activeElement;
      const free = !active || active === document.body || active.id === 'main' || active === autoFocused;
      if (touched || !free) {
        clearInterval(timer);
        return;
      }
      const candidates = candidatesIn(currentScope());
      const previous = wanted && candidates.find((el) => focusKey(el) === wanted);
      let target =
        previous ||
        (wanted
          ? null
          : candidates.find((el) => el.hasAttribute('data-tv-start')) ||
            candidates.find((el) => el.classList.contains('card')));
      if (!target && tries >= limit) target = preferredStart(candidates);
      if (target && target !== active) {
        focusElement(target);
        autoFocused = target;
      } else if (target && isOffscreen(target)) {
        // Algo devolvió la página arriba después (al volver atrás pasa).
        focusElement(target);
      }
      if (tries >= limit) clearInterval(timer);
    }, 200);

    return () => {
      clearInterval(timer);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', remember);
    };
  }, [location.key]);
}
