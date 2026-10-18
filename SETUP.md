# 🛠️ Setup & Installation Guide

This document provides step-by-step instructions for installing, configuring, and verifying the **TradingView Advanced Multi-Condition Alert Generator & Local PC Service** across Windows, macOS, and Linux.

---

## 📋 System Prerequisites

1. **Google Chrome** (Version 116 or higher for Manifest V3 Offscreen Audio API).
2. **Node.js** (Version 20.0.0 or higher).
   * Check your version:
     ```bash
     node -v
     ```
   * If not installed, download from [nodejs.org](https://nodejs.org).
3. **TradingView Account** (Free, Essential, Plus, or Premium — all subscription tiers are fully supported).

---

## 💻 Step 1: Install & Launch Local PC Service (Tier 3)

The Local PC Service hosts the SQLite persistence engine, condition evaluator, and multi-channel dispatch bridge.

### Option A: Windows (One-Click)

1. Open the project folder in File Explorer.
2. Double-click `start_service.bat`.
3. The script will automatically:
   * Lock into the current directory (`cd /d "%~dp0"`) to resolve paths cleanly.
   * Verify Node.js is present.
   * Initialize `.env` from `.env.example` if not already present.
   * Auto-detect if port 3000 is occupied by another local project and **seamlessly route to port 3001** (or 3050).
   * Ensure service packages are installed (`ws`, `express`, etc.).
   * Keep the command prompt window persistently open (will never blink off or close unexpectedly).
4. Output URLs:
   * **Web Management Console:** `http://localhost:3000` (or `http://localhost:3001` if port 3000 was occupied)
   * **WebSocket Extension Bridge:** `ws://localhost:8765` and `ws://localhost:3001`

### Option B: Linux / macOS (One-Click)

1. Open Terminal in the project directory.
2. Ensure the shell script has executable permissions:
   ```bash
   chmod +x start_service.sh
   ```
3. Run the script:
   ```bash
   ./start_service.sh
   ```

### Option C: Manual Terminal Start (Any OS)

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suites to verify integrity (all 4 suites / 111 assertions)
npm run test:all

# 3. Start the service (with optional custom port if 3000 is occupied)
# Default port 3000:
npm start

# Or specify custom port:
SERVICE_PORT=3001 npm start
```

---

## 🌐 Step 2: Load the Chrome Extension (Tier 1 & Tier 2)

1. Open Google Chrome.
2. In the address bar, navigate to:
   ```text
   chrome://extensions/
   ```
3. Look at the top-right corner and toggle **Developer mode** to **ON**.
4. In the top-left toolbar, click **Load unpacked**.
5. Select the project directory (the folder containing `manifest.json`).
6. You will see:
   * **Name:** `TradingView Advanced Multi-Condition Alert & Data Extractor`
   * **Version:** `2.0.0`
   * **Inspect views:** `service worker`
7. Click the **Puzzle Piece** icon in your Chrome toolbar and pin **TV Alerts** for easy access.

---

## 📱 Step 3: Configure Multi-Channel Dispatch (Telegram & Discord)

### Telegram Bot Setup (Secure Backend Configuration)

> 🔒 **Security Architecture Note:** Following strict cybersecurity practices, Telegram Bot Tokens and Chat IDs are configured **purely on the backend** in your Local PC Service `.env` file. They are never entered or stored in the browser extension frontend, preventing credential leakage.

#### 1. Create your Telegram Bot via @BotFather
1. Open Telegram on your phone or desktop and search for `@BotFather`.
2. Send the command `/newbot`.
3. Follow the prompts:
   * Enter a display name for your bot (e.g., `MyTradingAlertsBot`).
   * Enter a unique username ending in `bot` (e.g., `my_trade_alerts_bot`).
4. BotFather will generate an **HTTP API Token** (e.g., `7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). Copy this token.
5. In Telegram, search for your new bot username, click **Start** or send `/start` to activate the chat.

#### 2. Obtain your Chat ID
* **For Personal Direct Messages:**
  1. In Telegram, search for `@userinfobot` or `@RawDataBot`.
  2. Click **Start**. The bot will immediately reply with your numeric `Id:` (e.g. `987654321`).
