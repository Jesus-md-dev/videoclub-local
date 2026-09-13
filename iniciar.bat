@echo off
setlocal
cd /d "%~dp0"
title Videoclub Local - Servidor

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

echo Iniciando el servidor...
echo (Las direcciones para acceder aparecen justo debajo)
echo.
echo Deja esta ventana abierta mientras uses el videoclub.
echo Cierrala (o pulsa Ctrl+C) para detener el servidor.
echo.

node server\index.js

echo.
echo El servidor se ha detenido.
pause
