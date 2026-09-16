# Seguridad

## Criterio permanente: solo red local, nunca internet

**Videoclub Local no debe exponerse nunca a internet.** No es una limitación
temporal a resolver más adelante, es una decisión de diseño permanente.
Cualquier cambio futuro (nuevas rutas, apps móviles, empaquetados, scripts
de despliegue, etc.) debe asumir siempre que el servidor solo es alcanzable
desde la red local doméstica.

Formas de exposición a evitar explícitamente, sin excepción:

- Port-forwarding en el router hacia los puertos `3000`/`3443` (o cualquier
  otro que use el servidor).
- Túneles públicos (ngrok, Cloudflare Tunnel, localtunnel, etc.).
- VPNs comerciales/de terceros que expongan el servicio hacia fuera.
- Dominios públicos apuntando a la IP del servidor.
- Desplegarlo en un VPS/hosting público.

## Por qué

- El HTTPS usa un **certificado autofirmado** (`server/https-cert.js`), sin
  ninguna autoridad de certificación real detrás - pensado para instalarse
  como "de confianza" a mano en los dispositivos de la propia red, no para
  soportar tráfico de internet.
- No hay autenticación de usuarios más allá de la selección de perfil local
  (pensada para "quién de la familia está viendo", no como control de
  acceso real).
- Sirve contenido de vídeo personal (posiblemente con derechos de autor de
  terceros) pensado para consumo privado dentro del hogar, no para
  distribución pública.

## Si necesitas acceso remoto

La vía correcta es una **VPN personal hacia tu propia red doméstica**
(WireGuard, Tailscale, el VPN del propio router, etc.), de forma que el
dispositivo remoto se une virtualmente a la LAN y accede exactamente igual
que si estuviera en casa - el servidor en sí sigue sin escuchar nada desde
internet directamente. Esto es responsabilidad de quien despliega el
servicio, fuera del alcance de este repositorio.
