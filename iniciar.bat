@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="__run__" goto :run

powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList '__run__' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
exit /b 0

:run
title Videoclub Local - Iniciar servidor

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
    taskkill /F /PID %%P >nul 2>&1
)

if not exist "node_modules" (
    call :avisar "No se encuentran las dependencias instaladas todavia. Ejecuta primero actualizar.bat."
    exit /b 1
)

call npm run build >build.log 2>&1
if errorlevel 1 (
    call :avisar "Fallo al compilar la interfaz web. Revisa build.log para mas detalle."
    exit /b 1
)

powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server\index.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server-error.log'"

powershell -NoProfile -Command ^
  "$ok = $false; for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -Uri 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 1 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 1000 } }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
    call :avisar "El servidor no respondio a tiempo. Revisa server.log y server-error.log."
    exit /b 1
)

call :avisar "Servidor en marcha en http://localhost:3000. Para detenerlo, ejecuta detener.bat."
exit /b 0

:avisar
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('%~1', 'Videoclub Local')" >nul 2>&1
goto :eof
