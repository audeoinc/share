@echo off
rem Claude Rogue launcher: start.cmd [folder]  (installs dependencies on first run)
setlocal
cd /d "%~dp0"
if not exist node_modules (call npm install --no-audit --no-fund)
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%CD%"
node server.js --cwd "%TARGET%"
