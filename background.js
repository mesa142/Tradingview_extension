/**
 * background.js — Manifest V3 Background Service Worker & Central Bridge
 *
 * Responsibilities:
 *  1. Persistent auto-reconnecting WebSocket bridge to Local PC Service (ws://localhost:8765 / ws://localhost:3000)
 *  2. Multi-tab tracking & lifecycle management (signals tab closures to server to selectively pause rules)
 *  3. Ingestion relay from content.js to Local PC Service
 *  4. Alert dispatcher: Chrome native notifications + offscreen Web Audio playback
 *  5. Offscreen document lifecycle management
 */

'use strict';

const AUTHORITATIVE_PORT = 3000;
const AUTHORITATIVE_WS_URL = 'ws://localhost:3000';
const AUTHORITATIVE_HTTP_URL = 'http://localhost:3000';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

const BADGE_STREAMING = '●';
const BADGE_COLOR = '#2962ff';
const BADGE_ALERT_COLOR = '#ef5350';

let ws = null;
let wsUrl = AUTHORITATIVE_WS_URL;
let isConnected = false;
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const activeTabs = new Map(); // tabId -> { tabId, symbol, timeframe, lastActive }

let lastChartTickAt = 0;
let lastScrapedSymbol = null;
let lastScrapedTf = null;

// -----------------------------------------------------------------------------
// Offscreen Document Management (for MV3 Audio Playback)
// -----------------------------------------------------------------------------

async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  try {
    if (typeof chrome.offscreen.hasDocument === 'function') {
      return await chrome.offscreen.hasDocument();
    }
    // Chrome < 116 fallback
    const matchedClients = await clients.matchAll();
    return matchedClients.some(c => c.url.includes(OFFSCREEN_DOCUMENT_PATH));
  } catch (_) {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return;
  try {
    const exists = await hasOffscreenDocument();
    if (exists) return;

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason?.AUDIO_PLAYBACK || 'AUDIO_PLAYBACK'],
      justification: 'TradingView Multi-Condition Alert Sound Chimes'
    });
  } catch (err) {
    // If document was already created concurrently, ignore
    if (!String(err).includes('single offscreen')) {
      console.warn('[Background] Offscreen creation error:', err);
    }
  }
}

async function playAlertAudio(soundType = 'chime') {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: 'PLAY_ALERT_AUDIO',
      sound: soundType
    }).catch(() => {});
  } catch (err) {
    console.warn('[Background] Audio playback dispatch failed:', err);
  }
}

function cleanTimeframe(val) {
  if (val == null) return '1m';
  if (typeof val === 'object') {
    const cand = val.value ?? val._value ?? val.interval ?? val.resolution ?? val.timeframe ?? val.tf ?? val.name ?? val.label ?? val.shortName ?? val.id ?? val.text;
    if (cand != null && typeof cand !== 'object') {
      return cleanTimeframe(cand);
    }
    return '1m';
  }
  let str = String(val).trim();
  if (!str || str === '—' || str.toLowerCase().includes('object') || str === 'undefined' || str === 'null' || str === 'UNKNOWN') {
    return '1m';
  }
  str = str.replace(/[\[\]"']/g, '').trim();
  const num = Number(str);
  if (!isNaN(num) && num > 0) {
    if (num === 60) return '1h';
    if (num === 120) return '2h';
    if (num === 240) return '4h';
    return `${num}m`;
  }
  return str;
}

function cleanSymbol(val) {
  if (val == null) return 'SYMBOL';
  if (typeof val === 'object') {
    const cand = val.symbol ?? val.ticker ?? val.name ?? val.value ?? val.pair;
    if (cand && typeof cand !== 'object') return cleanSymbol(cand);
    return 'SYMBOL';
  }
  let s = String(val).trim();
  if (!s || s.toLowerCase().includes('object') || s === 'undefined' || s === 'null' || s === 'UNKNOWN') return 'SYMBOL';
  return s.split('•')[0].trim().toUpperCase();
}

// Suppress Extension Manager red errors for transient/offline WebSocket connection attempts
self.addEventListener('error', (evt) => {
  if (evt?.message?.includes('WebSocket') || String(evt?.error).includes('WebSocket') || String(evt?.filename).includes('background.js')) {
    try { evt.preventDefault(); } catch (_) {}
    return true;
  }
});
self.addEventListener('unhandledrejection', (evt) => {
  if (String(evt?.reason).includes('WebSocket') || String(evt?.reason?.message).includes('WebSocket')) {
    try { evt.preventDefault(); } catch (_) {}
  }
});

// -----------------------------------------------------------------------------
// WebSocket Connection with Silent Pre-Flight HTTP Probing
// Eliminates "WebSocket connection to ... failed" error in Chrome Extension Manager
// -----------------------------------------------------------------------------

async function probePortSilently(port = AUTHORITATIVE_PORT) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 700);
    const res = await fetch(`http://localhost:${port}/api/health`, {
      method: 'GET',
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);
    if (res && res.ok) return true;

    // Fallback probe /api/status
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 700);
    const res2 = await fetch(`http://localhost:${port}/api/status`, {
      method: 'GET',
      signal: controller2.signal
    }).catch(() => null);
    clearTimeout(timeout2);
    if (res2 && res2.ok) return true;

    return false;
  } catch (_) {
    return false;
  }
}

