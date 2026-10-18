#!/usr/bin/env bash
# ==============================================================================
# TradingView Advanced Multi-Condition Alert Generator — Local PC Service Runner
# ==============================================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "=============================================================================="
echo "   TRADINGVIEW ADVANCED MULTI-CONDITION ALERT GENERATOR - LOCAL PC SERVICE   "
echo "=============================================================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "❌ [ERROR] Node.js is not installed or not in PATH."
    echo "Please install Node.js (version 20+) from https://nodejs.org"
    exit 1
fi

echo "✓ Node.js detected: $(node -v)"

if [ ! -d "node_modules/ws" ]; then
    echo "📦 Installing required dependencies..."
    npm install
fi

# Port collision check: Check if port 3000 is occupied
SERVICE_PORT=3000
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1 || nc -z localhost 3000 >/dev/null 2>&1; then
    echo "⚠️ [NOTICE] Port 3000 is already in use by another application."
    echo "⚠️ [NOTICE] Automatically routing Web Management Console to port 3001!"
    SERVICE_PORT=3001
fi

echo ""
echo "🚀 Launching Local PC Service on http://localhost:${SERVICE_PORT} & ws://localhost:${SERVICE_PORT}..."
echo "Press Ctrl+C to stop the service."
echo "=============================================================================="
echo ""

PORT=$SERVICE_PORT SERVICE_PORT=$SERVICE_PORT exec node server.js
