# ==============================================================================
# TradingView Advanced Multi-Condition Alert Generator — PowerShell Runner
# ==============================================================================

$PSScriptRoot = Split-Path -Parent -Path $MyInvocation.MyCommand.Definition
Set-Location -Path $PSScriptRoot

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "   TRADINGVIEW ADVANCED MULTI-CONDITION ALERT GENERATOR - LOCAL PC SERVICE   " -ForegroundColor Cyan
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is not installed or not in your system PATH!" -ForegroundColor Red
    Write-Host "Please install Node.js (version 20 or higher) from https://nodejs.org"
    Read-Host "Press Enter to exit"
    exit 1
}

$nodeVersion = node -v
Write-Host "[INFO] Detected Node.js version: $nodeVersion" -ForegroundColor Green
Write-Host "[INFO] Working Directory: $PSScriptRoot"

# 2. Check .env
if (-not (Test-Path "$PSScriptRoot\.env")) {
    if (Test-Path "$PSScriptRoot\.env.example") {
        Write-Host "[INFO] Initializing .env from .env.example..." -ForegroundColor Yellow
        Copy-Item "$PSScriptRoot\.env.example" "$PSScriptRoot\.env"
    }
}

# 3. Check dependencies (express, ws)
$needInstall = $false
if (-not (Test-Path "$PSScriptRoot\node_modules\express")) { $needInstall = $true }
if (-not (Test-Path "$PSScriptRoot\node_modules\ws")) { $needInstall = $true }

if ($needInstall) {
    Write-Host "[INFO] Required packages (express, ws) not found in node_modules." -ForegroundColor Yellow
    Write-Host "[INFO] Running 'npm install'... Please wait a moment." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] npm install failed! Please check your internet connection." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "[INFO] Dependencies installed successfully!" -ForegroundColor Green
}

# 4. Port Check
$servicePort = 3000
try {
    $port3000Busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($port3000Busy) {
        Write-Host "[NOTICE] Port 3000 is occupied. Automatically routing to port 3001!" -ForegroundColor Yellow
        $servicePort = 3001
    }
} catch {
    # If Get-NetTCPConnection is restricted, server.js handles EADDRINUSE automatically
}

Write-Host ""
Write-Host "[INFO] Web Management Console Port: $servicePort" -ForegroundColor Cyan
Write-Host "[INFO] WebSocket Extension Bridge Port: 8765 (and $servicePort)" -ForegroundColor Cyan
Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "Service is launching: http://localhost:$servicePort" -ForegroundColor Green
Write-Host "Press Ctrl+C anytime to stop." -ForegroundColor Gray
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""

$env:SERVICE_PORT = "$servicePort"
$env:PORT = "$servicePort"
node server.js