async function getTargetPort() {
  try {
    const custom = await chrome.storage?.local?.get(['tv_service_port']);
    if (custom?.tv_service_port) {
      const p = parseInt(custom.tv_service_port, 10);
      if (p > 0 && await probePortSilently(p)) return p;
    }
  } catch (_) {}

  // Authoritative port 3000
  if (await probePortSilently(AUTHORITATIVE_PORT)) {
    return AUTHORITATIVE_PORT;
  }
  return null;
}

async function connectWebSocket(force = false) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (isConnecting) return;
  isConnecting = true;

  try {
    // 1. Silent pre-flight HTTP probe: verifies server is actively running before opening WS.
    // Eliminates net::ERR_CONNECTION_REFUSED red errors in Chrome Extensions Manager!
    const activePort = await getTargetPort();

    if (!activePort) {
      isConnected = false;
      isConnecting = false;
      if (force) scheduleReconnect();
      return;
    }

    const targetUrl = `ws://localhost:${activePort}`;
    wsUrl = targetUrl;

    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    try {
      ws = new WebSocket(targetUrl);
      ws.onerror = (evt) => {
        isConnected = false;
        isConnecting = false;
        try { evt.preventDefault?.(); evt.stopPropagation?.(); } catch (_) {}
      };
    } catch (_) {
      isConnected = false;
      isConnecting = false;
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      isConnected = true;
      isConnecting = false;
      reconnectAttempts = 0;
      console.log(`[Background] Connected to Local PC Service at ${targetUrl}`);

      // Register extension identity
      ws.send(JSON.stringify({
        type: 'REGISTER_CLIENT',
        role: 'CHROME_EXTENSION',
        version: '2.0.0',
        activeTabs: Array.from(activeTabs.values())
      }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (err) {
        console.warn('[Background] Invalid server message:', err);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      isConnecting = false;
      ws = null;
      scheduleReconnect();
    };
  } catch (err) {
    isConnected = false;
    isConnecting = false;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  // Relaxed backoff: 8s, 14s, 20s capped at 30s — prevents continuous background spamming
  const delay = Math.min(8000 + (reconnectAttempts * 3000), 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function sendToServer(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {}
  }
  return false;
}

// -----------------------------------------------------------------------------
// Server Message Handler
// -----------------------------------------------------------------------------

async function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'ALERT_TRIGGERED') {
    const alert = msg.alert;
    if (!alert) return;

    // 1. Chrome Native Notification
    try {
      const notifId = `tv_alert_${alert.id || Date.now()}`;
      const closePrice = alert.snapshot?.ohlcv?.close ?? alert.snapshot?.close ?? '—';
      const cleanSym = cleanSymbol(alert.symbol);
      const cleanTf = cleanTimeframe(alert.timeframe);
      chrome.notifications.create(notifId, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `🚨 TradingView Alert: ${alert.rule_name}`,
        message: `${cleanSym} [${cleanTf}] — ${alert.rule_name}\nPrice: ${closePrice} (${alert.is_candle_close ? 'Candle Close' : 'Intrabar'})`,
        priority: 2
      }, () => {});
    } catch (e) {
      console.warn('[Background] Notification error:', e);
    }

    // 2. Play Alert Sound
    playAlertAudio('chime');

    // 3. Visual Badge Flash
    try {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: BADGE_ALERT_COLOR });
      setTimeout(() => {
        chrome.action.setBadgeText({ text: BADGE_STREAMING });
        chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      }, 3500);
    } catch (_) {}

    // 4. Dispatch Telegram Notification (direct from browser)
    dispatchTelegram(alert);
  }
}

async function dispatchTelegram(alert) {
  if (!alert) return;
  try {
    const data = await chrome.storage.local.get(['telegram_bot_token', 'telegram_chat_id']);
    const token = data.telegram_bot_token;
    const chatId = data.telegram_chat_id;
    if (!token || !chatId) return;

    const closePrice = alert.snapshot?.ohlcv?.close ?? alert.snapshot?.close ?? '—';
    const isCandleClose = alert.is_candle_close === 1 || alert.is_candle_close === true;
    const typeLabel = isCandleClose ? '🔔 <b>CANDLE CLOSE CONFIRMED</b>' : '⚡ <b>INTRABAR TICK TRIGGER</b>';
    const cleanSym = cleanSymbol(alert.symbol);
    const cleanTf = cleanTimeframe(alert.timeframe);

    const text = `${typeLabel}\n` +
      `<b>Rule:</b> ${alert.rule_name}\n` +
      `<b>Symbol:</b> <code>${cleanSym}</code>  |  <b>TF:</b> <code>${cleanTf}</code>\n` +
      `<b>Price:</b> <code>${closePrice}</code>\n` +
      `<b>Time:</b> ${new Date().toUTCString()}\n\n` +
      `<i>TradingView Multi-Condition Alert Generator</i>`;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.warn('[Background] Telegram dispatch error:', err);
  }
}

