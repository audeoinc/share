@echo off
rem Claude Rogue launcher (light): uses the Claude Code already installed on this PC.
rem Does not install the bundled copy (about 250MB less). Needs the same Claude Code version as the SDK (see README).
rem usage: start-light.cmd [folder]   (set CDOCK_CLAUDE_PATH to a claude.exe path to choose which one)
setlocal
cd /d "%~dp0"
set "CDOCK_LIGHT=1"
if "%CDOCK_CLAUDE_PATH%"=="" set "CDOCK_CLAUDE_PATH=auto"
if not exist node_modules (call npm install --omit=optional --no-audit --no-fund)
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%CD%"
node server.js --cwd "%TARGET%"
