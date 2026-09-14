@echo off
setlocal
cd /d "%~dp0"
title Videoclub Local - Iniciar servidor

echo ============================================
echo   Videoclub Local - Iniciar servidor
echo ============================================
echo.

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
    echo Deteniendo una instancia anterior en marcha, PID %%P...
    taskkill /F /PID %%P >nul 2>&1
)

if not exist "node_modules" (
    echo.
    echo No se encuentran las dependencias instaladas todavia.
    echo Ejecuta primero "actualizar.bat".
    echo.
    pause
    exit /b 1
)

echo Compilando la interfaz web...
call npm run build
if errorlevel 1 (
    echo.
    echo Fallo al compilar la interfaz. Revisa el mensaje de arriba.
    pause
    exit /b 1
)

echo.
echo Iniciando el servidor en segundo plano...
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server\index.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server-error.log'"

echo Esperando a que arranque...
powershell -NoProfile -Command ^
  "$ok = $false; for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -Uri 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 1 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 1000 } }; if (-not $ok) { Write-Host 'El servidor no respondio a tiempo; revisa server.log'; exit 1 }"
if errorlevel 1 (
    echo.
    echo Puede que algo haya fallado al arrancar. Revisa "server.log" para mas detalle.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Servidor en marcha (en segundo plano)
echo ============================================
echo.
echo   Local: http://localhost:3000
echo.
echo El registro del servidor se guarda en "server.log".
echo Para detenerlo, ejecuta "detener.bat".
echo.
pause
