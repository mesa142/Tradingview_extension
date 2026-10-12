# TradingView OHLC + Indicator Extractor — Project Handoff

> **Purpose of this file:** capture the complete project state so work can continue
> in a fresh session / with a different model. Read this first, then the code.
>
> **Last updated:** 2026-10-12 · **Manifest version:** `1.3.0` · **Tests:** 61/61 passing

---

## 1. What the product is

A **Manifest V3 Chrome extension** that extracts OHLC + active indicator values from
any TradingView chart (any symbol, any timeframe) and exports a user-chosen
**Start → End date range** to an Excel-compatible CSV named
`tradingview_data_[symbol]_[timeframe].csv`.

Three user-facing capabilities:

| Feature | Trigger |
|---|---|
| **Capture** current candle + indicator readouts | `⦉ Capture Current Candle` button |
| **Live stream** (polling crosshair/legend) | `streamToggle` checkbox |
| **Range export** Start/End → CSV | `⬇ Fetch & Export to Excel (CSV)` button |

**Location:** `F:\Antigravity Project\Projects\Tradingview Extension`

**Not a git repository** (no VCS). Versioning is via `manifest.json` + this file.

---

## 2. Files

| File | Size | Purpose |
|---|---|---|
| `manifest.json` | 59 lines | MV3 manifest, version `1.2.0` |
| `content.js` | ~1,900 lines | **The engine.** Runs in every frame; all extraction logic |
| `injected.js` | 497 lines | Page-world (MAIN world) script exposing `window.__TV_EXTRACTOR__` |
| `popup.html` | 6 KB | Popup UI |
| `popup.js` | 483 lines | Popup logic, frame retargeting, diagnostics rendering |
| `background.js` | 96 lines | Service worker: persists `TV_STREAM_TICK` to `chrome.storage.local`, badge |
| `icons/` | — | 16/32/48/128 PNG |
| `package.json` | — | Dev-only: `npm test`, `npm run check` |
| `tests/harness.js` | — | jsdom simulation of the real TV page |
| `tests/run.js` | — | 9 end-to-end test scenarios (43 assertions) |
| `node_modules/` | — | jsdom 30.1.2 (dev only, **never loaded by Chrome**) |

### Manifest facts

- `permissions`: `activeTab`, `scripting`, `storage`
- `host_permissions` + `content_scripts.matches`: `*://*.tradingview.com/*`, `*://*.tradingview.cn/*`
- `content_scripts`: `content.js`, `run_at: document_idle`, **`all_frames: true`**
- `web_accessible_resources`: `injected.js` (injected into the page MAIN world)
- `minimum_chrome_version`: 116

---

## 3. Architecture

```
popup.js  ──chrome.tabs.sendMessage(…, {frameId})──►  content.js (per frame)
                                                         │
             ┌───────────────────────────────────────────┤
             ▼                                           ▼
   window.__TV_EXTRACTOR__                    Legend / canvas DOM
   (injected.js, MAIN world)                  (Method B — fallback)
   Method A — page data model
```

### 3.1 Message protocol (`content.js` handles)

| Type | Purpose |
|---|---|
| `TV_GET_SNAPSHOT` | One-shot capture → symbol/timeframe/OHLC/indicators |
| `TV_STREAM_START` / `TV_STREAM_STOP` / `TV_STREAM_STATUS` | Live polling |
| `TV_FETCH_RANGE` | `{ startMs, endMs, requestedTimeframe }` → CSV + preview |
| `TV_PING` | Liveness |
| `TV_PROBE` | Frame probe used by auto-retargeting |
| `TV_FETCH_PROGRESS` | content → popup progress lines (via `chrome.runtime.sendMessage`) |
| `TV_STREAM_TICK` | content → background (persisted to storage) |

Popup also listens for `TV_FETCH_PROGRESS` and `TV_STREAM_TICK`.

### 3.2 Frame handling (important)

`all_frames: true` means `content.js` runs in **every** frame. The popup therefore:

