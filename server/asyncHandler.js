// Express 4 no convierte automáticamente el rechazo de una promesa
// devuelta por un handler `async` en un error gestionado - sin envolverlo,
// una petición cuyo `await` falla se queda colgada sin respuesta hasta que
// el cliente hace timeout, en vez de recibir un error. Envuelve `fn` para
// que cualquier rechazo llegue a `next(err)` y lo recoja el middleware de
// errores centralizado (ver server/index.js).
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
