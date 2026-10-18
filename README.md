# ⚡ TradingView Advanced Multi-Condition Alert Generator & Local PC Service

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](manifest.json)
[![Manifest](https://img.shields.io/badge/manifest-v3-green.svg)](manifest.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-112%2F112%20passing-success.svg)](tests/test_all.js)

An enterprise-grade, high-precision algorithmic alert generation system for **TradingView** charts. Combines a **Manifest V3 Chrome Extension** scraper with a **Tier 3 Local PC Service** (Node.js + SQLite) to evaluate complex, recursive boolean condition trees across both real-time intrabar ticks and confirmed candle closes.

Dispatches instant alerts across **Native Chrome Notifications**, **Synthesized Zero-Latency Web Audio Chimes**, **Telegram Bots**, and **Discord Webhooks**.

---

## 🏗️ 3-Tier Production Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: MAIN-WORLD PAGE SCRAPER (injected.js)                               │
│ • Runs inside TradingView chart tab main world (MAIN context)               │
│ • Auto-discovers Symbol, Timeframe, OHLCV, and all built-in + Pine plots    │
│ • Zero manual typing: dynamic series keying (${title}__#${instanceIndex})   │
│ • Candle-close detector (bar rollover/open transition -> is_candle_close)   │
│ • Strict numeric sanitizer (parseCleanNumber: − -> -, ∅/n/a/NaN -> null)    │
│ • Throttled 500ms postMessage emitter ({ source: "TV_ALERT_SCRAPER" })      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ window.postMessage
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ TIER 2: CHROME MV3 EXTENSION BRIDGE (content.js, background.js, offscreen)  │
│ • content.js: relays stream ticks to background service worker              │
│ • background.js: auto-reconnecting WebSocket to ws://localhost:8765         │
│ • Multi-tab lifecycle tracking (sends TAB_CLOSED to server on tab exit)     │
│ • Alert Dispatcher: chrome.notifications + offscreen Web Audio chime        │
│ • popup.html / popup.js: 5-Tab Visual Rule Builder & Live Inspector UI     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ WebSocket ws://localhost:8765 / REST
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ TIER 3: LOCAL PC SERVICE (server.js, db.js, engine.js, telegram.js)         │
│ • server.js: Express REST + Dual WS server on 8765 and 3000                 │
│ • db.js: SQLite persistence (node:sqlite / better-sqlite3), 30-day pruning │
│ • engine.js: Rolling ring buffers per symbol+tf, strict data availability,  │
│   recursive AND/OR tree evaluator, FALSE->TRUE edge & intrabar reset        │
│ • telegram.js: Multi-channel dispatcher (Telegram, Discord, Webhook)        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🌟 Core Architectural Invariants

1. **Zero Manual Typing (Auto-Discovery):** All indicator names, duplicate instances, and individual multi-output sub-plots are dynamically discovered directly from the DOM Legend and Data Window without typing or hardcoded lookups.
2. **Duplicate Collision Avoidance:** Discovered indicators are uniquely keyed using `${indicatorTitle}__#${instanceIndex}`. For example, two RSI indicators on the same chart become `RSI (14)__#1` and `RSI (14)__#2`.
3. **Multi-Output Plot Extraction:** Automatically maps multi-plot indicators (e.g., Bollinger Bands: `Upper`, `Basis`, `Lower`; MACD: `Histogram`, `MACD`, `Signal`; SuperTrend: `Trend`, `Up`, `Down`) with per-plot availability flags.
4. **Strict Data Integrity (Zero Guessing / Zero Stale Values):** Missing indicator plots, `∅`, `n/a`, and `NaN` are strictly treated as `null` with `available: false`. Stale values from prior bars are never substituted.
5. **Selective Rule Pausing:** If Rule A requires an indicator that becomes unavailable or a tab closes without another active stream, **only Rule A transitions to `PAUSED_DATA_UNAVAILABLE`**, displaying the exact missing plot in the UI. All other rules continue unaffected.
6. **Intrabar Reversal State Machine:**
   * Alerts trigger strictly on `FALSE -> TRUE` edge transitions.
   * If an intrabar reversal occurs (`TRUE -> FALSE` before the candle closes), the triggered alert remains permanently logged in SQLite, and the rule's internal state resets to `ACTIVE_FALSE` so it can trigger again on subsequent breakout moves.
7. **Multi-Channel Alert Dispatch:** Dispatches to Chrome native notifications, synthesized Web Audio harmonic chimes, Telegram bots (HTML/Markdown), Discord Webhooks (rich embeds), and custom HTTP webhooks.
8. **Automated 30-Day Retention Pruning:** Periodic snapshots and triggered alert records older than 30 days are automatically pruned hourly to prevent disk bloat.

---

## 🎛️ Operator Reference & Condition Tree Schema

### Supported Operators

| Operator | Type | Description | Formula / Logic |
|---|---|---|---|
| `>` | Relational | Left greater than Right | $A > B$ |
| `<` | Relational | Left less than Right | $A < B$ |
| `>=` | Relational | Left greater than or equal | $A \ge B$ |
| `<=` | Relational | Left less than or equal | $A \le B$ |
| `==` | Relational | Left equal to Right | $|A - B| < 10^{-9}$ |
| `!=` | Relational | Left not equal to Right | $|A - B| \ge 10^{-9}$ |
| `CROSSES_ABOVE` | Crossover | Left crosses above Right | $A_{prev} \le B_{prev} \land A_{curr} > B_{curr}$ |
| `CROSSES_BELOW` | Crossover | Left crosses below Right | $A_{prev} \ge B_{prev} \land A_{curr} < B_{curr}$ |
| `RISING` | Momentum | Left rising over $N$ bars | $A_{curr} > A_{prev}[N]$ |
| `FALLING` | Momentum | Left falling over $N$ bars | $A_{curr} < A_{prev}[N]$ |
| `PCT_CHANGE_GTE`| Relative Change | % change $\ge$ threshold | $\frac{A_{curr} - A_{prev}[N]}{\|A_{prev}[N]\|} \times 100 \ge X$ |
| `PCT_CHANGE_LTE`| Relative Change | % change $\le$ threshold | $\frac{A_{curr} - A_{prev}[N]}{\|A_{prev}[N]\|} \times 100 \le X$ |

### Sample Nested Condition Tree (JSON)

```json
{
  "logicalOperator": "AND",
  "conditions": [
    {
      "id": "c_rsi_oversold",
      "leftSource": { "type": "INDICATOR", "indicatorKey": "RSI (14)__#1", "plotKey": "Plot_1" },
      "operator": "CROSSES_ABOVE",
      "rightSource": { "type": "VALUE", "value": 30 }
    },
    {
      "logicalOperator": "OR",
      "conditions": [
        {
          "id": "c_price_above_basis",
          "leftSource": { "type": "OHLCV", "field": "close" },
          "operator": ">",
          "rightSource": { "type": "INDICATOR", "indicatorKey": "Bollinger Bands__#1", "plotKey": "Basis" }
        },
        {
          "id": "c_volume_surge",
          "leftSource": { "type": "OHLCV", "field": "volume" },
          "operator": "PCT_CHANGE_GTE",
          "lookback": 3,
          "rightSource": { "type": "VALUE", "value": 50 }
        }
      ]
    }
  ]
}
```

---

## 🚀 Quick Start Guide

### 1. Launch the Local PC Service

```bash
# Clone or navigate to the repository
cd tradingview-alert-generator

# Windows (One-Click)
start_service.bat

# Linux / macOS (One-Click)
chmod +x start_service.sh
./start_service.sh

# Or directly with Node.js
npm install
npm start
```
* Service Web Console: `http://localhost:3000` (automatically switches to `http://localhost:3001` if port 3000 is occupied)
* WebSocket Extension Bridge: `ws://localhost:8765`, `ws://localhost:3001`, & `ws://localhost:3000`

### 2. Load the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select this project directory.
4. The **⚡ TV Multi-Condition Alerts** extension icon will appear in your Chrome toolbar.

### 3. Open TradingView & Build Rules

1. Open any chart on [TradingView](https://www.tradingview.com/chart/) (e.g. SENSEX, NIFTY, BTCUSDT, on any timeframe: 1m, 3m, 5m, 1h, 1D).
2. Add your favorite Pine Script or built-in indicators (RSI, Bollinger Bands, MACD, EMA).
3. Click the extension icon:
   * **📡 Inspector Tab:** Watch your indicators and sub-plots auto-discovered in real time!
   * **⚡ Rule Builder Tab:** Symbol and timeframe are auto-detected and persisted across PC restarts. Discovered indicators and plots populate dropdowns with zero typing!
   * **📋 Active Rules Tab:** Monitor live rule statuses (`ACTIVE_FALSE`, `ACTIVE_TRUE`, `PAUSED_DATA_UNAVAILABLE`).
   * **📜 History & Config Tab:** Telegram Bot credentials are secure on the Local PC Service backend in `.env` (click **✈ Test Backend Telegram** to verify).
   * **⬇ CSV Extractor Tab:** Accurate Indian Standard Time (IST) formatting converts TradingView UTC times to IST (e.g., 03:45 UTC &rarr; 09:15:00 IST to 15:12:00 IST).

---

## 🧪 Comprehensive Automated Test Suites

The project includes 4 test suites covering every layer of the architecture:

```bash
# Run all test suites sequentially
npm run test:all
```

Individual test runners:
```bash
node tests/test_phase1.js   # DB, Ring Buffer, Operators & State Machine (10/10)
node tests/test_phase2.js   # Scraper, Sanitizer, Series Keying & Offscreen Audio (41/41)
node tests/test_phase3.js   # Popup UI, Visual Rule Builder & Tree Serialization (40/40)
node tests/test_phase4.js   # Intrabar Reversal Resilience & Multi-Channel Dispatch (21/21)
```

---

## 📡 REST API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | Health, engine state, active rule counts, connected tabs |
| `/api/rules` | GET | Fetch all registered alert rules from SQLite |
| `/api/rules` | POST | Create and activate a new rule (`name`, `symbol`, `timeframe`, `condition_tree`) |
| `/api/rules/:id` | GET | Fetch rule details by ID |
| `/api/rules/:id` | PUT | Update an existing rule |
| `/api/rules/:id` | DELETE | Delete rule and associated history |
| `/api/rules/:id/toggle` | POST | Toggle rule between active (`ACTIVE_FALSE`) and paused (`DISABLED`) |
| `/api/alerts` | GET | Fetch 30-day historical alert logs (`limit`, `offset`, `rule_id`) |
| `/api/tabs` | GET | List currently active TradingView chart tabs streaming data |
| `/api/simulate-tick` | POST | Inject a simulated tick to test rule evaluation and crossovers |
| `/api/settings` | GET/POST | Read/write Telegram Bot and Webhook dispatch credentials |
| `/api/test-telegram` | POST | Test Telegram message delivery |
| `/api/test-discord` | POST | Test Discord webhook rich embed delivery |
| `/api/prune` | POST | Trigger manual cleanup of records older than $N$ days |

---

## 📜 License

MIT License. Designed and built for professional quantitative traders and retail algorithmic enthusiasts.
