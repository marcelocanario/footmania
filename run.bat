@echo off
setlocal
title Footmania - Dev Runner
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "backend\node_modules" (
  echo [WARN] Backend dependencies are missing. Run: cd backend ^&^& npm install
)
if not exist "frontend\node_modules" (
  echo [WARN] Frontend dependencies are missing. Run: cd frontend ^&^& npm install
)

echo ============================================================
echo   Footmania - starting development servers
echo   Backend : http://localhost:3001
echo   Frontend: http://localhost:5173
echo   Stop the servers by closing their windows or pressing Ctrl+C.
echo ============================================================
echo.

start "Footmania Backend" /D "%~dp0backend" cmd /k "npm run db:upgrade && npm run dev"
start "Footmania Frontend" /D "%~dp0frontend" cmd /k "npm run dev"

echo Both servers are launching in separate windows.
timeout /t 3 >nul
endlocal
