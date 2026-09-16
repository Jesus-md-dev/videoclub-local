// Pantalla para cuando la app ya cargó (React montado) pero no logra
// hablar con el servidor - típicamente al alejarse de la LAN a media
// sesión, o si el servidor está apagado. Complementa a offline.html
// (client/public/), que cubre el otro caso: cuando ni siquiera carga el
// shell de la app al arrancar en frío sin conexión.
export default function ServerUnreachable({ onRetry }) {
  return (
    <div className="empty-state server-unreachable">
      <p className="server-unreachable-title">No se puede conectar con Videoclub Local</p>
      <p>Comprueba que estás conectado a la misma red que el servidor y que está encendido.</p>
      <button className="retry-btn" onClick={onRetry}>
        Reintentar
      </button>
    </div>
  );
}
