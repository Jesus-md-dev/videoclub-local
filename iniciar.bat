@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="__run__" goto :run

rem "silencioso" lo pasa el acceso directo de inicio automatico (ver
rem server/autostart.js): sin aviso de "Servidor en marcha" en cada encendido.
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -ArgumentList '__run__ %~1' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
exit /b 0

:run
title Videoclub Local - Iniciar servidor

rem Si ya habia un vigilante (server\supervisor.js) en marcha, se para con
rem todo su arbol (servidor y ffmpeg): si solo se matara el servidor, el
rem vigilante viejo lo volveria a levantar. Se comprueba que ese PID sea de
rem verdad el vigilante, por si Windows ha reutilizado el numero.
powershell -NoProfile -Command "$p = Get-Content 'supervisor.pid' -ErrorAction SilentlyContinue; if ($p) { $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p); if ($proc -and $proc.CommandLine -match 'supervisor\.js') { taskkill /PID $p /T /F | Out-Null } }; Remove-Item 'supervisor.pid' -ErrorAction SilentlyContinue"

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
    taskkill /F /PID %%P >nul 2>&1
)

if not exist "node_modules" (
    call :avisar "No se encuentran las dependencias instaladas todavia. Ejecuta primero actualizar.bat."
    exit /b 1
)

rem Solo se recompila la web si algo de client\ es mas nuevo que la ultima
rem compilacion (client\dist\index.html): compilar en cada arranque eran
rem unos segundos tirados casi siempre (issue #137). Tras actualizar.bat,
rem git deja los archivos cambiados con fecha nueva y se recompila sola.
powershell -NoProfile -Command ^
  "$dist = 'client\dist\index.html'; if (-not (Test-Path $dist)) { exit 1 };" ^
  "$t = (Get-Item $dist).LastWriteTime;" ^
  "$paths = @('client\src', 'client\public', 'client\index.html', 'client\package.json', 'client\package-lock.json', 'client\vite.config.js');" ^
  "$newer = Get-ChildItem $paths -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $t } | Select-Object -First 1;" ^
  "if ($newer) { exit 1 } else { exit 0 }"
if errorlevel 1 (
    call npm run build >build.log 2>&1
    if errorlevel 1 (
        call :avisar "Fallo al compilar la interfaz web. Revisa build.log para mas detalle."
        exit /b 1
    )
)

rem El vigilante arranca el servidor, lo relanza si se cae o se cuelga y
rem permite reiniciarlo desde la web cuando este libre (issue #140).
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server\supervisor.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0server.log' -RedirectStandardError '%~dp0server-error.log'"

rem 127.0.0.1 y no localhost: el servidor solo escucha en IPv4 y, desde
rem PowerShell, localhost prueba antes IPv6 y tarda ~2 s en caer a IPv4 -
rem con 1 s de margen por intento no respondia nunca y salia siempre el
rem aviso de "no respondio a tiempo" aunque el servidor estuviera en marcha.
powershell -NoProfile -Command ^
  "$ok = $false; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break } catch { Start-Sleep -Milliseconds 1000 } }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
    call :avisar "El servidor no respondio a tiempo. Revisa server.log y server-error.log."
    exit /b 1
)

if not "%~2"=="silencioso" call :avisar "Servidor en marcha en http://localhost:3000. Para detenerlo, ejecuta detener.bat."
exit /b 0

:avisar
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('%~1', 'Videoclub Local')" >nul 2>&1
goto :eof
