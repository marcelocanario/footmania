@echo off
setlocal
title Footmania - Frontend
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "frontend\node_modules" (
  echo [WARN] Frontend dependencies are missing. Run: cd frontend ^&^& npm install
)

echo ============================================================
echo   Footmania - starting frontend
echo   Frontend: http://localhost:5173
echo   Stop the server by closing this window or pressing Ctrl+C.
echo ============================================================
echo.

start "Footmania Frontend" /D "%~dp0frontend" cmd /k "npm run dev"

echo Frontend is launching in a separate window.
timeout /t 3 >nul
endlocal
