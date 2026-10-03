@echo off
rem uninstall.cmd - remove the DSH Launcher tray installed by install.cmd.
rem Extra arguments are forwarded, for example:
rem   uninstall.cmd -KeepState            keep the tray logs in state\
rem   uninstall.cmd -DryRun               report what would be removed, change nothing
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
