@echo off
setlocal
title Footmania - Backend
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

echo ============================================================
echo   Footmania - starting backend
echo   Backend : http://localhost:3001
echo   Stop the server by closing this window or pressing Ctrl+C.
echo ============================================================
echo.

start "Footmania Backend" /D "%~dp0backend" cmd /k "npm run db:upgrade && npm run db:seed-name-pools && npm run dev"

echo Backend is launching in a separate window.
timeout /t 3 >nul
endlocal
