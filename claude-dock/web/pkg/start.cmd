@echo off
rem Claude Rogue - double-click to start (your browser opens automatically).
rem Usage: start.cmd [working folder]   (default: this folder; you can change it later from the bar at the top of the page)
setlocal
cd /d "%~dp0app"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js ^(https://nodejs.org/^) and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing the required components. This takes a few minutes...
  call npm install --no-audit --no-fund
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
