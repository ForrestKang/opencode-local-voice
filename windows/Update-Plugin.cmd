@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Plugin.ps1" %*
set "VoiceUpdateExit=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %VoiceUpdateExit%
