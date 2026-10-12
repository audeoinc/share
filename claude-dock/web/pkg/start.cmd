@echo off
rem Claude Rogue - double-click to start (your browser opens automatically).
rem Uses the Claude Code already installed on this PC (a copy is not bundled).
rem Usage: start.cmd [--no-open] [working folder]
rem   --no-open        do not open the browser (holding Shift while double-clicking does the same)
rem   working folder   default: this folder (you can change it later from the bar at the top of the page)
setlocal
rem Remember where this file is first: "shift" below also shifts %0, which would change %~dp0.
set "HERE=%~dp0"
cd /d "%HERE%app"
set "CDOCK_LIGHT=1"
if "%CDOCK_CLAUDE_PATH%"=="" set "CDOCK_CLAUDE_PATH=auto"
set "OPENFLAG=--open"
set "TARGET="
:args
if "%~1"=="" goto argsdone
if /i "%~1"=="--no-open" (
  set "OPENFLAG="
) else (
  if "%TARGET%"=="" set "TARGET=%~1"
)
shift
goto args
:argsdone
if "%TARGET%"=="" set "TARGET=%HERE%."
rem Check the Shift key right away (while the double-click is still fresh), before any slow step.
if defined OPENFLAG (
  for /f "usebackq" %%S in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; if ([int][System.Windows.Forms.Control]::ModifierKeys -band 65536) {'1'} else {'0'}" 2^>nul`) do (
    if "%%S"=="1" (
      set "OPENFLAG="
      echo Shift key detected: the browser will not be opened.
    )
  )
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js ^(https://nodejs.org/^) and run this again.
  pause
  exit /b 1
)
rem Install the components on the first run, and again whenever package-lock.json changed (e.g. after overwriting this folder with a newer zip).
set "NEEDINSTALL="
if not exist node_modules set "NEEDINSTALL=1"
if not defined NEEDINSTALL (
  fc /b package-lock.json node_modules\.crogue-lock.json >nul 2>&1 || set "NEEDINSTALL=1"
)
if defined NEEDINSTALL (
  echo Installing the required components. This takes a few minutes on the first run...
  call npm install --omit=optional --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Please check your network connection.
    pause
    exit /b 1
  )
  copy /y package-lock.json node_modules\.crogue-lock.json >nul
)
node server.js --cwd "%TARGET%" %OPENFLAG%
if errorlevel 1 pause
