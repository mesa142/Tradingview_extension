# 📖 Step-by-Step Practical Walkthrough

This guided walkthrough demonstrates how to build, test, and execute multi-condition alerts using real TradingView scenarios.

---

## 🎯 Scenario 1: RSI Oversold Breakout + Price Above EMA (Indicator-to-Indicator)

**Goal:** Receive an alert when `RSI (14)` crosses above `30` (exiting oversold) **AND** current `Close` price is greater than `EMA (20)`.

```text
CONDITION LOGIC:
[Group: AND]
  ├── RSI (14)__#1 > Plot_1  CROSSES_ABOVE  30 (Value)
  └── Close (Price)          >              EMA (20)__#1 > Plot_1 (Series)
```

### Step 1: Open TradingView & Add Indicators
1. Open Google Chrome and go to [tradingview.com/chart](https://www.tradingview.com/chart/).
2. Select any symbol (e.g. `BTCUSDT` or `SENSEX`) and timeframe (e.g. `5m`).
3. Click **Indicators** at the top of TradingView:
   * Add **Relative Strength Index** (RSI 14).
   * Add **Moving Average Exponential** (EMA 20).

### Step 2: Inspect Discovered Indicators (Zero Typing)
1. Click the **⚡ TV Alerts** extension icon in your Chrome toolbar.
2. Navigate to the **📡 Inspector** tab.
3. Notice that:
   * The **Ticker Bar** shows live values for Symbol, TF, Close, and Volume.
   * Under **Auto-Discovered Indicators & Plots**, you see:
     * `RSI (14)__#1` with plot chip `Plot_1: 28.45` (Badge: **Readable** in green).
     * `EMA (20)__#1` with plot chip `Plot_1: 65120.50` (Badge: **Readable** in green).
4. Click the **Build Rule From This** button. This automatically copies the Symbol (`BTCUSDT`) and Timeframe (`5m`) into the Rule Builder!

### Step 3: Build the Nested Condition Tree
1. You are now in the **⚡ Rule Builder** tab.
2. Set **Rule Name**: `RSI Exit Oversold + EMA Trend`.
3. In the condition row:
   * **Left Source**: Select `RSI (14)__#1 ➜ Plot_1` from the dropdown.
   * **Operator**: Select `CROSSES_ABOVE`.
   * **Right Source**: Ensure `[123]` mode is selected and enter `30`.
4. Click **+ Condition** to add a second requirement to this `AND` group:
   * **Left Source**: Select `Price: Close`.
   * **Operator**: Select `>`.
   * **Right Source**: Click the toggle to switch to `[📈]` (Series comparison mode), then select `EMA (20)__#1 ➜ Plot_1`.
5. Click **💾 Save & Activate Rule**.
6. The popup automatically switches to the **📋 Active Rules** tab. Your rule is now live with status `ACTIVE_FALSE`!

---

## ⚡ Scenario 2: Testing with the Live Tick Simulator

Want to see how your rule reacts without waiting for live market movements? Use the built-in simulator!

1. Open your browser to the Web Management Console at `http://localhost:3000`.
2. Scroll to the **⚡ Live Tick & Intrabar Simulator** panel at the bottom.
3. Enter:
   * **Symbol:** `BTCUSDT`
   * **Timeframe:** `5m`
   * **Close Price:** `65300.0` (greater than the EMA 65120)
   * **RSI (14) Value:** `31.5` (crossed above 30!)
   * **Candle State:** `Intrabar Tick` (or `Candle Close`)
4. Click **🚀 Dispatch Simulated Tick**.
5. Instantly:
   * The engine detects the `FALSE -> TRUE` edge transition!
   * The rule status in the table changes to `ACTIVE_TRUE`.
   * A **Chrome Native Notification** pops up in your OS.
   * A **Web Audio harmonic chime** plays.
   * An alert message is formatted and sent to your configured **Telegram Bot** and **Discord Webhook**!

---

## 🔄 Scenario 3: Observing an Intrabar Reversal

What happens if price spikes, triggers an alert, but then pulls back before the bar closes?

1. In the simulator, set **RSI (14) Value:** `28.0` (fell back below 30).
2. Click **🚀 Dispatch Simulated Tick**.
3. **What the Engine does:**
   * It recognizes the intrabar reversal (`TRUE -> FALSE`).
   * It **permanently preserves** the first triggered alert in SQLite history (visible in the **📜 History** tab).
   * It resets the rule's internal state to `ACTIVE_FALSE`.
4. Now enter **RSI (14) Value:** `33.0` (second breakout!).
5. Click **🚀 Dispatch Simulated Tick**.
6. The rule triggers again on the new `FALSE -> TRUE` edge! Trigger count increments to `2`.

---

## 🛡️ Scenario 4: Selective Auto-Pausing & Resumption

What happens if you navigate to another chart or remove an indicator?

1. Close the TradingView tab or navigate to a chart without `EMA (20)`.
2. Open the **📋 Active Rules** tab.
3. Notice your rule badge changes to:
   * **Badge:** `PAUSED` (Amber)
   * **Notice:** `Missing: Waiting for: EMA (20)__#1 > Plot_1`
4. Notice that rules monitoring other symbols (e.g. `AAPL` or `SENSEX`) remain completely active and unaffected!
5. Navigate back to your chart with `EMA (20)`.
6. As soon as the scraper reads the numeric EMA value, the rule **automatically unpauses** and resumes monitoring!

---

## 📊 Scenario 5: Exporting Historical Range Data to CSV

1. Open the **TV Alerts Extension Popup** &rarr; navigate to the **📊 CSV Export** tab.
2. Select your desired **Timeframe** (e.g. `3m`, `5m`, `15m`, `1h`).
3. Set **Start Date/Time** and **End Date/Time**.
4. Click **⬇ Fetch & Export to Excel (CSV)**.
5. The extension:
   * Automatically sweeps the chart crosshair or queries the internal model.
   * Normalizes timestamps to standard ISO / local time format.
   * Generates and downloads a clean, Excel-compatible CSV file:
     ```text
     tradingview_data_BTCUSDT_5m.csv
     ```
   * Includes columns for `timestamp`, `open`, `high`, `low`, `close`, `volume`, and all active indicator plot columns!

---

## ⚡ Scenario 6: One-Click Bridge Launch, Auto-Fetch & Auto-Resolving

What happens if you open the extension and the local PC backend service is offline, or you want to start it with one click?

1. **One-Click Bridge Connection**:
   * Click **⚡ Connect Bridge / Fetch** in the extension popup header.
   * If the service is running, it instantly connects to the active port (8765, 3000, 3001, etc.) and synchronizes your active chart.
   * If the service is offline, the **⚡ Local PC Bridge Assistant** opens automatically:
     * Click **📋 Copy Service Start Command** to copy `npm run dev` to clipboard.
     * Or click **⬇ Download start_service.bat** for a fresh launcher.
     * Or run in **Standalone In-Browser Engine Mode** (rules evaluate directly in Chrome even without the PC service!).

2. **Self-Healing & Auto-Resolving "Cannot find module 'express'"**:
   * If you run `start_service.bat` or `npm run dev` in a fresh directory, `server.js` and `start_service.bat` detect missing dependencies automatically.
   * They automatically run `npm install` in the background with zero user intervention!
   * The console window never blinks or closes — it provides clear status and stays open.

3. **Auto-Fetching Chart & Manual Alert Name**:
   * Symbol, Timeframe, and all Indicator plots are automatically fetched from your active TradingView tab when you open the popup or switch tabs.
   * The **Alert Name** field (`ruleNameInput`) is kept empty and focused so you can enter your custom alert name manually (e.g. `NIFTY 5m Breakout`).

---

## 🔄 Scenario 7: Cross-Browser Alert Transfer (Export & Import)

Need to transfer all your active alert rules, nested condition trees, and configurations to another browser (e.g. Chrome to Brave or Edge) or another PC?

### Exporting Rules:
1. Click **🔄 Transfer Alerts** (or **📤 Export** in the Active Rules tab).
2. Click **⬇ Download rules.json** to save a timestamped JSON backup file:
   ```json
   {
     "version": "2.0.0",
     "app": "TradingView Multi-Condition Alert Generator",
     "exported_at": "2026-10-17T07:30:00.000Z",
     "count": 5,
     "rules": [ ... ]
   }
   ```
3. Or click **📋 Copy to Clipboard** to copy the entire backup JSON.

### Importing Rules on Another Browser:
1. On your second browser or PC, install the extension.
2. Click **🔄 Transfer Alerts** &rarr; select the **📥 Import** tab.
3. Select your downloaded `rules.json` file or paste the JSON text directly into the box.
4. Click **📥 Import & Activate Rules**.
5. All rules are instantly restored, validated, and activated in SQLite and the Alert Engine!

---

## 🏁 Summary

You now have a complete, enterprise-grade multi-condition alert setup running locally on your machine with zero monthly subscription fees, complete cross-browser portability, and automatic self-healing capabilities.
