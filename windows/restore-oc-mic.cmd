@echo off
setlocal
cd /d "%~dp0"

set SRC=%~dp0app.asar.original
if not exist "%SRC%" set SRC=%~dp0app.asar.bak
if not exist "%SRC%" (
  echo No backup found ^(app.asar.original / app.asar.bak^).
  pause
  exit /b 1
)

set RES=%LOCALAPPDATA%\Programs\@opencode-aidesktop\resources
if not exist "%RES%\app.asar" (
  echo OpenCode Desktop not found at %RES%.
  pause
  exit /b 1
)

taskkill /IM OpenCode.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

copy /y "%SRC%" "%RES%\app.asar" >nul
start "" "%LOCALAPPDATA%\Programs\@opencode-aidesktop\OpenCode.exe"
echo Restored original app.asar and restarted OpenCode.
timeout /t 4 /nobreak >nul
