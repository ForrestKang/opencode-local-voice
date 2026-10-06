@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install Node LTS first ^(winget install OpenJS.NodeJS.LTS^).
  pause
  exit /b 1
)

echo [1/4] generating patched app.asar ...
node patch-oc-mic.js
if errorlevel 1 (
  echo.
  echo Patch generation FAILED - nothing was changed.
  pause
  exit /b 1
)

set RES=%LOCALAPPDATA%\Programs\@opencode-aidesktop\resources
if not exist "%RES%\app.asar" (
  echo OpenCode Desktop not found at %RES%.
  pause
  exit /b 1
)

echo [2/4] closing OpenCode ...
taskkill /IM OpenCode.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo [3/4] installing patched app.asar ...
if not exist "%~dp0app.asar.original" copy /y "%RES%\app.asar" "%~dp0app.asar.original" >nul
copy /y "%RES%\app.asar" "%~dp0app.asar.bak" >nul
copy /y "app.asar.patched" "%RES%\app.asar" >nul
if errorlevel 1 (
  echo Copy failed - restoring backup ...
  copy /y "%~dp0app.asar.bak" "%RES%\app.asar" >nul
  pause
  exit /b 1
)

echo [4/4] restarting OpenCode ...
start "" "%LOCALAPPDATA%\Programs\@opencode-aidesktop\OpenCode.exe"
echo.
echo Done. A microphone button appears on the prompt toolbar.
timeout /t 4 /nobreak >nul
