@echo off
setlocal
cd /d "%~dp0"
title Videoclub Local - Crear acceso directo

rem Un .bat no puede llevar icono propio: se crea un acceso directo
rem "Videoclub Local" a iniciar.bat con assets\videoclub.ico, en el
rem escritorio y en el menu Inicio (desde ahi se puede anclar a la barra de
rem tareas o a Inicio). Volver a ejecutarlo solo sobrescribe los accesos,
rem por ejemplo si se mueve la carpeta del proyecto.

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'));" ^
  "foreach ($d in $dirs) {" ^
  "  $lnk = $ws.CreateShortcut((Join-Path $d 'Videoclub Local.lnk'));" ^
  "  $lnk.TargetPath = '%~dp0iniciar.bat';" ^
  "  $lnk.WorkingDirectory = '%~dp0';" ^
  "  $lnk.IconLocation = '%~dp0assets\videoclub.ico,0';" ^
  "  $lnk.Description = 'Arrancar el servidor de Videoclub Local';" ^
  "  $lnk.WindowStyle = 7;" ^
  "  $lnk.Save();" ^
  "  Write-Host ('Creado: ' + $lnk.FullName)" ^
  "}"

echo.
pause