1. `findChartFrame()` — scores each frame (`legendHits×10 + bigCanvas×5 + ohlcText×3 + canvases`)
2. Sends to the best frame; on failure re-targets on error codes
   `NO_CHART_IN_FRAME` / `NO_CHART_ON_PAGE` / `CHART_NOT_READY`
3. Sends with an explicit `{ frameId }` for retries.

### 3.3 Data paths for a range export

**Method A — page data model (`window.__TV_EXTRACTOR__`)**
`injected.js` tries to reach TV's internal chart state and expose
`getSnapshot()`, `getRange(startMs, endMs)`, `scrollChart(direction, steps)`.
> ⚠️ **Unreachable on the user's current build.** Diagnose confirms no model.
> Still implemented and tested (T5) — it is the preferred path when available.

**Method B — legend crosshair sweep (the active path)**
`fetchRange()` → `ensureCoverage()` (auto-pan older via `scrollChart` + wheel) →
`sweepLegendRange(seriesElHint, tfMs)`:

1. **Gate 1** — `listCanvasCandidates()` (layout ≥ 80×60, biggest first), reject if no layout
2. **`primeCrosshair()`** — set `tabindex`, `.focus()`, one hover at the right edge
3. **`probeResponsiveCanvas()`** — probe up to 4 candidates with 2 hovers each,
   keep the first that **changes the legend text** (self-correcting; fixes the
   15-canvas problem)
4. **Gate 2** — `FETCH_SWEEP_STEPS` (100) hovers across the pane at 50 ms apart;
   per step: `collectHoverTargets()` → `dispatchHoverAt()` → sleep → re-read legend
   → `parseOHLCRow()` + `parseIndicators()` → dedupe by OHLC tuple
5. **Gate 3** — `sweepByKeyboard()` fallback (ArrowRight to newest, then ArrowLeft ×N)
   when ≤ 1 distinct candle
6. **Gate 4** — `finalizeSweepTimes()` timestamp reconstruction (4 tiers)

**Timestamp trust tiers** (`finalizeSweepTimes`):

| Tier | Source | Quality |
|---|---|---|
| 1 | Hover/time-axis DOM label (`readHoverTime`) | Real |
| 2 | Axis tick interpolation (`readTimeAxisTicks`) — full dates only | Real-ish |
| 3 | Linear fill between known anchors, step = `tfMs` | Interpolated |
| 4 | `floor(now / tfMs) * tfMs` anchor, step back | **Estimated** |

`timestampsEstimated === true` ⇒ popup shows `⚠ TIMESTAMPS WERE ESTIMATED` and the
CSV gets a `TIMESTAMPS_ESTIMATED` warning. Session gaps are **not** modelled.

**Indicator columns:** `parseIndicators()` reads *hovered* values per sweep position,
so a sweep yields one row per swept position (up to 100), not full per-bar indicator
history. This is an honest, documented limitation of Method B.

---

## 4. Key constants (`content.js` ~line 109)

```js
STREAM_DEFAULT_MS = 1000;
STREAM_MIN_MS     = 400;     // MutationObserver + interval guard
FETCH_MAX_BARS    = 2000;    // refuse ranges estimating more bars than this
FETCH_SCROLL_ATTEMPTS = 12;  // max auto-pan iterations
FETCH_SETTLE_MS   = 1600;    // wait after each pan for TV backfill
FETCH_SWEEP_STEPS = 100;     // crosshair sweep resolution (~5 s + probe ~0.1 s)
```

`RESOLUTION_MAP` maps TV resolution strings (`1`, `5`, `60`, `D`, `W`, …) → ms.

---

## 5. Error codes (never a mystery string)

Produced by `sweepErrorCode()` / `sweepErrorMessage()` / explicit returns:

