@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found in PATH. Please install Node.js 22+ or start from the configured developer terminal.
  pause
  exit /b 1
)
echo Agent Tool Center is starting...
echo Open http://127.0.0.1:4173 in a browser.
echo Press Ctrl+C to stop.
node src\server.mjs
if errorlevel 1 pause
