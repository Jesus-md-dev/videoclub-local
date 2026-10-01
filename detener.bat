@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Videoclub Local - Detener servidor

echo ============================================
echo   Videoclub Local - Detener servidor
echo ============================================
echo.

set FOUND=0

rem Primero el vigilante (server\supervisor.js), con todo su arbol: si
rem solo se matara el servidor, el vigilante lo volveria a levantar.
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "$p = Get-Content 'supervisor.pid' -ErrorAction SilentlyContinue; if ($p) { $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p); if ($proc -and $proc.CommandLine -match 'supervisor\.js') { taskkill /PID $p /T /F | Out-Null; $p } }; Remove-Item 'supervisor.pid' -ErrorAction SilentlyContinue"`) do (
    set FOUND=1
    echo Detenido el vigilante del servidor, PID %%S.
)
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
    set FOUND=1
    echo Deteniendo el servidor, PID %%P...
    taskkill /F /PID %%P >nul 2>&1
)

echo.
if "!FOUND!"=="0" (
    echo No habia ningun servidor en marcha en el puerto 3000.
) else (
    echo Servidor detenido.
)
echo.
pause