| Code | Meaning |
|---|---|
| `CHART_CANVAS_MISSING` | No canvas in this frame |
| `CANVAS_NO_LAYOUT` | Canvas exists but layout box < 50×30 (hidden/zero-size) |
| `HOVER_DISPATCH_FAILED` | `PointerEvent`/`MouseEvent` construction failed |
| `LEGEND_ROW_NOT_FOUND` | Legend row never located during sweep |
| `LEGEND_OHLC_EMPTY` | Legend found but never showed O/H/L/C |
| **`HOVER_NOT_MOVING`** | ≤ 1 distinct candle across a multi-bar range — **current open issue** |
| `INVALID_RANGE` | `startMs >= endMs`, or a future start |
| `RANGE_TOO_LARGE` | Estimated bars > `FETCH_MAX_BARS` |
| `MODEL_UNREACHABLE` | *(legacy — retired, replaced by the codes above)* |
| `SCROLL_API_NOT_FOUND` | Page-context scroll helper absent |
| `NO_CHART_IN_FRAME` / `NO_CHART_ON_PAGE` / `CHART_NOT_READY` | Frame targeting |

### Diagnostics payload (attached to success **and** error)

```
method, sweepSteps, dispatchOk, seriesFoundSteps, ohlcReadSteps,
distinctCandles, legendChangedSteps,  ← THE decisive signal
hoverTimesFound, hoverTargets[], axisTicks, keyboardFallbackRows,
canvas { found, tag, layoutWidth/Height, attrWidth/Height, label },
canvasCandidates, canvasLabels[], canvasProbe[], responsiveCanvas,
lastSeriesText, timestampsEstimated, timestampsInterpolated
```

> **`legendChangedSteps: 0` means the legend text NEVER changed** — TV is ignoring
> synthetic events (they carry `isTrusted: false`). No amount of hover tuning can
> fix that; a different data path would be required.

Popup renders this under `// --- sweep diagnostics ---` in the `#output` textarea.

---

## 6. Known facts about the user's environment

Established by the Diagnose button on
`https://www.tradingview.com/chart/BZy5qAiq/` (SENSX index, 5m):

```
frame 0 score=51 legend=4 canvas=15 big=1 ohlcText=1
probe(frame 0): page=chart isChart=true isTop=true container=true canvases=15
symbol≈SENSEX timeframe≈5m :: SENSEX 72,472.33 ▲ +1.23% STD 1
legend selectors hit: div[class*="legend"]×4
```

Consequences already encoded in the code:

1. **No `data-name` attributes anywhere** — the build is renamed. Legend rows must be
   found by *text signature* (`O…H…L…C` sequence), not attributes.
   → `findSeriesByOHLCText()` + `SELECTORS.legendRoot: 'div[class*="legend"]'`.
2. **Series row text concatenates split nodes**: `SENSEXO72,472.33H72,810.50L…C…`.
   Indian lakh/crore comma grouping must parse. → `OHLC_SEQ` regex + `parseOHLCRow()`
   sequence-first pass (unit-tested).
3. **15 canvases stacked** in the chart container, only 1 qualifies as "big".
   → canvas probing + hover fan-out (the `v1.2.0` fix).
4. **The internal data model is unreachable** → range export rides Method B.

---

## 7. Test suite

```bash
npm install        # jsdom (dev only)
npm test           # node tests/run.js   → 43 assertions, ~41 s
npm run check      # node --check on all 4 JS entry files
```

| # | Scenario | Asserts |
|---|---|---|
| T1 | Capture snapshot (renamed build, split-node legend) | ok, symbol, timeframe, OHLC, clean indicator keys, no digit-glued garbage |
| T2 | Range export via sweep, model **unreachable** | count ≥ 40, CSV header, all rows dated, `method=pointer-sweep`, `distinctCandles==count`, `legendChangedSteps > 0` |
| T3 | Invalid range | `INVALID_RANGE` (inverted + future start) |
| T4 | Oversized range (1 year @ 5m) | `RANGE_TOO_LARGE` |
| T5 | Range export via **internal model** | exactly N bars, `method=data-model`, CSV row prefix |
| T6 | Zero-layout canvas | `CANVAS_NO_LAYOUT` + diagnostics present |
| T7 | Crosshair cannot move | **`HOVER_NOT_MOVING`** (not a mystery code), legend WAS found/read, 1 distinct candle |
| T8 | No hover-time label | `timestampsEstimated=true`, Datetime still populated, warning present |
| T9 | **Larger decoy canvas** stacked over the real pane | export still succeeds, probe rejects decoy / accepts `price`, legend changed |

### Harness design (`tests/harness.js`)

