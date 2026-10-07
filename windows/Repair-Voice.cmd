@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Repair-Voice.ps1" %*
exit /b %ERRORLEVEL%
