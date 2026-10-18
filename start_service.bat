@echo off
setlocal enabledelayedexpansion

:: 1. Force working directory to the folder containing this batch file (handles paths with spaces)
cd /d "%~dp0"

title TradingView Multi-Condition Alert Generator — Local PC Service
echo ==============================================================================
echo    TRADINGVIEW ADVANCED MULTI-CONDITION ALERT GENERATOR - LOCAL PC SERVICE
echo ==============================================================================
echo.

:: 2. Verify Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js was not detected in your system PATH!
    echo Please install Node.js (version 20 or higher) from: https://nodejs.org
    echo After installing, restart your terminal or PC and run this again.
    echo.
    echo Press any key to exit...
    pause >nul
    exit /b 1
)

echo [INFO] Working Directory: %CD%
echo [INFO] Detected Node.js version:
node -v
echo.

:: 3. Ensure .env exists (copy from .env.example if missing)
if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        echo [INFO] Initializing .env configuration from .env.example...
        copy "%~dp0.env.example" "%~dp0.env" >nul
    )
)

:: 4. Validate Local PC Service dependencies (specifically express and ws)
set NEED_INSTALL=0
if not exist "%~dp0node_modules\express" set NEED_INSTALL=1
if not exist "%~dp0node_modules\ws" set NEED_INSTALL=1

if "%NEED_INSTALL%"=="1" (
    echo [INFO] Installing required service dependencies (express, ws)...
    echo [INFO] Running 'npm install'... Please wait a moment.
    echo.
    call npm install
    if !errorlevel! neq 0 (
        echo [NOTICE] Retrying via npm.cmd...
        call npm.cmd install
    )
    if !errorlevel! neq 0 (
        echo.
        echo [ERROR] Failed to run 'npm install'!
        echo Please ensure you have an active internet connection, then run:
        echo    npm install
        echo manually in this directory.
        pause
        exit /b 1
    )
    echo.
    echo [INFO] Dependencies installed successfully!
    echo.
)

:: 5. Port collision check: Check if port 3000 is occupied
set SERVICE_PORT=3000
netstat -ano | findstr /C:":3000 " >nul 2>nul
if %errorlevel% equ 0 (
    echo [NOTICE] Port 3000 is occupied by another application.
    echo [NOTICE] Automatically routing Web Management Console to port 3001!
    set SERVICE_PORT=3001
)

:: If port 3001 is also in use, route to 3050
if "%SERVICE_PORT%"=="3001" (
    netstat -ano | findstr /C:":3001 " >nul 2>nul
    if !errorlevel! equ 0 (
        echo [NOTICE] Port 3001 is also occupied. Routing to port 3050!
        set SERVICE_PORT=3050
    )
)

echo [INFO] Authoritative Service Port: %SERVICE_PORT% (REST API + WebSocket Bridge)
echo.
echo ==============================================================================
echo [INFO] Service is launching at http://localhost:%SERVICE_PORT%
echo [INFO] Logs will appear below. Press Ctrl+C anytime to stop the service.
echo ==============================================================================
echo.

:: 6. Launch server with SERVICE_PORT environment variable set
set PORT=%SERVICE_PORT%
node server.js

:: 7. Never blink and close — always keep the console window open so user can inspect logs/errors
echo.
echo ==============================================================================
echo [INFO] Local PC Service process has ended (exit code: %errorlevel%).
echo [INFO] If this was unexpected, review the log messages above.
echo ==============================================================================
echo Press any key to close this window...
pause >nul