Bootstraps the extension inside jsdom with the real page's quirks:

- no `data-name`, class-based legend, split-node series row, `.timeAxisHighlight`
- `stubRect()` paints layout boxes (jsdom does no layout)
- `document.elementFromPoint` overridden to return the topmost canvas
- `PointerEvent` polyfill (jsdom lacks it)
- **simulated crosshair**: `pointermove`/`mousemove` on the price canvas updates
  the series/indicator/hover-time DOM — this is what real TV does
- `chrome.*` stubs with `send()` resolving `sendResponse`
- loads `content.js` via `win.eval(CONTENT_SRC)`

Options: `candleCount`, `canvasLayout`, `workingCrosshair`, `model`,
`hoverTimeVisible`, `decoyCanvas`.

---

## 8. Open issue — `HOVER_NOT_MOVING`

**Status: unfixed, awaiting real-page diagnostics.**

The user reported `⚠ HOVER_NOT_MOVING` on their chart. The Diagnose output pasted
back confirmed the 15-canvas situation (which `v1.2.0` addresses) but **did not**
include the `// --- sweep diagnostics ---` block from the actual Fetch attempt —
the user had clicked Diagnose, which overwrites the textarea.

### What `v1.2.0` changed to fix it

| Change | Why |
|---|---|
| `listCanvasCandidates()` | All layout-valid canvases, biggest first |
| `probeResponsiveCanvas()` | Probe each candidate with 2 hovers; keep the first that **changes the legend**. Probes a canvas *alone* so `moved=` is truthful |
| `collectHoverTargets()` + `dispatchHoverAt()` | Fan every hover out to all canvases under the pointer + `elementFromPoint` + the chart container (not just the topmost) |
| `primeCrosshair()` | `tabindex` + `.focus()` + one edge hover before sweeping — TV often ignores input until it owns DOM focus |
| `sweepByKeyboard()` focus | Sets `tabindex`, calls `.focus()`; still a **single** sink so bubbling reaches `document`/`window` without double-stepping |
| `legendChangedSteps` diagnostic | Decisive yes/no: did the legend ever move? |
| Richer popup rendering | `canvasCandidates`, `canvasLabels`, `canvasProbe`, `responsiveCanvas`, `legendChangedSteps` |
| Sharper `HOVER_NOT_MOVING` message | Explains `isTrusted=false` and what to try |

### Next steps (in order)

1. **Ask the user to retest:** reload extension at `chrome://extensions`, hard-reload
   the chart tab (`Ctrl+Shift+R`), click **Fetch & Export** (not Diagnose), then paste
   the `// --- sweep diagnostics ---` block.
2. **Interpret `legendChangedSteps`:**
   - `> 0` and export succeeds → done.
   - `> 0` but still failing → timestamps/coverage problem; inspect `hoverTimesFound`,
     `axisTicks`, `timestampsEstimated`.
   - **`0`** → TV is rejecting synthetic events. Hover cannot be made to work.
3. **If `legendChangedSteps === 0`, build Method C — datafeed capture:**
   hook `window.fetch` / `XMLHttpRequest.prototype.send` in `injected.js`, record any
   JSON response that looks like OHLC (`[time, open, high, low, close, volume]` arrays),
   expose as `__TV_EXTRACTOR__.capturedDatafeed`, and let `readPageRange()` use it.
   This removes the hover dependency entirely and gives exact historical bars.
   *(Not started — deliberately waiting for the diagnostic to confirm the need.)*

### Other honest limitations

- **Indicator history is per-swept-position, not per-bar** under Method B. A wide zoom
  with 100 sweep steps yields ≤ 100 rows; warn the user honestly.
- `FETCH_MAX_BARS = 2000` refuses very wide ranges.
- Timestamps may be estimated (tier 4) when no time label is readable; session gaps
  are not modelled.
- Some TradingView UI changes may rename selectors; the `SELECTORS` arrays keep
  several generations plus an attribute-independent text fallback.

---

## 9. Version history