* **For a Private Trading Group or Channel:**
  1. Add your bot as a member/administrator to your group or channel.
  2. Add `@RawDataBot` to the group to inspect the group's Chat ID (group IDs start with `-100`, e.g. `-1001987654321`).
  3. Remove `@RawDataBot` once you've copied the ID.

#### 3. Save Credentials in Backend `.env`
1. Open the project root folder on your PC.
2. If `.env` doesn't exist yet, copy `.env.example` to `.env`.
3. Open `.env` in any text editor (Notepad, VS Code, etc.) and enter your values:
   ```env
   # Web Console Port (auto-switches to 3001 if 3000 is occupied)
   PORT=3000
   SERVICE_PORT=3000

   # Telegram Bot Dispatcher (Backend)
   TELEGRAM_BOT_TOKEN=7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   TELEGRAM_CHAT_ID=987654321

   # Optional Discord Webhook
   DISCORD_WEBHOOK_URL=
   ```
4. Save the file and restart the Local PC Service (`start_service.bat` or `node server.js`).

#### 4. Verify Telegram Integration in the Extension UI
1. Click the **TV Alerts** extension icon in Chrome &rarr; go to **📜 History & Config**.
2. Look at the **Telegram Bot Dispatch (Backend Configured)** card:
   * The status badge will show **Active (Ready)** in green.
   * Your Chat ID will appear safely masked (e.g., `***4321`).
3. Click the **✈ Test Backend Telegram** button.
4. A test notification will immediately appear in your Telegram chat!

---

### Discord Webhook Setup (Optional)

1. In your Discord server, right-click the channel where you want alerts to appear (e.g., `#trading-alerts`).
2. Go to **Edit Channel** &rarr; **Integrations** &rarr; **Webhooks**.
3. Click **New Webhook**, give it a name (e.g., `TradingView Alerts`), and click **Copy Webhook URL**.
4. Set `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...` in your `.env` file and restart the service.

---

## ⚡ Step 4: Rule Builder Auto-Detection & Persistence

The Rule Builder features zero-friction setup designed so you never need to reconfigure on PC restarts:

1. **Auto-Detected Symbol & Timeframe**:
   * As soon as a TradingView tab is open, the active symbol (e.g., `SENSEX`) and timeframe (e.g., `5m` or `3m`) are auto-detected and persisted to local storage.
   * When you restart your PC or reopen Chrome, your last active symbol and timeframe are **automatically restored into the Rule Builder fields**.
2. **Indicator Auto-Discovery with Offline Caching**:
   * All indicator keys (e.g., `RSI (14)__#1`, `EMA (20)__#1`) and sub-plots are automatically cached locally.
   * If you open the extension while the Local PC Service is offline or connecting, the Rule Builder shows a clear status notice:
     `⚠️ Bridge is Offline — Showing cached indicators & symbol.`
   * Click **🔄 Reconnect** anytime to re-probe all candidate ports (`8765`, `3001`, `3000`, `3050`).
3. **Zero Manual Typing**:
   * Both Left Source and Right Source dropdowns display all auto-discovered indicators, sub-plots, and primary OHLCV fields.

---

## 🇮🇳 Step 5: Indian Market Timezone & Historical CSV Export

For Indian markets (BSE, NSE, SENSEX, NIFTY, BANKNIFTY, FINNIFTY, MCX) and general IST usage:

1. **Indian Standard Time (IST, UTC+5:30) Accuracy**:
   * Historical candles extracted from TradingView timestamps are automatically converted from UTC to Indian Standard Time (+5:30 offset).
   * **Market Open:** `03:45:00 UTC` is accurately mapped to **`09:15:00 IST`**.
   * **Market Close (3m candle):** `09:42:00 UTC` is accurately mapped to **`15:12:00 IST`**.
   * Normal market close at `10:00:00 UTC` is mapped to **`15:30:00 IST`**.
2. **Timezone Dropdown**:
   * In the **⬇ CSV Extractor** tab, the default timezone is pre-selected as:
     `Indian Standard Time (IST, UTC+5:30: 09:15 to 15:30)`.
   * Global traders can also select `Auto-Detect` or `Coordinated Universal Time (UTC)`.
