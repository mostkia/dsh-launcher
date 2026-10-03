@echo off
rem install.cmd - run the DSH Launcher tray installer (ASCII only).
rem Extra arguments are forwarded, for example:
rem   install.cmd -Port 3080 -Dir "%USERPROFILE%\dsh-workspace" -NoShortcut
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
