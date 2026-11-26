@echo off
rem Starts everything for local development, each in its own window:
rem   1. Postgres (npm run db:start)         port 54329
rem   2. migrations + demo seed               (runs here, once)
rem   3. API server (npm run dev:server)      port 3000, terminals on 8081
rem   4. App (npm run dev)                     http://localhost:5173
rem Close a window (or press Ctrl+C in it) to stop that service.
rem Usage: start-all.cmd            (with demo data)
rem        start-all.cmd --no-demo  (admin and settings only)

setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo [start] Node.js is not installed or not on PATH. & pause & exit /b 1)

if not exist node_modules (
  echo [start] Installing packages...
  call npm install || (echo [start] npm install failed. & pause & exit /b 1)
)

call :port_open 54329
if errorlevel 1 (
  echo [start] Starting Postgres...
  start "SBM HR - Database" cmd /k npm run db:start
) else (
  echo [start] Postgres is already running on port 54329.
)

echo [start] Waiting for Postgres...
set /a tries=0
:wait_db
call :port_open 54329
if not errorlevel 1 goto db_ready
set /a tries+=1
if %tries% geq 90 (echo [start] Postgres did not start within 90 seconds. Check the Database window. & pause & exit /b 1)
timeout /t 1 /nobreak >nul
goto wait_db
:db_ready

echo [start] Applying migrations...
call npm run db:deploy || (echo [start] Migrations failed. & pause & exit /b 1)

if /i "%~1"=="--no-demo" (
  call npm run seed || (echo [start] Seed failed. & pause & exit /b 1)
) else (
  call npm run seed:demo || (echo [start] Seed failed. & pause & exit /b 1)
)

call :port_open 3000
if errorlevel 1 (
  start "SBM HR - Server" cmd /k npm run dev:server
) else (
  echo [start] Something is already listening on port 3000; not starting another server.
)

call :port_open 5173
if errorlevel 1 (
  start "SBM HR - App" cmd /k npm run dev
) else (
  echo [start] Something is already listening on port 5173; not starting another app.
)

echo [start] Waiting for the app...
set /a tries=0
:wait_app
call :port_open 5173
if not errorlevel 1 goto app_ready
set /a tries+=1
if %tries% geq 60 goto app_ready
timeout /t 1 /nobreak >nul
goto wait_app
:app_ready

start "" http://localhost:5173
echo.
echo [start] All services are up:
echo           App      http://localhost:5173
echo           API      http://localhost:3000/api/health
echo           Database localhost:54329
echo [start] Admin password: SEED_ADMIN_PASSWORD in .env
echo [start] Close the service windows to stop them.
endlocal
exit /b 0

rem Exit code 0 if something is listening on localhost:%1, 1 otherwise.
:port_open
node -e "require('net').connect(%1,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
exit /b %errorlevel%
