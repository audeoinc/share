@echo off
rem Claude Rogue (light) - double-click to start (your browser opens automatically).
rem Uses the Claude Code already installed on this PC (the bundled copy is not installed).
rem Usage: start.cmd [working folder]   (default: this folder; you can change it later from the bar at the top of the page)
setlocal
cd /d "%~dp0app"
set "CDOCK_LIGHT=1"
if "%CDOCK_CLAUDE_PATH%"=="" set "CDOCK_CLAUDE_PATH=auto"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js ^(https://nodejs.org/^) and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing the required components. This takes a few minutes...
  call npm install --omit=optional --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Please check your network connection.
    pause
    exit /b 1
  )
)
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=%~dp0."
node server.js --cwd "%TARGET%" --open
if errorlevel 1 pause
