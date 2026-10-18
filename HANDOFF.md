# TradingView Advanced Multi-Condition Alert Extension & Local PC Service — Project Handoff

> **Project Evolution Status:** Fully Upgraded & Production Ready  
> **Architecture:** Hybrid 3-Tier Production Architecture (Tier 1: Page Scraper, Tier 2: MV3 Extension Bridge, Tier 3: Local PC Service)  
> **Manifest Version:** `3` · **Extension Version:** `2.0.0`  
> **Master Test Suite:** 112/112 Assertions Passing across 4 Test Suites (`npm run test:all`)

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: MAIN-WORLD PAGE SCRAPER (injected.js)                               │
│ • Runs inside TradingView chart tab main world                              │
│ • Auto-discovers Symbol, Timeframe, OHLCV, and all built-in + Pine plots    │
│ • Zero manual typing: dynamic series keying (${title}__#${instanceIndex})   │
│ • Candle-close detector (bar rollover/open transition -> is_candle_close)   │
│ • Strict numeric sanitizer (parseCleanNumber: − -> -, ∅/n/a/NaN -> null)    │
│ • Throttled 500ms postMessage emitter ({ source: "TV_ALERT_SCRAPER" })      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ window.postMessage
┌──────────────────────────────────────▼──────────────────────────────────────┐
│ TIER 2: CHROME MV3 BRIDGE (content.js, background.js, offscreen.js)         │
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

## 2. Core Architectural Invariants

1. **Zero Manual Typing:** All indicators and plots are automatically scraped and discovered from live TradingView tabs. Unique key format `${indicatorTitle}__#${instanceIndex}` prevents collisions when duplicate indicators exist on the chart.
2. **Strict Data Integrity (Zero Guessing / Zero Stale Substitution):** Missing plots, `∅`, `n/a`, and `NaN` are strictly treated as `null` with `available: false`. Stale values are never substituted.
3. **Selective Rule Pausing:** If Rule A uses RSI and Rule B uses SMA, and RSI becomes unavailable or a tab closes, only Rule A pauses (`PAUSED_DATA_UNAVAILABLE`), displaying a clear notice naming the exact missing indicator. Rule B continues uninterrupted.
4. **Trigger & Intrabar Reversal State Machine:**
   * Alerts trigger strictly on `FALSE -> TRUE` transitions.
   * If an intrabar reversal occurs (`TRUE -> FALSE` before candle close), the triggered alert remains permanently logged in 30-day SQLite history, and the rule's internal state resets to `ACTIVE_FALSE` so it can trigger again on subsequent breakout moves.
5. **Multi-Channel Dispatch:** Dispatches to Chrome native notifications, synthesized zero-latency offscreen audio chimes, Telegram bots (HTML/Markdown), Discord Webhooks (rich embeds), and generic webhook endpoints.

---

## 3. File Map & Responsibilities

| File | Tier | Purpose |
|---|---|---|
| `manifest.json` | 2 | Manifest V3 configuration with notifications, storage, tabs, scripting, offscreen |
| `injected.js` | 1 | Main-world DOM scraper, candle-close detector, numeric sanitizer, and 500ms throttled emitter |
| `content.js` | 2 | Content script isolated world, injects injected.js, relays `TV_STREAM_PAYLOAD` to background |
| `background.js` | 2 | Service worker managing persistent WebSocket connection, multi-tab tracking, and alert dispatching |
| `offscreen.html` | 2 | MV3 Offscreen document hosting Web Audio API synthesizer |
| `offscreen.js` | 2 | AudioContext oscillator generating clean harmonic chimes without external audio assets |
| `popup.html` | 2 | 5-Tab Extension UI (Inspector, Rule Builder, Active Rules, History & Config, CSV Extractor) |
| `popup.css` | 2 | TradingView dark theme with hierarchical condition group styling and status badges |
| `popup.js` | 2 | Visual nested condition builder, live ticker, series inspector, rule CRUD, and config forms |
| `server.js` | 3 | Node.js Express REST + WebSocket server on port 8765 & 3000 |
| `db.js` | 3 | SQLite persistence (`node:sqlite` / `better-sqlite3`) with schema migrations & 30-day pruning |
| `engine.js` | 3 | AlertEngine with rolling ring buffer, condition tree evaluator, edge detector, and state machine |
| `telegram.js` | 3 | Multi-channel dispatcher supporting Telegram Bot, Discord Webhook, and Custom Webhooks |
| `start_service.bat` | 3 | Windows one-click runner script with dependency checking |
| `start_service.sh` | 3 | Linux/macOS one-click runner script with environment verification |
| `tests/test_all.js` | Dev | Master test runner executing all Phase 1-5 test suites |

---

## 4. Supported Operators & JSON Condition Tree Schema

### Supported Operators
* **Relational / Indicator-to-Indicator:** `>`, `<`, `>=`, `<=`, `==`, `!=`
* **Crossovers:** `CROSSES_ABOVE`, `CROSSES_BELOW`
* **Momentum:** `RISING`, `FALLING` over lookback $N$ bars
* **Relative Change:** `PCT_CHANGE_GTE`, `PCT_CHANGE_LTE` ($((C - C_{prev}) / |C_{prev}|) \times 100 \ge X$)

### Sample Arbitrary Tree
```json
{
  "logicalOperator": "AND",
  "conditions": [
    {
      "id": "c1",
      "leftSource": { "type": "INDICATOR", "indicatorKey": "RSI (14)__#1", "plotKey": "Plot_1" },
      "operator": "CROSSES_ABOVE",
      "rightSource": { "type": "VALUE", "value": 30 }
    },
    {
      "logicalOperator": "OR",
      "conditions": [
        {
          "id": "c2",
          "leftSource": { "type": "OHLCV", "field": "close" },
          "operator": ">",
          "rightSource": { "type": "INDICATOR", "indicatorKey": "Bollinger Bands__#1", "plotKey": "Basis" }
        },
        {
          "id": "c3",
          "leftSource": { "type": "OHLCV", "field": "close" },
          "operator": "PCT_CHANGE_GTE",
          "lookback": 3,
          "rightSource": { "type": "VALUE", "value": 0.75 }
        }
      ]
    }
  ]
}
```

---

## 5. Verification Commands

* Run Master Test Suite (all phases):
  ```bash
  npm run test:all
  ```
* Run Individual Phase Suites:
  ```bash
  node tests/test_phase1.js   # DB & Engine
  node tests/test_phase2.js   # Scraper & Background Bridge
  node tests/test_phase3.js   # Popup UI & Visual Rule Builder
  node tests/test_phase4.js   # Intrabar Reversal Resilience & Multi-Channel
  ```
* Start Local PC Service manually:
  ```bash
  npm start   # or ./start_service.sh or start_service.bat
  ```