// -----------------------------------------------------------------------------
// Message Handling from Content Script & Popup UI
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  const tabId = sender?.tab?.id ?? msg.tabId ?? 'tab_unknown';

  // 1. Live Scraped Payload from Content Script
  if (msg.type === 'TV_STREAM_PAYLOAD') {
    const payload = msg.payload;
    if (payload) {
      payload.tabId = `tab_${tabId}`;
      lastChartTickAt = Date.now();
      lastScrapedSymbol = payload.symbol || lastScrapedSymbol;
      lastScrapedTf = payload.timeframe || lastScrapedTf;

      activeTabs.set(tabId, {
        tabId: payload.tabId,
        symbol: payload.symbol,
        timeframe: payload.timeframe,
        lastActive: Date.now()
      });

      // Send to Local PC Service over persistent WebSocket
      sendToServer({
        type: 'INGEST_PAYLOAD',
        payload
      });

      // Cache snapshot locally
      chrome.storage.local.set({
        tvLastSnapshot: payload,
        tvLastTickAt: Date.now()
      }).catch(() => {});

      // Set active streaming badge
      if (typeof tabId === 'number') {
        chrome.action.setBadgeText({ text: BADGE_STREAMING, tabId }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }).catch(() => {});
      }
    }
    return false;
  }

  // 2. Legacy Stream Tick (Backward Compatibility)
  if (msg.type === 'TV_STREAM_TICK') {
    if (msg.ok && msg.data) {
      lastChartTickAt = Date.now();
      chrome.storage.local.set({
        tvLastSnapshot: msg.data,
        tvLastTickAt: Date.now()
      }).catch(() => {});
      if (typeof tabId === 'number') {
        chrome.action.setBadgeText({ text: BADGE_STREAMING, tabId }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }).catch(() => {});
      }
    }
    return false;
  }

  // 3. Status Query from Popup / Side Panel UI
  if (msg.type === 'GET_EXTENSION_STATUS') {
    const chartAlive = (Date.now() - lastChartTickAt) < 8000;
    sendResponse({
      connectedToService: isConnected,
      serviceUrl: wsUrl,
      activeTabsCount: activeTabs.size,
      activeTabs: Array.from(activeTabs.values()),
      chartAlive,
      chartSymbol: lastScrapedSymbol,
      chartTf: lastScrapedTf,
      lastTickAt: lastChartTickAt
    });
    return true;
  }

  // 4. Test Alert Audio
  if (msg.type === 'TEST_AUDIO') {
    playAlertAudio(msg.sound || 'chime');
    sendResponse({ ok: true });
    return true;
  }

  // 5. Explicit Force Bridge Connect from Popup UI
  if (msg.type === 'CONNECT_BRIDGE_FORCE') {
    connectWebSocket(true);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// -----------------------------------------------------------------------------
// Tab Lifecycle Monitoring (Notifies Backend When Tab Closes)
// -----------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    const info = activeTabs.get(tabId);
    activeTabs.delete(tabId);

    // Notify backend that tab closed -> selective rule pausing takes effect
    sendToServer({
      type: 'TAB_CLOSED',
      tabId: info.tabId,
      symbol: info.symbol,
      timeframe: info.timeframe
    });
  }
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    if (activeTabs.has(tabId)) {
      const info = activeTabs.get(tabId);
      sendToServer({
        type: 'TAB_CLOSED',
        tabId: info.tabId,
        symbol: info.symbol,
        timeframe: info.timeframe
      });
      activeTabs.delete(tabId);
    }
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }
});

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Side Panel Setup (Manifest V3 Persistent UI)
// -----------------------------------------------------------------------------

async function setupSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch (err) {
      console.warn('[Background] sidePanel.setPanelBehavior note:', err);
    }
  }
}

// Fallback action click in environments where openPanelOnActionClick is not supported
chrome.action?.onClicked?.addListener(async (tab) => {
  if (chrome.sidePanel?.open && tab?.windowId) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (_) {}
  }
});

// Service Worker Lifecycle & Initialization
// -----------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Background] Installed:', details.reason);
  setupSidePanel();
  connectWebSocket();
  ensureOffscreenDocument();
});

chrome.runtime.onStartup?.addListener(() => {
  console.log('[Background] Startup.');
  setupSidePanel();
  connectWebSocket();
  ensureOffscreenDocument();
});

// Keep-alive heartbeat
setInterval(() => {
  if (!isConnected) {
    connectWebSocket();
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
  }
}, 25000);

// Initial connection
setupSidePanel();
connectWebSocket();
ensureOffscreenDocument();
