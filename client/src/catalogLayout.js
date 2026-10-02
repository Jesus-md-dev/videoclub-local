const CATALOG_LAYOUT_KEY = 'catalogLayout';

// Cómo se muestran las filas del catálogo en ESTE dispositivo: carrusel
// horizontal (por defecto) o cuadrícula sin carrusel, más cómoda con el
// mando de la tele. Es por dispositivo (localStorage), no por perfil: la
// misma persona puede querer cuadrícula en la tele y carrusel en el móvil.
// Nunca se elige sola: solo cambia si alguien la activa en el menú.
export function getCatalogLayout() {
  try {
    return localStorage.getItem(CATALOG_LAYOUT_KEY) === 'grid' ? 'grid' : 'carousel';
  } catch {
    return 'carousel';
  }
}

export function setCatalogLayout(layout) {
  try {
    localStorage.setItem(CATALOG_LAYOUT_KEY, layout);
  } catch {
    // Sin almacenamiento (modo privado): vale solo para esta visita.
  }
}
