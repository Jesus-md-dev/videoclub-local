@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Videoclub Local - Actualizar

echo ============================================
echo   Videoclub Local - Actualizar
echo ============================================
echo.

where git >nul 2>&1
if errorlevel 1 (
    echo No se encuentra "git" instalado en este equipo.
    echo Instala Git para Windows y vuelve a intentarlo.
    echo.
    pause
    exit /b 1
)

echo Comprobando cambios locales sin guardar...
for /f "delims=" %%L in ('git status --porcelain') do set DIRTY=1
if defined DIRTY (
    echo.
    echo Aviso: hay cambios locales sin confirmar en la carpeta del proyecto.
    echo Si continuas, "git pull" podria fallar o mezclarlos con la version nueva.
    echo.
    set /p CONTINUE="¿Continuar de todas formas? (S/N): "
    if /i not "!CONTINUE!"=="S" (
        echo Cancelado.
        pause
        exit /b 0
    )
)

echo.
echo Descargando la ultima version...
git pull
if errorlevel 1 (
    echo.
    echo No se pudo descargar la actualizacion. Revisa el mensaje de arriba.
    pause
    exit /b 1
)

echo.
echo Instalando dependencias...
call npm install
if errorlevel 1 (
    echo.
    echo Fallo al instalar las dependencias. Revisa el mensaje de arriba.
    pause
    exit /b 1
)

echo.
echo Compilando la interfaz web...
call npm run build
if errorlevel 1 (
    echo.
    echo Fallo al compilar la interfaz. Revisa el mensaje de arriba.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Actualizacion completada
echo ============================================
echo.
set /p RESTART="¿Reiniciar el servidor ahora? (S/N): "
if /i "%RESTART%"=="S" (
    call "%~dp0iniciar.bat"
) else (
    echo Recuerda ejecutar "iniciar.bat" para arrancar el servidor con los cambios.
    pause
)