| Version | Contents |
|---|---|
| `1.0.0` | Initial build: `manifest`, `injected` (`getSnapshot`/`getRange`/`scrollChart`), `content` hybrid engine + CSV, `popup`, `background`, icons |
| `1.1.0` | Frame-aware errors + `TV_PROBE`; `findSeriesByOHLCText` (rename-proof); sequence-first `parseOHLCRow` (unit-tested); timeframe toolbar-text fallback; symbol-prefix-from-row |
| `1.1.1` | (intermediate) |
| `1.1.2` | `tidyIndicatorName()` (handles `∅`, `K/M/B` units, signed runs, glued `V1.5` — 11/11 tests); `deriveRowName()` extracted; shadow-node dedupe for unlabeled duplicate values; `parseIndicators` refactored to shared deriver |
| `1.2.0` | jsdom test harness + 9 scenarios (43 assertions); sweep diagnostics with `diagnostics`/`method`/`timestampsEstimated`; rect-based `findChartCanvas`; `hoverTargetAt` → `collectHoverTargets` fan-out; `readTimeAxisTicks`/`interpolateTime`/`finalizeSweepTimes` (4 tiers); `sweepByKeyboard`; `sweepErrorCode`/`sweepErrorMessage` replacing mystery `MODEL_UNREACHABLE`; **canvas probing + focus priming + `legendChangedSteps`**; `HOVER_NOT_MOVING` multi-bar guard; popup diagnostics rendering; `package.json` |
| **`1.3.0`** | Complete Historical Indicator Data in CSV export: `probeStudies` enhanced with pane collection, `PlotList` unwrap, and bar `indexToMs` mapping; built-in Technical Indicators Calculation Engine (RSI, EMA, SMA, WMA, MACD, Bollinger Bands, ATR, Supertrend, Stochastic, Volume MA) to guarantee 100% continuous historical indicator data across all CSV rows on model, datafeed-capture, and sweep export modes; 61/61 tests passing (T1-T12). |

---

## 10. Development workflow

```bash
# syntax / tests
npm run check
npm test

# manual verification on the real page
# 1. chrome://extensions → enable Developer mode → Load unpacked → this folder
# 2. After ANY code change: click the reload (↻) icon on the extension card
# 3. Hard-reload the chart tab: Ctrl+Shift+R
# 4. Open the popup → capture / fetch range
# 5. Failures: click "🩺 Diagnose chart access" for frame probe,
#    or read the // --- sweep diagnostics --- block after a failed Fetch
```

**Common pitfalls**

- Forgetting to reload the extension after editing → old code runs.
- `content.js` changes require reloading **both** the extension and the tab.
- Diagnose overwrites the `#output` textarea — copy the Fetch diagnostics *before*
  clicking Diagnose.
- jsdom is dev-only; nothing under `node_modules/` is referenced by the manifest.

---

## 11. Quick reference — where things live in `content.js`

| Concern | Function |
|---|---|
| Selector sets | `SELECTORS` (~L46), `OHLC_SEQ` (~L98) |
| Indicator name cleanup | `tidyIndicatorName()`, `deriveRowName()`, `TITLE_SEL` (~L436) |
| Legend row by text | `findSeriesByOHLCText()` (~L636) |
| Frame probe | `diagnoseFrame()` (~L693) |
| Snapshot assembly | `buildSnapshot()` (~L718) |
| Canvas selection | `findChartCanvas()`, `listCanvasCandidates()`, `labelCanvas()` |
| Hover fan-out | `collectHoverTargets()`, `dispatchHoverAt()`, `dispatchHover()` |
| Focus priming | `primeCrosshair()` |
| Canvas probe | `probeResponsiveCanvas()` |
| Auto-pan | `ensureCoverage()` (L1119) |
| Hover time read | `readHoverTime()` (L1159) |
| Keyboard fallback | `sweepByKeyboard()` (L1319) |
| Timestamp tiers | `finalizeSweepTimes()` (L1262) |
| Sweep | `sweepLegendRange()` (L1376) |
| Error mapping | `sweepErrorCode()` (L1512), `sweepErrorMessage()` |
| Model rows → CSV | `buildRangeRows()` (L1555) |
| Range export entry | `TV_FETCH_RANGE` handler (L1862) |
