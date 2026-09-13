## Descripción

(Mejora opcional) Recordar el progreso de reproducción de cada vídeo para poder continuar donde se dejó, como en un servicio de streaming real.

## Tareas

- Guardar en `localStorage` del navegador el `currentTime` del vídeo cada pocos segundos mientras se reproduce.
- Al abrir un vídeo ya empezado, retomar automáticamente desde el punto guardado.
- Mostrar en la cuadrícula del catálogo una marca visual ("Continuar viendo") en los vídeos con progreso guardado.

## Criterios de aceptación

- Cerrar el vídeo a mitad y volver a abrirlo continúa la reproducción desde ese punto.
- Los vídeos con progreso guardado se distinguen visualmente en el catálogo.
