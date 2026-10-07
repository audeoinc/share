@echo off
rem cdock.cmd [dir] — PowerShell の実行ポリシーを気にせず起動する
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0cdock.ps1" %*
