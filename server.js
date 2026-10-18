/**
 * server.js — Tier 3 Local PC Service & Central Bridge
 * Express REST + WebSocket Server handling:
 *  - Multi-tab TradingView data streams on ws://localhost:8765 (and port 3000)
 *  - Rule persistence & evaluation lifecycle
 *  - Telegram notifications dispatch
 *  - Real-time client synchronization (Popup UI, web dashboard, background worker)
 *  - Automated 30-day database pruning
 */
// Self-healing: verify required third-party modules; auto-install via npm if missing
function ensureDependencies() {
  const missing = [];
  try { require.resolve('express'); } catch (_) { missing.push('express'); }
  try { require.resolve('ws'); } catch (_) { missing.push('ws'); }

  if (missing.length > 0) {
    console.log('\n==============================================================================');
    console.log(`[Local PC Service] Required packages missing: ${missing.join(', ')}.`);
    console.log('[Local PC Service] Automatically running "npm install" now. Please wait...');
    console.log('==============================================================================\n');
    const { execSync } = require('child_process');
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      execSync(`${npmCmd} install`, { stdio: 'inherit', cwd: __dirname, shell: true });
      console.log('\n✓ Required packages installed successfully! Resuming service startup...\n');
    } catch (installErr) {
      try {
        execSync('npm install', { stdio: 'inherit', cwd: __dirname, shell: true });
        console.log('\n✓ Required packages installed successfully! Resuming service startup...\n');
      } catch (err2) {
        console.error('\n❌ Automatic "npm install" failed: ' + installErr.message);
        console.error('Please open terminal in this folder and run:');
        console.error('   npm install');
        console.error('\nThen retry starting the service.\n');
        process.exit(1);
      }
    }
  }
}
ensureDependencies();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

const db = require('./db');
const AlertEngine = require('./engine');
const telegram = require('./telegram');

// Initialize database schema
db.initSchema();

// Initialize Alert Engine
const engine = new AlertEngine({ bufferSize: 300 });

// Wire Engine events to Telegram and WebSocket Broadcasts
engine.on('alertTriggered', async (data) => {
  console.log(`[ALERT TRIGGERED] Rule: "${data.rule.name}" (${data.rule.symbol} [${data.rule.timeframe}])`);
  
  // Broadcast to all connected WebSockets (extension background, popup, web UI)
  broadcastWs({
    type: 'ALERT_TRIGGERED',
    alert: data.alert,
    rule: data.rule,
    snapshot: data.snapshot
  });

  // Dispatch to Telegram Bot asynchronously
  try {
    const tgResult = await telegram.dispatchAlert(data);
    if (!tgResult.ok) {
      console.warn(`[Telegram] Dispatch warning: ${tgResult.error}`);
    }
  } catch (tgErr) {
    console.error('[Telegram] Unexpected error during dispatch:', tgErr);
  }
});

engine.on('ruleStateChanged', (data) => {
  broadcastWs({
    type: 'RULE_STATE_CHANGED',
    ...data
  });
});

engine.on('tabUpdated', (tabs) => {
  broadcastWs({
    type: 'TAB_UPDATE',
    tabs
  });
});

// Hourly 30-day database cleanup job
setInterval(() => {
  try {
    const pruneStats = db.pruneOldHistory(30);
    console.log(`[DB Prune] Retaining 30-day history. Pruned: ${pruneStats.prunedSnapshots} snapshots, ${pruneStats.prunedAlerts} alerts.`);
  } catch (err) {
    console.error('[DB Prune] Error pruning old history:', err);
  }
}, 60 * 60 * 1000);

// Initialize Express App
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets
app.use(express.static(__dirname, {
  extensions: ['html', 'js', 'json', 'css', 'png', 'svg'],
  index: false
}));

// CORS headers for local extension communication
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ==================== REST API ROUTES ====================

// Health check for background service worker pre-flight probe
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'online', timestamp: Date.now() });
});

// Status & diagnostics
app.get('/api/status', (req, res) => {
  const rules = db.getAllRules();
  const tabs = engine.getConnectedTabs();
  const alerts = db.getTriggeredAlerts(10, 0);

  res.json({
    status: 'online',
    app: 'TradingView Advanced Multi-Condition Alert Generator',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    connectedTabsCount: tabs.length,
    tabs: tabs,
    totalRulesCount: rules.length,
    activeRulesCount: rules.filter(r => r.status.startsWith('ACTIVE')).length,
    pausedRulesCount: rules.filter(r => r.status === 'PAUSED_DATA_UNAVAILABLE').length,
    recentAlerts: alerts
  });
});

