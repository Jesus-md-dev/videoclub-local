@echo off
setlocal enabledelayedexpansion
title Videoclub Local - Detener servidor

echo ============================================
echo   Videoclub Local - Detener servidor
echo ============================================
echo.

set FOUND=0
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
