@echo off
rem cdock.cmd [dir] - launch without worrying about the PowerShell execution policy
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cdock.ps1" %*
