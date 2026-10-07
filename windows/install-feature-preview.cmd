@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-feature-preview.ps1" %*
set "VoiceFeatureExit=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %VoiceFeatureExit%