// Rules CRUD
app.get('/api/rules', (req, res) => {
  try {
    const rules = db.getAllRules().map(r => {
      let tree = {};
      try { tree = JSON.parse(r.condition_tree); } catch (e) {}
      return { ...r, condition_tree: tree };
    });
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rules', (req, res) => {
  try {
    const { name, symbol, timeframe, condition_tree, trigger_mode } = req.body;
    if (!name || !symbol || !timeframe || !condition_tree) {
      return res.status(400).json({ error: 'Missing required fields: name, symbol, timeframe, condition_tree' });
    }

    const created = db.createRule({
      name,
      symbol,
      timeframe,
      condition_tree,
      trigger_mode: trigger_mode || 'BOTH'
    });

    engine.loadRulesFromDb();
    broadcastWs({ type: 'RULES_UPDATED' });
    res.status(201).json({ rule: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export all alert rules (Cross-Browser Transfer Backup)
app.get('/api/rules/export', (req, res) => {
  try {
    const rawRules = db.getAllRules();
    const rules = rawRules.map(r => {
      let tree = {};
      try { tree = typeof r.condition_tree === 'string' ? JSON.parse(r.condition_tree) : r.condition_tree; } catch (e) {}
      return {
        ...r,
        condition_tree: tree
      };
    });
    res.json({
      version: '2.0.0',
      app: 'TradingView Multi-Condition Alert Generator',
      exported_at: new Date().toISOString(),
      count: rules.length,
      rules
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import alert rules (Cross-Browser Transfer Restore)
app.post('/api/rules/import', (req, res) => {
  try {
    let inputRules = [];
    let mode = 'merge';

    if (Array.isArray(req.body)) {
      inputRules = req.body;
    } else if (req.body && Array.isArray(req.body.rules)) {
      inputRules = req.body.rules;
      mode = req.body.mode || 'merge';
    } else {
      return res.status(400).json({ error: 'Invalid payload: expected an array of rules or { rules: [...] } object' });
    }

    if (mode === 'replace') {
      const existing = db.getAllRules();
      for (const ex of existing) {
        db.deleteRule(ex.id);
      }
    }

    let importedCount = 0;
    for (const r of inputRules) {
      if (!r.name || !r.symbol || !r.timeframe || !r.condition_tree) continue;
      const treeJson = typeof r.condition_tree === 'string' ? r.condition_tree : JSON.stringify(r.condition_tree);
      db.createRule({
        id: r.id && mode !== 'replace' ? undefined : r.id,
        name: r.name,
        symbol: r.symbol,
        timeframe: r.timeframe,
        condition_tree: treeJson,
        status: r.status || 'ACTIVE_FALSE'
      });
      importedCount++;
    }

    engine.loadRulesFromDb();
    broadcastWs({ type: 'RULES_UPDATED' });
    res.json({ success: true, count: importedCount, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rules/:id', (req, res) => {
  try {
    const rule = db.getRuleById(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    let tree = {};
    try { tree = JSON.parse(rule.condition_tree); } catch (e) {}
    res.json({ rule: { ...rule, condition_tree: tree } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rules/:id', (req, res) => {
  try {
    const updated = db.updateRule(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Rule not found' });

    engine.loadRulesFromDb();
    broadcastWs({ type: 'RULES_UPDATED' });
    res.json({ rule: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/rules/:id', (req, res) => {
  try {
    const deleted = db.deleteRule(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Rule not found' });

    engine.ruleStates.delete(req.params.id);
    broadcastWs({ type: 'RULES_UPDATED' });
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rules/:id/toggle', (req, res) => {
  try {
    const rule = db.getRuleById(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    const newStatus = rule.status === 'DISABLED' ? 'ACTIVE_FALSE' : 'DISABLED';
    db.updateRule(req.params.id, { status: newStatus, missing_reason: null });
    engine.loadRulesFromDb();

    broadcastWs({ type: 'RULES_UPDATED' });
    res.json({ success: true, id: rule.id, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Triggered Alerts History
app.get('/api/alerts', (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = parseInt(req.query.offset, 10) || 0;
    const ruleId = req.query.rule_id || null;
    const alerts = db.getTriggeredAlerts(limit, offset, ruleId);

    const parsed = alerts.map(a => {
      let snap = {};
      try { snap = JSON.parse(a.snapshot_json); } catch (e) {}
      return { ...a, snapshot: snap };
    });

    res.json({ alerts: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snapshots History
app.get('/api/snapshots', (req, res) => {
  try {
    const { symbol, timeframe } = req.query;
    if (!symbol || !timeframe) {
      return res.status(400).json({ error: 'symbol and timeframe query parameters required' });
    }
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const snapshots = db.getRecentSnapshots(symbol, timeframe, limit);

    const parsed = snapshots.map(s => {
      let ohlcv = {}, indicators = {};
      try { ohlcv = JSON.parse(s.ohlcv_json); } catch (e) {}
      try { indicators = JSON.parse(s.indicators_json); } catch (e) {}
      return { ...s, ohlcv, indicators };
    });

    res.json({ snapshots: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Active Tabs
app.get('/api/tabs', (req, res) => {
  res.json({ tabs: engine.getConnectedTabs() });
});

// Latest Indicators & Snapshots (for instant Rule Builder auto-discovery even when bridge is idle)
app.get('/api/latest-indicators', (req, res) => {
  try {
    const { symbol, timeframe } = req.query;
    const snap = db.getLatestSnapshot(symbol || null, timeframe || null);
    if (!snap) {
      return res.json({ ok: false, message: 'No snapshots recorded yet' });
    }
    const ohlcv = typeof snap.ohlcv_json === 'string' ? JSON.parse(snap.ohlcv_json) : snap.ohlcv_json;
    const indicators = typeof snap.indicators_json === 'string' ? JSON.parse(snap.indicators_json) : snap.indicators_json;
    res.json({
      ok: true,
      symbol: snap.symbol,
      timeframe: snap.timeframe,
      timestamp: snap.timestamp,
      is_candle_close: snap.is_candle_close,
      ohlcv,
      indicators
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// App Settings (Secure: never exposes raw Telegram Bot Token to frontend)
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.getAllSettings();
    const creds = telegram.getCredentials();
    const hasTgBackend = !!(creds.token && creds.chatId);

    const safeSettings = {
      ...settings,
      telegram_configured: hasTgBackend,
      telegram_source: process.env.TELEGRAM_BOT_TOKEN ? '.env (Backend Environment)' : (settings.telegram_bot_token ? 'Backend Service Config' : 'Not configured'),
      telegram_chat_id_masked: creds.chatId ? (creds.chatId.length > 5 ? '***' + creds.chatId.slice(-4) : '***') : '',
    };
    // Ensure raw bot token is never exposed to the client
    delete safeSettings.telegram_bot_token;

    res.json({ settings: safeSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const updates = req.body;
    for (const [key, val] of Object.entries(updates)) {
      db.setSetting(key, val);
    }
    res.json({ success: true, settings: db.getAllSettings() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test Telegram notification (backend execution)
app.post('/api/test-telegram', async (req, res) => {
  try {
    const { bot_token, chat_id } = req.body || {};
    // If not passed in body, telegram.testConnection will use backend .env credentials
    const result = await telegram.testConnection(bot_token || null, chat_id || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Test Discord notification
app.post('/api/test-discord', async (req, res) => {
  try {
    const { webhook_url } = req.body || {};
    const dummyAlert = {
      rule: { name: 'Test Discord Rule', symbol: 'BTCUSDT', timeframe: '5m' },
      alert: { id: 'test_discord', triggered_at: new Date().toISOString(), is_candle_close: 1 },
      snapshot: { ohlcv: { open: 65000, high: 65500, low: 64800, close: 65400, volume: 120000 } }
    };
    const result = await telegram.sendDiscord(webhook_url, dummyAlert);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Simulate a live tick (interactive testing of edge triggers & intrabar reversals)
app.post('/api/simulate-tick', (req, res) => {
  try {
    const {
      symbol = 'TEST_SYM',
      timeframe = '1m',
      tabId = 'tab_simulator',
      is_candle_close = 0,
      ohlcv = {},
      indicators = {}
    } = req.body || {};

    const payload = {
      tabId,
      symbol: symbol.toUpperCase(),
      timeframe,
      timestamp: Date.now(),
      is_candle_close: is_candle_close ? 1 : 0,
      ohlcv: {
        open: ohlcv.open ?? 100,
        high: ohlcv.high ?? 105,
        low: ohlcv.low ?? 99,
        close: ohlcv.close ?? 103,
        volume: ohlcv.volume ?? 1000
      },
      indicators
    };

    const result = engine.ingestPayload(payload);
    res.json({ success: true, payload, evaluationResult: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// HTTP Payload Ingestion (alternative to WebSockets for testing or lightweight clients)
app.post('/api/ingest', (req, res) => {
  try {
    const payload = req.body;
    const result = engine.ingestPayload(payload);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger 30-day prune manually
app.post('/api/prune', (req, res) => {
  try {
    const days = parseInt(req.body.days, 10) || 30;
    const stats = db.pruneOldHistory(days);
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sample CSV files (preserved for backward compatibility)
app.get('/api/samples', (req, res) => {
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.csv'));
    const samples = files.map(filename => {
      const filePath = path.join(__dirname, filename);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n');
      return {
        name: filename,
        sizeBytes: stat.size,
        rows: Math.max(0, lines.length - 1),
        header: lines[0] || '',
        preview: lines.slice(0, 6)
      };
    });
    res.json({ samples });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Run legacy test suite endpoint (preserved for backward compatibility)
app.get('/api/run-tests', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const testProcess = spawn('node', ['tests/run.js'], { cwd: __dirname });
  testProcess.stdout.on('data', (data) => res.write(data));
  testProcess.stderr.on('data', (data) => res.write(data));
  testProcess.on('close', (code) => {
    res.write(`\nTest process exited with code ${code}\n`);
    res.end();
  });
});

// Run Phase 1 Engine & Persistence test suite
app.get('/api/run-phase1-tests', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const testProcess = spawn('node', ['tests/test_phase1.js'], { cwd: __dirname });
  testProcess.stdout.on('data', (data) => res.write(data));
  testProcess.stderr.on('data', (data) => res.write(data));
  testProcess.on('close', (code) => {
    res.write(`\nPhase 1 test process exited with code ${code}\n`);
    res.end();
  });
});

// UI Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/popup', (req, res) => {
  res.sendFile(path.join(__dirname, 'popup.html'));
});

// ==================== WEBSOCKET SERVER ====================

const allWsClients = new Set();

function broadcastWs(msg) {
  const json = JSON.stringify(msg);
  for (const client of allWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(json);
      } catch (e) {}
    }
  }
}

function handleWsConnection(ws, req) {
  allWsClients.add(ws);
  let registeredTabId = null;

  // Send initial welcome & state
  try {
    ws.send(JSON.stringify({
      type: 'INIT',
      status: 'online',
      tabs: engine.getConnectedTabs(),
      timestamp: Date.now()
    }));
  } catch (e) {}

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      const { type, payload } = parsed;

      switch (type) {
        case 'INGEST_PAYLOAD':
        case 'TV_FEED_DATA': {
          if (payload) {
            registeredTabId = payload.tabId || registeredTabId;
            engine.ingestPayload(payload);
            // Broadcast the live tick & indicators to connected extension popups and web UIs
            broadcastWs({ type: 'INGEST_PAYLOAD', payload });
          }
          break;
        }

        case 'REGISTER_CLIENT': {
          // Handshake from popup UI or background service worker
          ws.send(JSON.stringify({
            type: 'REGISTERED',
            status: 'online',
            service: 'TradingView Local PC Bridge',
            timestamp: Date.now()
          }));
          break;
        }

        case 'TAB_REGISTER': {
          if (payload && payload.tabId) {
            registeredTabId = payload.tabId;
            engine.registerTab(payload.tabId, payload.symbol, payload.timeframe);
          }
          break;
        }

        case 'TAB_UNREGISTER': {
          if (payload && payload.tabId) {
            engine.unregisterTab(payload.tabId);
          }
          break;
        }

        case 'PING': {
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[WebSocket] Error parsing message:', err.message);
    }
  });

  ws.on('close', () => {
    allWsClients.delete(ws);
    if (registeredTabId) {
      engine.unregisterTab(registeredTabId);
    }
  });

  ws.on('error', (err) => {
    allWsClients.delete(ws);
  });
}

// ==================== SERVER BINDING ====================

// Support SERVICE_PORT, with fallback to 3000 (AI Studio standard)
const HOST = '0.0.0.0';
const REQUESTED_PORT = parseInt(process.env.SERVICE_PORT || process.env.PORT || '3000', 10);
// Prefer 3000 initially for AI Studio environment compatibility
const INITIAL_PORT = Number.isFinite(REQUESTED_PORT) && REQUESTED_PORT > 0 ? REQUESTED_PORT : 3000;

let activeHttpPort = null;
let primaryServerInstance = null;

function startPrimaryServer(port, retriesLeft = 4) {
  const srv = http.createServer(app);
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', handleWsConnection);

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      const nextPort = (port === 3000) ? 3001 : (port === 3001 ? 3002 : (port === 3002 ? 3050 : port + 1));
      console.warn(`[Primary Server] Port ${port} is occupied. Automatically routing to port ${nextPort}...`);
      startPrimaryServer(nextPort, retriesLeft - 1);
      return;
    }
    console.error(`[Primary Server ${port}] Error: ${err.message}`);
  });

  srv.listen(port, HOST, () => {
    activeHttpPort = port;
    primaryServerInstance = srv;
    console.log(`[Primary Server] Running at http://${HOST}:${port}`);
    console.log(`[Web Management Console] Open http://localhost:${port} in your browser`);
  });

  return { srv, wss };
}

// Start primary authoritative server (REST API + WebSocket Extension Bridge + Web Console)
startPrimaryServer(INITIAL_PORT);

module.exports = { app, engine, db, telegram };
