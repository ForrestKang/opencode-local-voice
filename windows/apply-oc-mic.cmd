@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-oc-mic.ps1" %*
exit /b %ERRORLEVEL%
