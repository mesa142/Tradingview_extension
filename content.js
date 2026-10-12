/**
 * content.js — the extraction engine (isolated world).
 *
 * Strategy (hybrid, per spec):
 *   Method A: ask injected.js (page context) for the internal data model via
 *             window.__TV_EXTRACTOR__.getSnapshot(). Best for timestamps/history.
 *   Method B (authoritative fallback, always active): scrape the floating
 *             legend / data-status-line DOM overlay. TradingView keeps this in
 *             the DOM even though candles render on <canvas>, and it updates in
 *             real time as new candles print or the crosshair moves.
 *
 * Universal timeframe support: nothing is hardcoded to 1m/5m/1h. We re-read
 * symbol + resolution + OHLC on every capture / mutation, so switching the
 * timeframe just changes what the legend shows and we pick it up instantly.
 *
 * Messaging (to popup.js / background.js):
 *   { type: 'TV_GET_SNAPSHOT' }            -> responds { ok, data } | { ok:false, error }
 *   { type: 'TV_STREAM_START', intervalMs } -> begins push updates
 *   { type: 'TV_STREAM_STOP' }              -> ends push updates
 *   { type: 'TV_FETCH_RANGE', startMs, endMs } -> async range export; responds
 *      { ok:true, data:{ symbol, timeframe, count, filename, csv, preview, warnings } }
 *      | { ok:false, error, message, data? }
 *   { type: 'TV_PROBE' } -> { ok:true, probe } self-diagnosis (never fails)
 *   Errors: CHART_NOT_READY (loading) | NO_CHART_IN_FRAME (wrong frame,
 *      popup retargets by frameId) | NO_CHART_ON_PAGE (overview/screener —
 *      open tradingview.com/chart/) | OHLC_NOT_READY | INVALID_RANGE | ...
 *   Progress during range fetch: chrome.runtime.sendMessage({ type:'TV_FETCH_PROGRESS', ... })
 *   Push: chrome.runtime.sendMessage({ type: 'TV_STREAM_TICK', data })
 *   State persistence: last snapshot cached in chrome.storage.local.
 */

(() => {
  'use strict';

  // Avoid double-bootstrapping on SPA navigation / all_frames re-injection.
  if (window.__TV_CONTENT_BOOTED__) return;
  window.__TV_CONTENT_BOOTED__ = true;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Legend DOM selectors, ordered by reliability across TV builds/locales.
   *  TV renames these attributes periodically — keep several generations here,
   *  and rely on findSeriesByOHLCText() as the attribute-independent fallback. */
  const SELECTORS = {
    legendRoot: [
      '[data-name="legend"]',
      'div[class*="legend"]',
      '[data-name="chart-legend"]',
      '[class*="paneLegend"]',
      '[class*="chart-legend"]',
      '.pane-legend',
      '#chart-legend',
    ],
    // The main symbol series row (contains symbol name + O/H/L/C).
    seriesItem: [
      '[data-name="legend-series-item"]',
      '[data-name="legend-source-item"]', // some builds reuse this for series
      '[data-name="legend-symbol-item"]',
      'div[data-name="legend-series-title"]',
      '.chart-title',
      '[class*="chartTitle"]',
      '[data-name="legend"] > div',
    ],
    // Indicator rows (each active indicator gets one of these).
    indicatorItem: [
      '[data-name="legend-source-item"]',
      '[data-name="legend-indicator-item"]',
      '[data-name="legend-study-item"]',
      'div[class*="sourcesWrapper"] > div',
      '[class*="indRow"]',
      '.indRow',
    ],
    // OHLC value nodes inside a legend row.
    ohlcValue: [
      '[data-name="legend-series-item-value"]',
      '[data-name="legend-source-value"]',
      '[data-name*="value"]',
      '[class*="valueItem"]',
      '[class*="valueTitle"]',
      'span[class*="value"]',
      'div[class*="value"]',
    ],
    // Timeframe picker: the pressed/active resolution button.
    timeframeActive: [
      '[data-name="timeframes-menu"] [aria-pressed="true"]',
      '#header-toolbar-intervals [aria-pressed="true"]',
      '[data-name="header-toolbar-intervals"] [aria-pressed="true"]',
      'div[data-value][class*="isActive"]',
      'button[data-value][aria-pressed="true"]',
      'button[data-interval][aria-pressed="true"]',
      '[data-role="timeframe"] [aria-checked="true"]',
    ],
  };

  /** O…H…L…C run in order, tolerant of zero whitespace: textContent of
   *  split-node markup concatenates ("SENSEXO72,472.33H72,810.50L…C…"), so
   *  separators between the letter and its number are optional. */
  const OHLC_SEQ = /O\s*[−\-+]?[0-9][0-9,.]*\s*H\s*[−\-+]?[0-9][0-9,.]*\s*L\s*[−\-+]?[0-9][0-9,.]*\s*C\s*[−\-+]?[0-9][0-9,.]*/i;

  /** TV internal resolution codes -> human timeframe labels. */
  const RESOLUTION_MAP = {
    '1S': '1s', '5S': '5s', '15S': '15s', '30S': '30s',
    '1': '1m', '2': '2m', '3': '3m', '5': '5m', '15': '15m',
    '30': '30m', '45': '45m', '60': '1h', '120': '2h', '180': '3h',
    '240': '4h', '360': '6h', '480': '8h', '720': '12h',
    'D': '1D', '1D': '1D', 'W': '1W', '1W': '1W', 'M': '1M', '1M': '1M',
  };

  const STREAM_DEFAULT_MS = 1000;
  const STREAM_MIN_MS = 400; // guard: MutationObserver + interval, don't melt CPU

  // ---- Historical range-fetch tuning -------------------------------------
  const FETCH_MAX_BARS = 2000;      // safety cap: refuse ranges estimating more
  const FETCH_SCROLL_ATTEMPTS = 12; // max auto-pan iterations waiting for backfill
  const FETCH_SETTLE_MS = 1600;     // wait after each pan for TV to load history
  const FETCH_SWEEP_STEPS = 500;    // crosshair-sweep pointer steps (dense sampling)

  let injectedReady = false;
  let streaming = false;
  let streamTimer = null;
  let legendObserver = null;
  let lastPushedJson = '';

  // ---------------------------------------------------------------------------
  // Page-context bridge (Method A)
  // ---------------------------------------------------------------------------

  /** Inject injected.js into the page's main world (MV3-safe via script tag). */
  function ensureInjected() {
    if (injectedReady) return;
    try {
      // If a previous navigation already installed it, reuse it.
      if (window.__TV_EXTRACTOR__?.__ready) {
        injectedReady = true;
        return;
      }
      const src = chrome.runtime.getURL('injected.js');
      const el = document.createElement('script');
      el.src = src;
      el.async = false;
      el.onload = () => { injectedReady = true; el.remove(); };
      el.onerror = () => { injectedReady = false; el.remove(); };
      (document.head || document.documentElement).appendChild(el);
      // Fallback: mark ready optimistically; snapshot fn tolerates absence.
      setTimeout(() => { if (window.__TV_EXTRACTOR__?.__ready) injectedReady = true; }, 1500);
    } catch {
      injectedReady = false; // Method B still works without it
    }
  }

  /** Synchronous DOM-based RPC bridge across Chrome isolated / main worlds. */
  function callPageSync(method, args = []) {
    try {
      if (typeof document === 'undefined' || !document.documentElement) return null;
      let bridge = document.getElementById('__tv_ext_bridge__');
      if (!bridge) {
        bridge = document.createElement('div');
        bridge.id = '__tv_ext_bridge__';
        bridge.style.display = 'none';
        document.documentElement.appendChild(bridge);
      }
      bridge.setAttribute('data-req', JSON.stringify({ method, args }));
      bridge.removeAttribute('data-res');
      document.dispatchEvent(new CustomEvent('__TV_EXT_CALL__'));
      const raw = bridge.getAttribute('data-res');
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
  }

  /** Read-only call into page context. Never throws — returns null on failure. */
  function readPageModel() {
    try {
      const api = window.__TV_EXTRACTOR__;
      if (api && typeof api.getSnapshot === 'function') {
        const snap = api.getSnapshot();
        if (snap && typeof snap === 'object') return snap;
      }
      return callPageSync('getSnapshot');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (Method B)
  // ---------------------------------------------------------------------------

  /** First element matching any selector in the list, scoped to root. */
  function queryFirst(list, root = document) {
    for (const sel of list) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* invalid selector for this DOM, try next */ }
    }
    return null;
  }

  /** All elements matching any selector in the list (deduped). */
  function queryAll(list, root = document) {
    const out = [];
    const seen = new Set();
    for (const sel of list) {
      try {
        for (const el of root.querySelectorAll(sel)) {
          if (!seen.has(el)) { seen.add(el); out.push(el); }
        }
      } catch { /* skip */ }
    }
    return out;
  }

  /** "1,234.56" / "−12.3" / "12.3%" -> number | null. Never NaN. */
  function parseNum(text) {
    if (text == null) return null;
    const cleaned = String(text)
      .replace(/[\u2212\u2013\u2014]/g, '-') // unicode minus -> hyphen
      .replace(/[^0-9.\-eE+]/g, '')
      .trim();
    if (!cleaned || cleaned === '-' || cleaned === '.') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  /** Visible text of an element, collapsed whitespace. */
  function text(el) {
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Clean a derived indicator name: drops hidden-plot markers (∅), leftover
   * numbers/units from concatenated row text, and trailing separators.
   * "MktBreadth∅∅−41.31…" -> "MktBreadth"; "Vol K K STEALTH v" -> "Vol STEALTH v".
   * stripNumbers=false for genuine title nodes (keeps "EMA 20" intact);
   * the strips only eat SIGNED runs ("−41.31−53.64") and whitespace-separated
   * values (" 61.24"), so glued versions like "V1.5" survive.
   */
  function tidyIndicatorName(s, stripNumbers = true) {
    let out = String(s ?? '')
      .replace(/[∅Ø◌□■▪▫]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s[KMkmbB%](?=\s|$)/g, '');
    if (stripNumbers) {
      out = out
        .replace(/(?:[−\-+][0-9][0-9,.]*(?:\.[0-9]+)?\s*[KMB%]?\s*)+$/g, '')
        .replace(/(?:\s+[−+]?[0-9][0-9,.]*(?:\.[0-9]+)?\s*[KMB%]?)+\s*$/g, '');
    }
    return out.replace(/[•·|–—:;,\s]+$/g, '').trim().slice(0, 80);
  }

  // ---------------------------------------------------------------------------
  // Symbol extraction
  // ---------------------------------------------------------------------------

  function extractSymbol(legendSeriesEl) {
    // 1) Legend series title node (most reliable, already timeframe-agnostic).
    try {
      const titleSelectors = [
        '[data-name="legend-series-title"]',
        '[data-name="legend-source-title"]',
        '.chart-title__title',
        '[class*="title__title"]',
      ];
      const scope = legendSeriesEl ?? document;
      for (const sel of titleSelectors) {
        const el = scope.querySelector?.(sel) ?? queryFirst([sel]);
        if (el && text(el)) {
          // Title may be "NASDAQ:AAPL • 5" — keep the symbol part only.
          const raw = text(el).split('•')[0].trim();
          if (raw) return raw;
        }
      }
      // Symbol = text preceding the OHLC run. Handles concatenated
      // textContent ("BSE:SENSEXO72,472.33H…") — strip the run, then take the
      // trailing symbol-like token (dropping decorations like a lone "5").
      if (legendSeriesEl) {
        try {
          const rowText = text(legendSeriesEl);
          const seqIdx = rowText.search(/O\s*[−\-+]?[0-9]/i);
          if (seqIdx > 0) {
            const prefix = rowText.slice(0, seqIdx)
              .replace(/[•·|]/g, ' ')
              .replace(/\s+\d+\s*$/, '')
              .trim();
            const mt = prefix.match(/([A-Za-z0-9_.$:\-]{1,30})$/);
            if (mt && /[A-Za-z]/.test(mt[1])) return mt[1];
          }
        } catch { /* fall through to existing patterns */ }
      }
      // Legend row text often starts with the symbol before O/H/L/C tokens.
      if (legendSeriesEl) {
        const rowText = text(legendSeriesEl);
        const m = rowText.match(/^([A-Z0-9_.\-:]+(?:\s[A-Z0-9_.\-:]+)?)\s+[OHLC]/i);
        if (m) return m[1].replace(/\s+O$/i, '').trim();
      }
    } catch { /* fall through */ }

    // 2) document.title is usually "AAPL ... — TradingView".
    try {
      const t = document.title || '';
      const m = t.match(/^([A-Z0-9_.\-:]+)/);
      if (m) return m[1];
    } catch { /* ignore */ }

    // 3) URL: /chart/<symbol>/ or /symbols/<EXCHANGE>-<SYMBOL>/.
    try {
      const url = location.href;
      let m = url.match(/\/symbols\/([A-Z0-9_.\-]+)/i);
      if (m) return m[1].replace(/-/g, ':');
      m = url.match(/[?&]symbol=([^&]+)/i);
      if (m) return decodeURIComponent(m[1]);
    } catch { /* ignore */ }

    return 'UNKNOWN';
  }

  // ---------------------------------------------------------------------------
  // Timeframe extraction (universal — no hardcoded timeframe anywhere)
  // ---------------------------------------------------------------------------

  function extractTimeframe(pageModel) {
    // 1) Page model resolution, if Method A reached the widget.
    try {
      const raw = pageModel?.timeframe;
      if (raw) return normalizeTimeframe(String(raw));
    } catch { /* ignore */ }

    // 2) Active timeframe button in the toolbar.
    try {
      const active = queryFirst(SELECTORS.timeframeActive);
      if (active) {
        const cand = active.getAttribute('data-value')
          ?? active.getAttribute('data-interval')
          ?? text(active).split(' ')[0];
        if (cand) return normalizeTimeframe(cand);
      }
    } catch { /* ignore */ }

    // 2b) Current-interval display button (header shows e.g. "5m" / "1H" / "D").
    try {
      const ivBtn = queryFirst([
        '[data-name="interval-dialog-button"]',
        '#header-toolbar-intervals button',
        '[data-name="header-toolbar-intervals"] button',
      ]);
      if (ivBtn) {
        const cand = ivBtn.getAttribute('data-value')
          ?? ivBtn.getAttribute('data-interval')
          ?? text(ivBtn).split(/[\s|•]+/)[0];
        if (cand) return normalizeTimeframe(cand);
      }
    } catch { /* ignore */ }

    // 2c) Toolbar text scan: any active-looking button whose label IS a
    // timeframe ("5m", "1H", "D", "240", ...). Survives attribute renames.
    try {
      const tfPat = /^(\d{1,4}\s*[smhSMH]|[DWMdwm]|1[Hh]|1\s*[DWMdwm]|\d{1,3})$/;
      const els = document.querySelectorAll(
        '#header-toolbar-intervals button, #header-toolbar-intervals [role="button"], ' +
        '[data-name="timeframes-menu"] button, header button, [role="toolbar"] button'
      );
      let fallback = null;
      for (const el of els) {
        const label = text(el).split(/[\s|•]+/)[0];
        if (!label || !tfPat.test(label)) continue;
        const active = el.getAttribute('aria-pressed') === 'true'
          || el.getAttribute('aria-checked') === 'true'
          || /active|selected|checked|isActive/i.test(el.className ?? '');
        if (active) return normalizeTimeframe(label);
        fallback ??= label;
      }
      if (fallback) return normalizeTimeframe(fallback);
    } catch { /* ignore */ }

    // 3) URL (?interval=60 / ?timeframe=D on shared links).
    try {
      const m = location.href.match(/[?&](?:interval|timeframe)=([^&]+)/i);
      if (m) return normalizeTimeframe(decodeURIComponent(m[1]));
    } catch { /* ignore */ }

    return 'unknown';
  }

  /** Map TV internal codes ("60", "D") and labels ("1H", "1D") to canonical form. */
  function normalizeTimeframe(raw) {
    const t = String(raw).trim();
    if (RESOLUTION_MAP[t]) return RESOLUTION_MAP[t];
    const up = t.toUpperCase();
    if (RESOLUTION_MAP[up]) return RESOLUTION_MAP[up];
    // Generic "60m"/"4H"/"1d" style labels.
    const m = up.match(/^(\d+)\s*([SMHDW])$/);
    if (m) {
      const unit = { S: 's', M: 'm', H: 'h', D: 'D', W: 'W' }[m[2]];
      return `${m[1]}${unit}`;
    }
    return t || 'unknown'; // never throw on unseen formats
  }

  // ---------------------------------------------------------------------------
  // OHLC extraction from the legend overlay (Method B core)
  // ---------------------------------------------------------------------------

  /**
   * Parses a legend series row like:
   *   "AAPL O 227.12 H 228.40 L 226.90 C 228.05 +0.93 (+0.41%)"
   * Primary path locates the O…H…L…C run first and takes its first four
   * numbers — this works for split nodes ("O 227.12"), single nodes
   * ("O227.12") AND concatenated textContent ("…SENSEXO72,472.33H…C…").
   */
  function parseOHLCRow(rowEl) {
    const result = { open: null, high: null, low: null, close: null };
    if (!rowEl) return result;
    try {
      const full = text(rowEl);

      // Pass 1 (primary): sequence-anchored — first four numbers of the run.
      const seq = OHLC_SEQ.exec(full);
      if (seq) {
        const nums = (seq[0].match(/[−\-+]?[0-9][0-9,.]*(?:\.[0-9]+)?(?:[eE][−\-+]?[0-9]+)?/g) || [])
          .map(parseNum)
          .filter((v) => v != null);
        if (nums.length >= 4) {
          result.open = nums[0]; result.high = nums[1];
          result.low = nums[2]; result.close = nums[3];
          return result;
        }
      }

      // Pass 2 (legacy): letter-anchored regex over the whole row text.
      const re = /([OHLC])\s*([−\-+]?[0-9][0-9,]*\.?[0-9]*(?:[eE][−\-+]?[0-9]+)?)/gi;
      let m;
      while ((m = re.exec(full)) !== null) {
        const key = { O: 'open', H: 'high', L: 'low', C: 'close' }[m[1].toUpperCase()];
        if (key && result[key] == null) result[key] = parseNum(m[2]);
      }

      // Pass 2 (fallback): if letters are missing in this locale/build,
      // take the first 4 numeric value-nodes as O/H/L/C in order.
      if (Object.values(result).every((v) => v == null)) {
        const nodes = queryAll(SELECTORS.ohlcValue, rowEl);
        const nums = nodes.map((n) => parseNum(text(n))).filter((n) => n != null);
        if (nums.length >= 4) {
          result.open = nums[0]; result.high = nums[1];
          result.low = nums[2]; result.close = nums[3];
        }
      }
    } catch { /* return partials */ }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Indicator extraction (dynamic key-value pairs)
  // ---------------------------------------------------------------------------

  /** Title-node selectors inside an indicator/legend row. */
  const TITLE_SEL = '[data-name="legend-source-title"], [class*="title__title"], [class*="sourceTitle"], .title';

  /**
   * Derive a clean indicator name from a legend row.
   * Never uses the raw row text — that concatenates name+values into
   * "Vol244.41 K134.28 K…". Order of trust:
   *   1. a dedicated title node ("EMA 20", "RSI (14)") — kept verbatim
   *   2. the row text with every value node REMOVED, then tidied
   *   3. '' — caller skips the row rather than emit garbage
   */
  function deriveRowName(row) {
    try {
      const nameEl = row.querySelector(TITLE_SEL);
      if (nameEl) {
        const n = tidyIndicatorName(text(nameEl), false);
        if (n) return n;
      }
    } catch { /* fall through */ }
    try {
      const clone = row.cloneNode(true);
      queryAll(SELECTORS.ohlcValue, clone).forEach((n) => n.remove());
      const n = tidyIndicatorName(text(clone));
      if (n) return n;
    } catch { /* fall through */ }
    return '';
  }

  /**
   * Attribute-independent indicator scan: when the data-name rows miss
   * entirely (renamed build), look at the legend container's children for
   * named value rows ("RSI 61.24", "MACD 1.20 0.90 …"). Skips the series row
   * (OHLC run), pure-number rows (no name), and oversized containers.
   */
  function parseIndicatorsGeneric(seriesEl) {
    const indicators = {};
    try {
      if (!seriesEl) return indicators;
      // Ascend to the smallest ancestor that holds more than the series row.
      const seriesText = text(seriesEl);
      let scope = null;
      let el = seriesEl.parentElement;
      for (let d = 0; d < 4 && el; d++) {
        const t = text(el);
        if (t.length > seriesText.length + 10 && t.length < 3000) { scope = el; break; }
        el = el.parentElement;
      }
      if (!scope) return indicators;
      for (const child of scope.children) {
        try {
          if (child === seriesEl || child.contains(seriesEl)) continue;
          const t = text(child);
          if (!t || t.length > 200 || t.length < 2) continue;
          if (!/[0-9]/.test(t)) continue; // no values at all
          if (OHLC_SEQ.test(t)) continue; // another OHLC row (e.g. compare) — skip
          if (/^[\d\s,.\-+−%▲▼()]+$/.test(t)) continue; // pure numbers, no name

          const name = deriveRowName(child);
          if (!name || !/[A-Za-z]/.test(name)) continue; // nameless row — skip

          // Prefer matched value nodes with plot labels; fall back to numbers in the row text.
          const nodes = queryAll(SELECTORS.ohlcValue, child);
          const values = nodes.map((n) => ({ label: n.getAttribute?.('title') || n.dataset?.plot || '', value: parseNum(text(n)) }));
          const labeled = values.filter((v) => v.label && String(v.label).trim() && v.value != null);
          if (labeled.length > 0) {
            values.forEach((v, i) => {
              if (v.value == null) return;
              const key = v.label && String(v.label).trim() ? `${name} › ${String(v.label).trim()}` : `${name} [${i}]`;
              indicators[key] = v.value;
            });
          } else {
            const nums = (nodes.length
              ? nodes.map((n) => parseNum(text(n)))
              : (t.match(/[−\-+]?[0-9][0-9,.]*(?:\.[0-9]+)?/g) || []).map(parseNum)
            ).filter((v) => v != null);
            if (!nums.length) continue;
            if (nums.length === 1) indicators[name] = nums[0];
            else nums.forEach((v, i) => { indicators[`${name} [${i}]`] = v; });
          }
        } catch { /* one bad row must not kill the rest */ }
      }
    } catch { /* return whatever we gathered */ }
    return indicators;
  }

  /**
   * Each active indicator renders a legend row with its display name
   * (e.g. "RSI (14)", "MACD 12 26 close 9") plus one value node per plot.
   * Single-plot  -> { "RSI (14)": 61.24 }
   * Multi-plot   -> { "MACD …": { "MACD": 1.2, "Signal": 0.9 } } flattened to
   *                 { "MACD … › MACD": 1.2, "MACD … › Signal": 0.9 }
   */
  function parseIndicators(seriesEl) {
    const indicators = {};
    try {
      const rows = queryAll(SELECTORS.indicatorItem).filter((el) => el !== seriesEl);
      for (const row of rows) {
        try {
          if (!row.isConnected || row.offsetParent === null && row.textContent?.length > 500) {
            // keep hidden-pane rows out only if clearly detached; otherwise
            // accept (TV sometimes reports offsetParent null in iframes).
          }
          const valueNodes = queryAll(SELECTORS.ohlcValue, row);
          const values = valueNodes.map((n) => ({ label: n.getAttribute?.('title') || n.dataset?.plot || '', value: parseNum(text(n)) }));

          // Name via the shared deriver (title node, else row-minus-values).
          const name = deriveRowName(row);
          if (!name || !/[A-Za-z]/.test(name)) continue;
          // Skip the symbol row if it leaked into this list.
          if (/^[OHLC]\s/i.test(name) || row === seriesEl) continue;

          const nums = values.map((v) => v.value).filter((v) => v != null);
          if (!nums.length) {
            // Values use unknown classes on this build: fall back to numbers
            // from the row text (plot labels unavailable — indexed keys).
            const rex = (text(row).match(/[−\-+]?[0-9][0-9,.]*(?:\.[0-9]+)?/g) || [])
              .map(parseNum)
              .filter((v) => v != null);
            if (!rex.length) continue; // indicator still loading — skip, don't emit NaN
            if (rex.length === 1) indicators[name] = rex[0];
            else rex.forEach((v, i) => { indicators[`${name} [${i}]`] = v; });
            continue;
          }

          if (nums.length === 1 && values.length <= 1) {
            indicators[name] = nums[0];
          } else {
            // Multi-plot: one key per plot. Rows often carry shadow nodes
            // (same value twice, once unlabeled) — prefer labeled keys and
            // drop unlabeled entries duplicating a labeled value.
            const entries = [];
            values.forEach((v, i) => {
              if (v.value == null) return;
              const labeled = !!(v.label && String(v.label).trim());
              entries.push({
                key: labeled ? `${name} › ${String(v.label).trim()}` : `${name} [${i}]`,
                value: v.value,
                labeled,
              });
            });
            const labeledValues = new Set(entries.filter((e) => e.labeled).map((e) => e.value));
            const seenKeys = new Set();
            for (const e of entries) {
              if (!e.labeled && labeledValues.has(e.value)) continue;
              if (seenKeys.has(e.key)) continue;
              seenKeys.add(e.key);
              indicators[e.key] = e.value;
            }
          }
        } catch { /* one bad row must not kill the rest */ }
      }
    } catch { /* return whatever we gathered */ }
    // Generic fallback: attribute-based rows missed everything (renamed
    // build) — scan the legend container's children for named value rows.
    if (!Object.keys(indicators).length) {
      Object.assign(indicators, parseIndicatorsGeneric(seriesEl));
    }
    return indicators;
  }

  // ---------------------------------------------------------------------------
  // Frame / page diagnosis (wrong-frame & non-chart-page handling)
  //
  // Why this exists: content.js runs in EVERY frame (all_frames:true) and
  // chrome.tabs.sendMessage delivers to all of them — the FIRST response wins.
  // A non-chart iframe can therefore answer "not found" before the real chart
  // frame responds. Fixes: (a) isChartFrame() marks empty frames
  // (NO_CHART_IN_FRAME) so popup.js can retarget by frameId; (b) pageType()
  // gives actionable guidance on overview/screener pages; (c)
  // findSeriesByOHLCText() locates the series row by its O…H…L…C… text
  // signature without depending on data-name attributes at all.
  // ---------------------------------------------------------------------------

  /** 'chart' | 'symbol-overview' | 'screener' | 'ideas' | 'pine-script' | 'other' */
  function pageType() {
    try {
      const p = new URL(location.href).pathname.toLowerCase();
      if (p.startsWith('/chart')) return 'chart';
      if (p.startsWith('/symbols')) return 'symbol-overview';
      if (p.startsWith('/screener')) return 'screener';
      if (p.startsWith('/idea')) return 'ideas';
      if (p.startsWith('/pine') || p.startsWith('/scripts')) return 'pine-script';
      return 'other';
    } catch { return 'other'; }
  }

  function noChartGuidance() {
    switch (pageType()) {
      case 'symbol-overview':
        return 'No chart legend here — you are on a symbol overview page. Open the full chart ' +
               '(top menu Chart, or tradingview.com/chart/ with this symbol) and retry.';
      case 'screener':
        return 'No chart legend here — you are on the Screener. Open the full chart (tradingview.com/chart/) first.';
      case 'ideas':
      case 'pine-script':
        return 'No chart legend here — open the full chart (tradingview.com/chart/) first.';
      case 'chart':
        return 'No chart legend in this frame. If candles ARE visible, the message reached the wrong ' +
               'frame — use the Diagnose button in the popup to retarget, or reload the tab.';
      default:
        return 'No TradingView chart legend here. Open a chart at tradingview.com/chart/ and retry.';
    }
  }

  /**
   * Attribute-independent series locator: searches element text (not single
   * text nodes — split-node markup like <span>O</span><span>72,472</span>
   * defeats node-level matching) for the O…H…L…C signature and returns the
   * TIGHTEST container holding it (usually the series row itself).
   * Scoped to legend containers when they exist, so it stays cheap.
   */
  function findSeriesByOHLCText() {
    try {
      const scopes = queryAll(SELECTORS.legendRoot);
      if (!scopes.length && document.body) scopes.push(document.body);
      let best = null;
      let bestLen = Infinity;
      for (const scope of scopes.slice(0, 8)) {
        try {
          const cands = [scope, ...scope.querySelectorAll('*')];
          for (const el of cands) {
            let t = '';
            try { t = el.textContent ?? ''; } catch { continue; }
            if (!t || t.length > 600 || t.length >= bestLen) continue;
            if (OHLC_SEQ.test(t)) { best = el; bestLen = t.length; }
          }
          if (bestLen <= 140) break; // tight row found — stop early
        } catch { /* next scope */ }
      }
      return best;
    } catch { /* ignore */ }
    return null;
  }

  /** Does THIS frame host (or is still rendering) a chart? */
  function isChartFrame() {
    try {
      if (queryFirst(SELECTORS.legendRoot) || queryFirst(SELECTORS.seriesItem)) return true;
      if (findSeriesByOHLCText()) return true;
      // A chart container means the chart belongs to this frame even if its
      // legend hasn't rendered yet (loading state — WE should answer).
      if (document.querySelector(
        '.chart-container, [data-name="chart-container"], #tv_chart_container, .tv-chart-container'
      )) return true;
    } catch { /* ignore */ }
    return false;
  }

  /** Shared verdict for "no legend": wrong frame/page vs still loading. */
  function chartMissingVerdict() {
    const t = pageType();
    if (!isChartFrame() || t !== 'chart') {
      return {
        ok: false,
        error: t === 'chart' ? 'NO_CHART_IN_FRAME' : 'NO_CHART_ON_PAGE',
        message: noChartGuidance(),
        pageType: t,
      };
    }
    return {
      ok: false,
      error: 'CHART_NOT_READY',
      message: 'TradingView legend not found. The chart may still be loading — wait for candles to render, then retry.',
      pageType: t,
    };
  }

  /** Full self-diagnosis for the Diagnose button. Never throws. */
  function diagnoseFrame() {
    const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
    const seriesHits = {};
    for (const sel of [...SELECTORS.legendRoot, ...SELECTORS.seriesItem]) {
      seriesHits[sel] = safe(() => document.querySelectorAll(sel).length, -1);
    }
    return {
      url: safe(() => location.href.slice(0, 160), ''),
      title: safe(() => (document.title ?? '').slice(0, 100), ''),
      isTop: safe(() => window.self === window.top, 'unknown'),
      pageType: pageType(),
      isChartFrame: isChartFrame(),
      canvasCount: safe(() => document.querySelectorAll('canvas').length, -1),
      hasChartContainer: safe(() => !!document.querySelector(
        '.chart-container, [data-name="chart-container"], #tv_chart_container, .tv-chart-container'), false),
      seriesHits,
      timeframeGuess: safe(() => extractTimeframe(readPageModel()), 'unknown'),
      symbolGuess: safe(() => extractSymbol(queryFirst(SELECTORS.seriesItem)), 'UNKNOWN'),
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshot assembly — the Data Schema
  // ---------------------------------------------------------------------------

  function buildSnapshot() {
    const pageModel = readPageModel(); // Method A (may be null — that's fine)

    // Locate the symbol series row for Method B (attribute selectors first,
    // raw OHLC-text scan as the rename-proof fallback).
    const seriesEl = queryFirst(SELECTORS.seriesItem) ?? findSeriesByOHLCText();
    const legendRoot = queryFirst(SELECTORS.legendRoot);

    const symbol = extractSymbol(seriesEl) !== 'UNKNOWN'
      ? extractSymbol(seriesEl)
      : (pageModel?.symbol ?? extractSymbol(seriesEl));
    const timeframe = extractTimeframe(pageModel);
    const ohlc = parseOHLCRow(seriesEl);
    const indicators = parseIndicators(seriesEl);

    // Timestamp: prefer the bar time from the page model (real candle time);
    // otherwise wall-clock (documented as capture time, not bar time).
    let epochMs = Date.now();
    let iso = new Date(epochMs).toISOString();
    let timeSource = 'capture-time';
    try {
      const lastBar = Array.isArray(pageModel?.bars) && pageModel.bars.length
        ? pageModel.bars[pageModel.bars.length - 1]
        : null;
      if (lastBar?.epochMs) {
        epochMs = lastBar.epochMs;
        iso = lastBar.iso ?? new Date(epochMs).toISOString();
        timeSource = 'bar-time';
      }
    } catch { /* keep wall-clock */ }

    const hasOHLC = [ohlc.open, ohlc.high, ohlc.low, ohlc.close].some((v) => v != null);

    const data = {
      timestamp: iso,
      epochMs,
      timeSource,
      symbol,
      timeframe,
      open: ohlc.open,
      high: ohlc.high,
      low: ohlc.low,
      close: ohlc.close,
      indicators,
      meta: {
        source: pageModel?.source && pageModel.source !== 'page-unavailable'
          ? `hybrid:${pageModel.source}+legend-dom`
          : 'legend-dom',
        legendFound: !!seriesEl,
        legendRootFound: !!legendRoot,
        url: location.href,
      },
    };

    // Robust error handling: distinguish wrong-frame/page from still-loading.
    if (!seriesEl && !hasOHLC) {
      return { ...chartMissingVerdict(), data }; // partial data still useful
    }
    if (!hasOHLC) {
      return {
        ok: false,
        error: 'OHLC_NOT_READY',
        message: 'Legend found but OHLC values are empty (series still loading or crosshair on an empty area). Move the crosshair onto candles and retry.',
        data,
      };
    }
    return { ok: true, data };
  }

  // ---------------------------------------------------------------------------
  // Streaming (MutationObserver + interval hybrid)
  // ---------------------------------------------------------------------------

  function pushTick(reason) {
    try {
      const snap = buildSnapshot();
      const json = JSON.stringify(snap.ok ? snap.data : { error: snap.error, ...snap.data });
      if (json === lastPushedJson) return; // dedupe: don't spam identical ticks
      lastPushedJson = json;
      chrome.runtime.sendMessage({ type: 'TV_STREAM_TICK', reason, ...snap })
        .catch(() => { /* popup closed — keep streaming; storage still updates */ });
      // Persist latest for popup reopen / service-worker reads.
      chrome.storage.local.set({ tvLastSnapshot: snap.ok ? snap.data : null, tvLastError: snap.ok ? null : snap.error })
        .catch(() => {});
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'TV_STREAM_TICK', ok: false, error: 'STREAM_TICK_FAILED', message: String(err?.message ?? err) })
        .catch(() => {});
    }
  }

  function startStream(intervalMs = STREAM_DEFAULT_MS) {
    stopStream(false);
    streaming = true;
    const ms = Math.max(Number(intervalMs) || STREAM_DEFAULT_MS, STREAM_MIN_MS);

    // Interval covers slow-mutating legends (new candle prints).
    streamTimer = setInterval(() => { if (streaming) pushTick('interval'); }, ms);

    // Observer covers fast updates (crosshair moves update legend instantly).
    try {
      const root = queryFirst(SELECTORS.legendRoot) ?? document.body;
      legendObserver = new MutationObserver(() => { if (streaming) pushTick('mutation'); });
      legendObserver.observe(root, {
        childList: true, subtree: true, characterData: true,
      });
    } catch {
      legendObserver = null; // interval alone still streams
    }
    pushTick('stream-start');
  }

  function stopStream(notify = true) {
    streaming = false;
    if (streamTimer) { clearInterval(streamTimer); streamTimer = null; }
    if (legendObserver) { legendObserver.disconnect(); legendObserver = null; }
    if (notify) lastPushedJson = '';
  }

  // ---------------------------------------------------------------------------
  // Historical range fetch (date-range CSV export)
  //
  // Data path, in order:
  //   1. Internal model (injected.js getRange): real bar timestamps + optional
  //      per-bar study values. Authoritative when reachable.
  //   2. Auto-pan: if the requested Start predates loaded history, we pan the
  //      chart left (page-context timeScale API, then synthetic wheel events)
  //      and re-read until the start candle is covered or TV stops backfilling.
  //   3. Crosshair-sweep fallback: when the internal model is unreachable but
  //      the legend works, we sweep synthetic hover events across the canvas
  //      and read OHLC (+ live indicator readouts) per position. Timestamps
  //      then come from the time-axis highlight label and may be approximate —
  //      this is clearly flagged in warnings.
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Canonical timeframe ("5m","1h","1D","1W","1M","1s"...) -> ms per bar. */
  function timeframeToMs(tf) {
    try {
      const m = String(tf ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([smhDW])$/i);
      if (!m) {
        // Internal codes without explicit unit: digits-only = minutes on TV.
        if (/^\d+$/.test(String(tf ?? '').trim())) return Number(tf) * 60 * 1000;
        return null;
      }
      const n = Number(m[1]);
      const unit = { s: 1000, m: 60 * 1000, h: 3600 * 1000, D: 86400 * 1000, W: 7 * 86400 * 1000 }[m[2]];
      // 'M' (month) is variable-length; approximate as 30 days for range sizing.
      const ms = m[2] === 'M' ? n * 30 * 86400 * 1000 : n * unit;
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    } catch { return null; }
  }

  /** Thin wrapper around the page-context getRange API. Never throws. */
  function readPageRange(startMs, endMs) {
    try {
      const api = window.__TV_EXTRACTOR__;
      if (api && typeof api.getRange === 'function') {
        const res = api.getRange(startMs, endMs);
        if (res && typeof res === 'object') return res;
      }
      return callPageSync('getRange', [startMs, endMs]);
    } catch { return null; }
  }

  /** Thin wrapper around the page-context scroll helper. Never throws. */
  function callPageScroll(direction, steps) {
    try {
      if (window.__TV_EXTRACTOR__?.scrollChart) {
        return window.__TV_EXTRACTOR__.scrollChart(direction, steps);
      }
      return callPageSync('scrollChart', [direction, steps]);
    } catch { return null; }
  }

  function getCapturedDatafeed() {
    try {
      if (window.__TV_EXTRACTOR__?.capturedDatafeed) {
        return window.__TV_EXTRACTOR__.capturedDatafeed;
      }
      return callPageSync('getCapturedDatafeed') || [];
    } catch { return []; }
  }

  /**
   * Main price chart canvas for pan/sweep.
   * Selection is by VISIBLE LAYOUT AREA (getBoundingClientRect), not by the
   * canvas width/height attributes: TradingView keeps up to ~15 canvases and
   * some large offscreen buffers (hidden panes, snapshot buffers) have huge
   * attribute pixels but a zero layout box — dispatching hovers at those
   * coordinates can never reach the real chart.
   */
  function findChartCanvas() {
    const sels = [
      '.chart-container canvas',
      '[data-name="chart-container"] canvas',
      'canvas',
    ];
    for (const s of sels) {
      let all;
      try { all = [...document.querySelectorAll(s)]; } catch { continue; }
      if (!all.length) continue;
      let best = null;
      let bestArea = 0;
      for (const c of all) {
        try {
          const r = c.getBoundingClientRect();
          const area = (r?.width ?? 0) * (r?.height ?? 0);
          // Real chart panes are at least 80x60 CSS px; skip hidden buffers.
          if (area >= 80 * 60 && area > bestArea) { best = c; bestArea = area; }
        } catch { /* ignore */ }
      }
      if (best) return best;
    }
    // Degraded fallback: largest canvas by attributes (old behaviour). The
    // caller records the zero-layout case in diagnostics so it is visible.
    let fallback = null;
    let fb = 0;
    try {
      for (const c of document.querySelectorAll('canvas')) {
        const a = (c.width || 0) * (c.height || 0);
        if (a > fb) { fb = a; fallback = c; }
      }
    } catch { /* ignore */ }
    return fallback;
  }

  /**
   * Dispatch a realistic hover at (x, y).
   * TV's tracker ignores pointer events whose pointerType is empty, and it
   * only starts following after a pointerover — both are emitted here, plus a
   * plain mousemove (what most TV exporters rely on).
   */
  function dispatchHover(target, x, y, first) {
    if (!target || typeof target.dispatchEvent !== 'function') return false;
    const base = {
      clientX: x, clientY: y, screenX: x, screenY: y,
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, buttons: 0, detail: 1,
    };
    let ok = false;
    if (first) {
      try { target.dispatchEvent(new MouseEvent('pointerover', base)); ok = true; } catch { /* ignore */ }
      try { target.dispatchEvent(new MouseEvent('mouseover', base)); ok = true; } catch { /* ignore */ }
    }
    try {
      target.dispatchEvent(new PointerEvent('pointermove', {
        ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        width: 1, height: 1, pressure: 0.5, tiltX: 0, tiltY: 0,
      }));
      ok = true;
    } catch { /* ctor rejected optional fields */ }
    try { target.dispatchEvent(new MouseEvent('mousemove', base)); ok = true; } catch { /* ignore */ }
    return ok;
  }

  /**
   * Every element a real pointer could hit at (x, y) — not only the topmost.
   * TradingView stacks ~15 canvases and the crosshair listener is not always
   * on the one elementFromPoint returns, so hovers are fanned out to all
   * candidates. Events bubble, so hitting a few extra targets is harmless.
   */
  function collectHoverTargets(canvas, x, y) {
    const out = [];
    const push = (el) => {
      if (!el || typeof el.dispatchEvent !== 'function') return;
      if (el === document.documentElement || el === document.body) return;
      if (!out.includes(el)) out.push(el);
    };
    try { push(document.elementFromPoint(x, y)); } catch { /* not implemented (jsdom) */ }
    push(canvas);
    try {
      for (const c of document.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) push(c);
      }
    } catch { /* ignore */ }
    // Some builds attach the tracker to the chart root rather than a canvas.
    try {
      const root = canvas?.closest?.('.chart-container, [data-name="chart-container"], #tv_chart_container')
        ?? document.querySelector('.chart-container, [data-name="chart-container"], #tv_chart_container');
      if (root) {
        const r = root.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) push(root);
      }
    } catch { /* ignore */ }
    return out;
  }

  /** Fan a hover out to every candidate target. True if any event was sent. */
  function dispatchHoverAt(targets, x, y, first) {
    let ok = false;
    for (const t of targets) if (dispatchHover(t, x, y, first)) ok = true;
    return ok;
  }

  /** Short human-readable canvas identity for diagnostics. */
  function labelCanvas(c) {
    if (!c) return 'none';
    let w = 0;
    let h = 0;
    try { const r = c.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); } catch { /* ignore */ }
    const cls = typeof c.className === 'string' && c.className.trim()
      ? `.${c.className.trim().split(/\s+/)[0]}` : '';
    return `${(c.tagName ?? '?').toLowerCase()}${c.id ? `#${c.id}` : ''}${cls}@${w}x${h}`;
  }

  /**
   * All layout-valid chart canvases, biggest first. The sweep probes these in
   * order instead of trusting "biggest = main pane" — on a 15-canvas build the
   * largest surface is sometimes a snapshot buffer that ignores input entirely.
   */
  function listCanvasCandidates() {
    const all = [];
    const add = (sel) => { try { all.push(...document.querySelectorAll(sel)); } catch { /* ignore */ } };
    add('.chart-container canvas');
    add('[data-name="chart-container"] canvas');
    if (!all.length) add('canvas');
    const scored = [];
    for (const c of all) {
      try {
        const r = c.getBoundingClientRect();
        const area = (r?.width ?? 0) * (r?.height ?? 0);
        if (area >= 80 * 60) scored.push({ el: c, area }); // real panes are >= 80x60 CSS px
      } catch { /* ignore */ }
    }
    scored.sort((a, b) => b.area - a.area);
    return scored.map((s) => s.el);
  }

  /**
   * "Wake" the crosshair the way a human does — bring the chart into focus
   * first. TV only starts tracking the pointer once the chart root owns DOM
   * focus on several builds, which is exactly why bare synthetic moves can
   * leave the legend frozen. No button press is simulated (that would start
   * a drawing action on some layouts).
   */
  function primeCrosshair(canvas, rect) {
    try {
      if (canvas && canvas.tabIndex < 0) canvas.setAttribute('tabindex', '-1');
      canvas?.focus?.({ preventScroll: true });
    } catch { /* not focusable — harmless */ }
    const x = rect.right - 2;
    const y = rect.top + rect.height * 0.4;
    dispatchHoverAt(collectHoverTargets(canvas, x, y), x, y, true);
  }

  /**
   * Probe candidate canvases with real-looking hovers and keep the first one
   * that actually changes the legend. Self-correcting selection beats guessing
   * which of 15 stacked canvases owns the crosshair.
   */
  async function probeResponsiveCanvas(candidates, seriesElHint) {
    const read = () => {
      const el = (seriesElHint && seriesElHint.isConnected !== false ? seriesElHint : null)
        ?? queryFirst(SELECTORS.seriesItem) ?? findSeriesByOHLCText();
      return el ? text(el) : '';
    };
    const tried = [];
    for (const c of candidates.slice(0, 4)) {
      let r = null;
      try { r = c.getBoundingClientRect(); } catch { /* ignore */ }
      if (!r || r.width < 50 || r.height < 30) continue;
      const before = read();
      for (const fx of [0.3, 0.7]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * 0.4;
        // Probe the candidate ALONE (no fan-out) so `moved` is a truthful
        // signal of which canvas owns the crosshair listener. The sweep itself
        // still fans out to every canvas under the pointer.
        dispatchHover(c, x, y, fx === 0.3);
        await sleep(45);
      }
      const after = read();
      const moved = !!(before && after && before !== after);
      tried.push(`${labelCanvas(c)} moved=${moved}`);
      if (moved) return { canvas: c, responsive: true, tried };
    }
    return { canvas: candidates[0] ?? null, responsive: false, tried };
  }

  /** Fire-and-forget progress event so the popup can show a live status line. */
  function emitProgress(phase, detail) {
    try {
      chrome.runtime.sendMessage({ type: 'TV_FETCH_PROGRESS', phase, detail })
        .catch(() => { /* popup closed — harmless */ });
    } catch { /* ignore */ }
  }

  /** Epoch ms -> Excel-friendly "YYYY-MM-DD HH:MM:SS" (UTC, deterministic). */
  function excelDate(epochMs) {
    try {
      const d = new Date(epochMs);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
             `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    } catch { return ''; }
  }

  /** RFC-4180 field escaping (quotes/commas/newlines). CRLF join is added by toCSV. */
  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** Safe filename fragment: symbol/timeframe may contain ":", "/", spaces. */
  function sanitizeFilename(s) {
    return String(s ?? 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) || 'unknown';
  }

  /**
   * Auto-pan loop: keeps panning older until the requested start is covered,
   * TV stops yielding older data (stuck), or attempts run out.
   * Returns { coverage, panned, attempts }.
   */
  async function ensureCoverage(startMs, endMs) {
    let coverage = readPageRange(startMs, endMs);
    let attempts = 0;
    let panned = false;
    let lastEarliest = coverage?.earliestMs ?? null;
    let stuck = 0;

    while (attempts < FETCH_SCROLL_ATTEMPTS) {
      const earliest = coverage?.earliestMs ?? null;
      if (earliest != null && earliest <= startMs) break; // start visible
      if (earliest != null && earliest === lastEarliest) stuck += 1;
      else stuck = 0;
      lastEarliest = earliest;
      if (stuck >= 2) break; // TV has no older data to give (symbol inception)

      attempts += 1;
      panned = true;
      emitProgress('scrolling',
        `Start not loaded yet — panning chart back (${attempts}/${FETCH_SCROLL_ATTEMPTS})…`);
      try { callPageScroll('older', 3); } catch { /* wheel fallback below */ }
      try {
        const cv = findChartCanvas();
        if (cv) {
          for (let i = 0; i < 3; i++) {
            cv.dispatchEvent(new WheelEvent('wheel',
              { deltaX: 320, deltaY: 0, bubbles: true, cancelable: true }));
          }
        }
      } catch { /* ignore — page-context scroll may still have worked */ }
      await sleep(FETCH_SETTLE_MS);
      const fresh = readPageRange(startMs, endMs);
      if (fresh) coverage = fresh;
    }
    return { coverage, panned, attempts };
  }

  /** Read the hovered-time readout (time-axis highlight) during a sweep.
   *  Best-effort across builds: exact-selector match first, then any small
   *  element whose text contains a date/time pattern. Time-only labels
   *  ("14:35") resolve against today. Null when the axis renders on canvas. */
  function readHoverTime() {
    const sels = [
      '[data-name="time-axis-highlight"]',
      '[class*="timeAxisHighlight"]',
      '.chart-container [class*="highlight"]',
      '[class*="timeAxis"]',
      '[class*="TimeScale"]',
      '[class*="time-scale"]',
    ];
    const datePat = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}([ T]\d{1,2}:\d{2}(:\d{2})?)?|\b[A-Z][a-z]{2} \d{1,2}(, \d{2,4})?(\s+\d{1,2}:\d{2})?|\b\d{1,2}:\d{2}(:\d{2})?)/;
    for (const s of sels) {
      try {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          const t = text(el);
          if (!t || t.length > 60) continue;
          if (/[OHLC]\s*[−\-+]?[0-9]/i.test(t)) continue; // that's legend, not time
          // Whole-text fast path (ISO / locale strings Date.parse handles).
          let parsed = Date.parse(t);
          if (!Number.isNaN(parsed)) return parsed;
          // Pattern path: extract a date/time fragment from a longer label.
          const m = t.match(datePat);
          if (m) {
            let frag = m[0];
            if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(frag)) {
              frag = `${new Date().toISOString().slice(0, 10)} ${frag}`; // today
            }
            parsed = Date.parse(frag);
            if (!Number.isNaN(parsed)) return parsed;
          }
        }
      } catch { /* next selector */ }
    }
    return null;
  }

  /** Time-axis tick labels rendered in the DOM. Only full date(+time) labels
   *  are used, so a "14:35" fragment never gets a wrong date attached.
   *  Returns [{ x, epochMs }] sorted by x; empty when the axis is on canvas. */
  function readTimeAxisTicks() {
    const scopes = [];
    for (const s of [
      '[data-name="time-axis"]', '[class*="timeAxis"]', '[class*="time-axis"]',
      '[data-name="chart-time-axis"]', '.chart-markup-table',
    ]) {
      try { document.querySelectorAll(s).forEach((el) => scopes.push(el)); } catch { /* skip */ }
      if (scopes.length) break;
    }
    const out = [];
    const seen = new Set();
    const pat = /\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|[A-Z][a-z]{2} \d{1,2},? \d{4}/;
    for (const scope of scopes) {
      let leaves;
      try { leaves = scope.querySelectorAll('*'); } catch { continue; }
      for (const el of leaves) {
        try {
          if (el.children && el.children.length) continue; // leaf text only
          const t = text(el);
          if (!t || t.length > 40 || !pat.test(t)) continue;
          if (/[OHLC]\s*[−\-+]?[0-9]/i.test(t)) continue; // legend leak
          const parsed = Date.parse(t);
          if (Number.isNaN(parsed)) continue;
          const r = el.getBoundingClientRect();
          if (!r || !r.width) continue;
          const x = r.left + r.width / 2;
          const key = `${x}|${parsed}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ x, epochMs: parsed });
        } catch { /* skip */ }
      }
    }
    out.sort((a, b) => a.x - b.x);
    return out;
  }

  /** Pixel x -> timestamp by linear interpolation between known axis ticks. */
  function interpolateTime(x, ticks) {
    if (!ticks || ticks.length < 2 || x == null) return null;
    if (x <= ticks[0].x) return ticks[0].epochMs;
    const last = ticks[ticks.length - 1];
    if (x >= last.x) return last.epochMs;
    for (let i = 1; i < ticks.length; i++) {
      if (x <= ticks[i].x) {
        const a = ticks[i - 1];
        const b = ticks[i];
        const span = b.x - a.x;
        if (span <= 0) return b.epochMs;
        return a.epochMs + Math.round(((b.epochMs - a.epochMs) * (x - a.x)) / span);
      }
    }
    return null;
  }

  /**
   * Guarantee every swept row carries a timestamp, in strict trust tiers:
   *   1. hover time read from the DOM (exact)
   *   2. interpolation between full-date axis ticks (exact)
   *   3. linear fill between known neighbours (interpolated)
   *   4. newest row anchored at the current timeframe bucket, stepped back
   *      by tfMs (ESTIMATED — flagged so the popup can warn loudly)
   * Returns { estimated, interpolated, known }.
   */
  function finalizeSweepTimes(rows, tfMs, ticks) {
    if (!rows.length) return { estimated: false, interpolated: 0, known: 0 };
    const knownBefore = rows.filter((r) => r.epochMs != null).length;

    // Tier 2 — axis interpolation for rows whose x is known but time is not.
    if (ticks && ticks.length >= 2) {
      for (const r of rows) {
        if (r.epochMs == null && r.x != null) {
          const t = interpolateTime(r.x, ticks);
          if (t != null) r.epochMs = t;
        }
      }
    }

    // Tier 3 — fill gaps between/around known rows using sweep order
    // (sweep x ascends left->right, which is oldest->newest on TradingView).
    if (tfMs && rows.some((r) => r.epochMs == null)) {
      let last = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].epochMs == null) continue;
        if (last >= 0) {
          const span = i - last;
          const dt = rows[i].epochMs - rows[last].epochMs;
          for (let k = last + 1; k < i; k++) {
            rows[k].epochMs = rows[last].epochMs + Math.round((dt * (k - last)) / span);
          }
        }
        last = i;
      }
      if (last >= 0) {
        for (let k = last - 1; k >= 0; k--) rows[k].epochMs = rows[k + 1].epochMs - tfMs;
        for (let k = last + 1; k < rows.length; k++) rows[k].epochMs = rows[k - 1].epochMs + tfMs;
      }
    }

    // Tier 4 — nothing readable: anchor at the live bucket and step back.
    if (tfMs && rows.some((r) => r.epochMs == null)) {
      const anchor = Math.floor(Date.now() / tfMs) * tfMs;
      const n = rows.length;
      rows.forEach((r, i) => {
        if (r.epochMs == null) r.epochMs = anchor - (n - 1 - i) * tfMs;
      });
    }

    const known = rows.filter((r) => r.epochMs != null).length;
    if (known) rows.sort((a, b) => a.epochMs - b.epochMs);
    return {
      estimated: knownBefore === 0 && known > 0,
      interpolated: known - knownBefore,
      known,
    };
  }

  /**
   * Keyboard bar-walk: TradingView advances the crosshair one bar per ArrowLeft
   * while the chart has focus. Collects one reading per bar press — NO OHLC-based
   * deduplication (two different bars can have identical OHLC but different
   * indicator values). Uses timestamp-based dedup: if the hovered bar time does
   * not advance after a key press, we stop (TV has no more bars to the left).
   * maxSteps: cap to avoid infinite loops (default: covers large visible ranges).
   */
  async function sweepByKeyboard(hintEl, maxSteps = 1500) {
    const rows = [];
    const seenMs = new Set();
    // TV only tracks arrow keys while the chart owns DOM focus.
    const focus = (() => {
      for (const s of ['[data-name="chart-container"] .chart-container', '.chart-container',
        '#tv_chart_container', '.tv-chart-container', 'canvas']) {
        try {
          const el = document.querySelector(s);
          if (el) return el;
        } catch { /* next */ }
      }
      return document.body;
    })();
    try {
      if (focus && focus.tabIndex < 0) focus.setAttribute('tabindex', '-1');
      focus?.focus?.({ preventScroll: true });
    } catch { /* not focusable — dispatch still bubbles */ }
    const press = (key, code, kc) => {
      try {
        const ev = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
        try {
          Object.defineProperty(ev, 'keyCode', { get: () => kc });
          Object.defineProperty(ev, 'which', { get: () => kc });
        } catch { /* legacy fields not settable — handlers usually use `key` */ }
        (focus ?? document).dispatchEvent(ev);
        return true;
      } catch { return false; }
    };
    // Move to the rightmost (newest) visible bar first.
    try { press('ArrowRight', 'ArrowRight', 39); } catch { /* ignore */ }
    await sleep(150);
    let consecutiveNoAdvance = 0;
    let lastOhlcKey = '';
    let sameOhlcCount = 0;
    for (let i = 0; i < maxSteps; i++) {
      try {
        press('ArrowLeft', 'ArrowLeft', 37);
        await sleep(40); // give the legend DOM a moment to update
        const seriesEl = (hintEl && hintEl.isConnected !== false ? hintEl : null)
          ?? queryFirst(SELECTORS.seriesItem) ?? findSeriesByOHLCText();
        if (!seriesEl) continue;
        const ohlc = parseOHLCRow(seriesEl);
        if ([ohlc.open, ohlc.high, ohlc.low, ohlc.close].every((v) => v == null)) continue;
        const ts = readHoverTime();
        // Timestamp-based dedup: don't add the same bar twice, but DO collect
        // bars with the same OHLC if they have different timestamps.
        if (ts != null) {
          if (seenMs.has(ts)) {
            // Legend didn't advance — TV may be at the leftmost bar.
            consecutiveNoAdvance++;
            if (consecutiveNoAdvance >= 5) break; // stuck at start of history
            continue;
          }
          seenMs.add(ts);
          consecutiveNoAdvance = 0;
          sameOhlcCount = 0;
          lastOhlcKey = '';
        } else {
          // No readable timestamp: detect stuck state via OHLC fingerprint.
          const ohlcKey = `${ohlc.open}|${ohlc.high}|${ohlc.low}|${ohlc.close}`;
          if (ohlcKey === lastOhlcKey) {
            sameOhlcCount++;
            if (sameOhlcCount >= 5) break; // stuck at leftmost bar
            continue; // skip duplicate (same bar)
          }
          lastOhlcKey = ohlcKey;
          sameOhlcCount = 0;
        }
        const indicators = parseIndicators(seriesEl);
        rows.push({ x: null, epochMs: ts, ...ohlc, indicators });
        if (i % 100 === 0 && i > 0) emitProgress('sweep', `Keyboard sweep: ${rows.length} bars read…`);
      } catch { /* one bad step must not kill the walk */ }
    }
    // rows are newest→oldest; reverse to oldest→newest
    rows.reverse();
    return rows;
  }

  /**
   * Fallback collector: sweep synthetic hovers across the visible chart and
   * read the legend per position. Indicator readouts ARE valid per hovered
   * bar. Returns { rows, warnings, indicatorCols, diagnostics } — diagnostics
   * always say WHICH gate failed, so "no rows" is never a mystery again.
   */
  async function sweepLegendRange(seriesElHint, tfMs) {
    const diagnostics = {
      method: 'pointer-sweep',
      sweepSteps: FETCH_SWEEP_STEPS,
      dispatchOk: 0,
      seriesFoundSteps: 0,
      ohlcReadSteps: 0,
      distinctCandles: 0,
      hoverTimesFound: 0,
      hoverTargets: [],
      legendChangedSteps: 0,
    };
    const rows = [];
    const warnings = [];
    const indicatorCols = new Set();
    const seen = new Set();

    // ---- Gate 1: a canvas we can actually hover ----------------------------
    const candidates = listCanvasCandidates();
    const canvas = candidates[0] ?? findChartCanvas();
    if (!canvas) {
      diagnostics.canvas = { found: false };
      return { rows, warnings, diagnostics, indicatorCols: [] };
    }
    let rect = null;
    try { rect = canvas.getBoundingClientRect(); } catch { rect = null; }
    const cw = Math.round(rect?.width ?? 0);
    const ch = Math.round(rect?.height ?? 0);
    diagnostics.canvas = {
      found: true,
      tag: canvas.tagName,
      layoutWidth: cw,
      layoutHeight: ch,
      attrWidth: canvas.width ?? 0,
      attrHeight: canvas.height ?? 0,
      label: labelCanvas(canvas),
    };
    diagnostics.canvasCandidates = candidates.length;
    diagnostics.canvasLabels = candidates.slice(0, 4).map(labelCanvas);
    if (!rect || cw < 50 || ch < 30) {
      return { rows, warnings, diagnostics, indicatorCols: [] };
    }

    // Give the chart DOM focus, then find which canvas actually moves the
    // legend. On a 15-canvas build the biggest surface is not always the one
    // that owns the crosshair.
    primeCrosshair(canvas, rect);
    await sleep(40);
    const probe = await probeResponsiveCanvas(candidates, seriesElHint);
    diagnostics.canvasProbe = probe.tried;
    diagnostics.responsiveCanvas = probe.responsive ? labelCanvas(probe.canvas) : null;
    const activeCanvas = probe.canvas ?? canvas;
    let activeRect = rect;
    try { activeRect = activeCanvas.getBoundingClientRect() ?? rect; } catch { activeRect = rect; }

    const ticks = readTimeAxisTicks();
    diagnostics.axisTicks = ticks.length;
    const targets = new Set();
    let lastSeriesText = '';
    let prevSeriesText = '';

    // ---- Gate 2: pointer sweep --------------------------------------------
    // NOTE: We do NOT deduplicate by OHLC here. Two consecutive bars can have
    // identical OHLC (e.g. doji candles) but different indicator values.
    // We deduplicate by timestamp instead — same bar time = same bar.
    for (let i = 0; i < FETCH_SWEEP_STEPS; i++) {
      try {
        const x = activeRect.left + (activeRect.width * (i + 0.5)) / FETCH_SWEEP_STEPS;
        const y = activeRect.top + activeRect.height * 0.4;
        const hits = collectHoverTargets(activeCanvas, x, y);
        hits.forEach((t) => {
          targets.add(t.tagName.toLowerCase() + (t.id ? `#${t.id}` : '')
            + (typeof t.className === 'string' && t.className.trim()
              ? `.${t.className.trim().split(/\s+/)[0]}` : ''));
        });
        if (dispatchHoverAt(hits, x, y, i === 0)) diagnostics.dispatchOk++;
        await sleep(30); // let the legend DOM catch up with the synthetic hover
        const seriesEl = (seriesElHint && seriesElHint.isConnected !== false ? seriesElHint : null)
          ?? queryFirst(SELECTORS.seriesItem) ?? findSeriesByOHLCText();
        if (!seriesEl) continue;
        diagnostics.seriesFoundSteps++;
        const curText = text(seriesEl);
        // The single most important signal: did the legend text change at all?
        if (prevSeriesText && curText && curText !== prevSeriesText) diagnostics.legendChangedSteps++;
        prevSeriesText = curText || prevSeriesText;
        lastSeriesText = curText.slice(0, 160);
        const ohlc = parseOHLCRow(seriesEl);
        if ([ohlc.open, ohlc.high, ohlc.low, ohlc.close].every((v) => v == null)) continue;
        diagnostics.ohlcReadSteps++;
        const indicators = parseIndicators(seriesEl);
        Object.keys(indicators).forEach((k) => indicatorCols.add(k));
        // Deduplicate by timestamp (not OHLC): two bars can share OHLC but
        // have different indicator values on different timestamps.
        const ts = readHoverTime();
        const dedupeKey = ts != null ? String(ts) : `${ohlc.open}|${ohlc.high}|${ohlc.low}|${ohlc.close}|${curText}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        rows.push({ x, epochMs: ts, ...ohlc, indicators });
        if (i % 50 === 0 && i > 0) emitProgress('sweep', `Sweeping candles… ${rows.length} read`);
      } catch { /* one bad step must not kill the sweep */ }
    }
    diagnostics.hoverTargets = [...targets].slice(0, 8);
    diagnostics.distinctCandles = rows.length;
    diagnostics.lastSeriesText = lastSeriesText;

    // Gate 2.5: If the legend never changed across the entire sweep, pointer events
    // had zero effect on TradingView (synthetic events ignored). Reduce to 1 candle so
    // we don't treat 500 identical snapshots of the last candle as a valid sweep.
    if (diagnostics.legendChangedSteps === 0 && rows.length > 1) {
      rows.length = 1;
      diagnostics.distinctCandles = 1;
    }

    // ---- Gate 3: keyboard fallback when hovers move nothing ---------------
    if (rows.length <= 1) {
      const kb = await sweepByKeyboard(seriesElHint, 1500);
      if (kb.length > rows.length) {
        rows.length = 0;
        kb.forEach((r) => rows.push(r));
        diagnostics.method = 'keyboard-sweep';
        rows.forEach((r) => Object.keys(r.indicators ?? {}).forEach((k) => indicatorCols.add(k)));
      } else {
        diagnostics.keyboardFallbackRows = kb.length;
      }
    }
    diagnostics.distinctCandles = rows.length;

    // ---- Gate 4: timestamps -------------------------------------------------
    const timing = finalizeSweepTimes(rows, tfMs, ticks);
    diagnostics.timestampsEstimated = timing.estimated;
    diagnostics.timestampsInterpolated = timing.interpolated;
    diagnostics.hoverTimesFound = rows.filter((r) => r.epochMs != null).length;

    if (rows.some((r) => r.epochMs == null)) {
      warnings.push('Some rows have no readable timestamp and the timeframe is unknown, ' +
        'so those Datetime cells are empty.');
    } else if (timing.estimated) {
      warnings.push('TIMESTAMPS_ESTIMATED: no hover/date labels were readable, so timestamps were ' +
        'reconstructed from sweep position and the current timeframe, anchored on the latest bar. ' +
        'Session gaps are NOT modelled — verify the Datetime column before trusting it.');
    } else if (timing.interpolated > 0) {
      warnings.push(`${timing.interpolated} timestamp(s) were interpolated between readable anchors.`);
    }
    if (!rows.length) {
      warnings.push('Sweep found no readable legend values — the chart may still be loading.');
    }
    return { rows, warnings, diagnostics, indicatorCols: [...indicatorCols] };
  }

  /** Map sweep diagnostics to a precise error code (never a mystery string). */
  function sweepErrorCode(d) {
    if (!d) return 'MODEL_UNREACHABLE';
    if (!d.canvas?.found) return 'CHART_CANVAS_MISSING';
    if ((d.canvas?.layoutWidth ?? 0) < 50 || (d.canvas?.layoutHeight ?? 0) < 30) return 'CANVAS_NO_LAYOUT';
    if (!d.dispatchOk) return 'HOVER_DISPATCH_FAILED';
    if (!d.seriesFoundSteps) return 'LEGEND_ROW_NOT_FOUND';
    if (!d.ohlcReadSteps) return 'LEGEND_OHLC_EMPTY';
    return 'HOVER_NOT_MOVING';
  }

  function sweepErrorMessage(d) {
    switch (sweepErrorCode(d)) {
      case 'CHART_CANVAS_MISSING':
        return 'No chart canvas was found in this frame. Wait for the chart to render, or reload the tab.';
      case 'CANVAS_NO_LAYOUT':
        return `The chart canvas has no usable size (${d?.canvas?.layoutWidth ?? 0}×${d?.canvas?.layoutHeight ?? 0} px). ` +
               'The chart may be collapsed — expand the chart pane and retry.';
      case 'HOVER_DISPATCH_FAILED':
        return 'Synthetic hover events could not be dispatched (PointerEvent/MouseEvent blocked). ' +
               'Reload the tab and retry.';
      case 'LEGEND_ROW_NOT_FOUND':
        return 'The legend row could not be located while sweeping — the legend may be hidden. ' +
               'Show the chart legend (click the symbol title) and retry.';
      case 'LEGEND_OHLC_EMPTY':
        return 'The legend was found but never showed O/H/L/C values while sweeping — the crosshair ' +
               'did not land on any candle. Zoom out so candles fill the chart, then retry.';
      case 'HOVER_NOT_MOVING':
        return 'Only 1 distinct candle was read across the whole sweep and the legend text never ' +
          'changed, so this build is ignoring synthetic pointer/keyboard events (TV skips events ' +
          'with isTrusted=false). Zoom the chart so more candles fill the pane, move your real mouse ' +
          'across it once to prove the legend updates, then click Fetch again — if the legend still ' +
          'never changes, this chart build cannot be swept and range export needs another data path.';
      default:
        return 'Could not read the chart data model or the legend sweep on this build. ' +
               'Reload the chart (candles fully rendered) and retry.';
    }
  }

  // ---------------------------------------------------------------------------
  // Technical Indicators Calculation Engine
  // Computes per-bar historical values for standard indicators (RSI, EMA, SMA,
  // MACD, Bollinger Bands, ATR, Supertrend, Stochastic, Volume MA, etc.)
  // when the chart model does not expose study points or when datafeed capture
  // is used. Guarantees that every CSV row has full, continuous indicator data.
  // ---------------------------------------------------------------------------

  function roundDecimals(val, decimals = 2) {
    if (val == null || !Number.isFinite(val)) return null;
    const factor = 10 ** decimals;
    return Math.round(val * factor) / factor;
  }

  function inferDecimals(val, fallback = 2) {
    if (typeof val === 'number') {
      const s = String(val);
      const dot = s.indexOf('.');
      if (dot !== -1) return Math.min(s.length - dot - 1, 6);
    }
    return fallback;
  }

  function getBarSource(b, src = 'close') {
    if (!b) return 0;
    const s = String(src).toLowerCase();
    if (s === 'open') return b.open ?? b.close ?? 0;
    if (s === 'high') return b.high ?? b.close ?? 0;
    if (s === 'low') return b.low ?? b.close ?? 0;
    if (s === 'hl2') return ((b.high ?? b.close ?? 0) + (b.low ?? b.close ?? 0)) / 2;
    if (s === 'hlc3') return ((b.high ?? b.close ?? 0) + (b.low ?? b.close ?? 0) + (b.close ?? 0)) / 3;
    if (s === 'ohlc4') return ((b.open ?? b.close ?? 0) + (b.high ?? b.close ?? 0) + (b.low ?? b.close ?? 0) + (b.close ?? 0)) / 4;
    return b.close ?? 0;
  }

  function calcRSI(bars, period = 14, src = 'close') {
    if (!bars || bars.length < period) return new Array(bars?.length ?? 0).fill(null);
    const out = new Array(bars.length).fill(null);
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period && i < bars.length; i++) {
      const change = getBarSource(bars[i], src) - getBarSource(bars[i - 1], src);
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    if (bars.length > period) {
      out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
      for (let i = period + 1; i < bars.length; i++) {
        const change = getBarSource(bars[i], src) - getBarSource(bars[i - 1], src);
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
      }
    }
    return out;
  }

  function calcEMA(bars, period = 20, src = 'close') {
    if (!bars || bars.length < period) return new Array(bars?.length ?? 0).fill(null);
    const out = new Array(bars.length).fill(null);
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += getBarSource(bars[i], src);
    let ema = sum / period;
    out[period - 1] = ema;
    for (let i = period; i < bars.length; i++) {
      ema = (getBarSource(bars[i], src) - ema) * k + ema;
      out[i] = ema;
    }
    return out;
  }

  function calcSMA(bars, period = 20, src = 'close') {
    if (!bars || bars.length < period) return new Array(bars?.length ?? 0).fill(null);
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += getBarSource(bars[i], src);
      if (i >= period) sum -= getBarSource(bars[i - period], src);
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function calcWMA(bars, period = 20, src = 'close') {
    if (!bars || bars.length < period) return new Array(bars?.length ?? 0).fill(null);
    const out = new Array(bars.length).fill(null);
    const weightSum = (period * (period + 1)) / 2;
    for (let i = period - 1; i < bars.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += getBarSource(bars[i - j], src) * (period - j);
      }
      out[i] = sum / weightSum;
    }
    return out;
  }

  function calcEMARaw(values, period) {
    if (!values || values.length < period) return new Array(values?.length ?? 0).fill(null);
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let sum = 0;
    let count = 0;
    let startIdx = -1;
    for (let i = 0; i < values.length; i++) {
      if (values[i] == null) continue;
      sum += values[i];
      count++;
      if (count === period) {
        let ema = sum / period;
        out[i] = ema;
        startIdx = i;
        break;
      }
    }
    if (startIdx !== -1) {
      let ema = out[startIdx];
      for (let i = startIdx + 1; i < values.length; i++) {
        if (values[i] != null) {
          ema = (values[i] - ema) * k + ema;
          out[i] = ema;
        }
      }
    }
    return out;
  }

  function calcMACD(bars, fast = 12, slow = 26, signal = 9, src = 'close') {
    const prices = (bars ?? []).map((b) => getBarSource(b, src));
    const fastEMA = calcEMARaw(prices, fast);
    const slowEMA = calcEMARaw(prices, slow);
    const macdLine = new Array(prices.length).fill(null);
    for (let i = 0; i < prices.length; i++) {
      if (fastEMA[i] != null && slowEMA[i] != null) {
        macdLine[i] = fastEMA[i] - slowEMA[i];
      }
    }
    const validStart = macdLine.findIndex((v) => v != null);
    const signalLine = new Array(prices.length).fill(null);
    const hist = new Array(prices.length).fill(null);
    if (validStart !== -1 && prices.length - validStart >= signal) {
      const macdSlice = macdLine.slice(validStart);
      const sigSlice = calcEMARaw(macdSlice, signal);
      for (let i = 0; i < sigSlice.length; i++) {
        const idx = validStart + i;
        signalLine[idx] = sigSlice[i];
        if (macdLine[idx] != null && signalLine[idx] != null) {
          hist[idx] = macdLine[idx] - signalLine[idx];
        }
      }
    }
    return { macd: macdLine, signal: signalLine, histogram: hist };
  }

  function calcBB(bars, period = 20, mult = 2, src = 'close') {
    const basis = new Array((bars ?? []).length).fill(null);
    const upper = new Array((bars ?? []).length).fill(null);
    const lower = new Array((bars ?? []).length).fill(null);
    if (!bars || bars.length < period) return { basis, upper, lower };
    for (let i = period - 1; i < bars.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += getBarSource(bars[i - j], src);
      const mean = sum / period;
      let varSum = 0;
      for (let j = 0; j < period; j++) {
        const diff = getBarSource(bars[i - j], src) - mean;
        varSum += diff * diff;
      }
      const stdDev = Math.sqrt(varSum / period);
      basis[i] = mean;
      upper[i] = mean + mult * stdDev;
      lower[i] = mean - mult * stdDev;
    }
    return { basis, upper, lower };
  }

  function calcATR(bars, period = 14) {
    if (!bars || bars.length < period) return new Array(bars?.length ?? 0).fill(null);
    const tr = new Array(bars.length).fill(null);
    tr[0] = (bars[0].high ?? bars[0].close ?? 0) - (bars[0].low ?? bars[0].close ?? 0);
    for (let i = 1; i < bars.length; i++) {
      const h = bars[i].high ?? bars[i].close ?? 0;
      const l = bars[i].low ?? bars[i].close ?? 0;
      const prevC = bars[i - 1].close ?? 0;
      tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    }
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += tr[i] ?? 0;
    let rma = sum / period;
    out[period - 1] = rma;
    for (let i = period; i < bars.length; i++) {
      rma = (rma * (period - 1) + (tr[i] ?? 0)) / period;
      out[i] = rma;
    }
    return out;
  }

  function calcSupertrend(bars, period = 10, factor = 3) {
    if (!bars || bars.length < period) return new Array(bars?.length ?? 0).fill(null);
    const atr = calcATR(bars, period);
    const st = new Array(bars.length).fill(null);
    let prevUpper = 0;
    let prevLower = 0;
    let prevTrend = 1;
    for (let i = 0; i < bars.length; i++) {
      if (atr[i] == null) continue;
      const h = bars[i].high ?? bars[i].close ?? 0;
      const l = bars[i].low ?? bars[i].close ?? 0;
      const c = bars[i].close ?? 0;
      const hl2 = (h + l) / 2;
      let upper = hl2 + factor * atr[i];
      let lower = hl2 - factor * atr[i];
      const prevClose = i > 0 ? (bars[i - 1].close ?? c) : c;
      if (lower > prevLower || prevClose < prevLower) { /* keep lower */ }
      else lower = prevLower;
      if (upper < prevUpper || prevClose > prevUpper) { /* keep upper */ }
      else upper = prevUpper;
      let trend = prevTrend;
      if (trend === 1 && c < lower) trend = -1;
      else if (trend === -1 && c > upper) trend = 1;
      st[i] = trend === 1 ? lower : upper;
      prevUpper = upper;
      prevLower = lower;
      prevTrend = trend;
    }
    return st;
  }

  function calcStochastic(bars, kPeriod = 14, kSmooth = 1, dPeriod = 3) {
    const rawK = new Array((bars ?? []).length).fill(null);
    if (!bars || bars.length < kPeriod) return { k: rawK, d: [...rawK] };
    for (let i = kPeriod - 1; i < bars.length; i++) {
      let highest = -Infinity;
      let lowest = Infinity;
      for (let j = 0; j < kPeriod; j++) {
        const b = bars[i - j];
        const h = b.high ?? b.close ?? 0;
        const l = b.low ?? b.close ?? 0;
        if (h > highest) highest = h;
        if (l < lowest) lowest = l;
      }
      const diff = highest - lowest;
      rawK[i] = diff === 0 ? 50 : (((bars[i].close ?? 0) - lowest) / diff) * 100;
    }
    const smoothK = kSmooth > 1 ? calcEMARaw(rawK, kSmooth) : rawK;
    const smoothD = calcEMARaw(smoothK, dPeriod);
    return { k: smoothK, d: smoothD };
  }

  function parseIndicatorCol(colName) {
    const s = String(colName).trim();
    let plot = null;
    let base = s;
    if (s.includes('[')) {
      const idx = s.indexOf('[');
      base = s.slice(0, idx).trim();
      plot = s.slice(idx + 1).replace(/\]$/, '').trim();
    } else if (s.includes('›')) {
      const parts = s.split('›');
      base = parts[0].trim();
      plot = parts[1].trim();
    }

    const parenMatch = base.match(/\(([^)]+)\)/);
    const nums = [];
    let src = 'close';
    if (parenMatch) {
      const parts = parenMatch[1].split(',').map((p) => p.trim());
      for (const p of parts) {
        const n = Number(p);
        if (Number.isFinite(n)) nums.push(n);
        else if (/^(close|open|high|low|hl2|hlc3|ohlc4)$/i.test(p)) src = p.toLowerCase();
      }
    } else {
      const trailingNum = base.match(/\b(\d+)\b/);
      if (trailingNum) nums.push(Number(trailingNum[1]));
    }

    const lowerBase = base.toLowerCase();
    if (/rsi|relative strength/i.test(lowerBase)) {
      return { type: 'rsi', period: nums[0] || 14, src, plot };
    }
    if (/macd/i.test(lowerBase)) {
      return { type: 'macd', fast: nums[0] || 12, slow: nums[1] || 26, signal: nums[2] || 9, src, plot: plot || 'MACD' };
    }
    if (/bollinger|bb\b/i.test(lowerBase)) {
      return { type: 'bb', period: nums[0] || 20, mult: nums[1] || 2, src, plot: plot || 'Basis' };
    }
    if (/supertrend/i.test(lowerBase)) {
      return { type: 'supertrend', period: nums[0] || 10, factor: nums[1] || 3, plot };
    }
    if (/stoch/i.test(lowerBase)) {
      return { type: 'stoch', kPeriod: nums[0] || 14, kSmooth: nums[1] || 1, dPeriod: nums[2] || 3, plot: plot || '%K' };
    }
    if (/^atr\b|average true range/i.test(lowerBase)) {
      return { type: 'atr', period: nums[0] || 14, plot };
    }
    if (/^ema\b|exponential moving/i.test(lowerBase)) {
      return { type: 'ema', period: nums[0] || 20, src, plot };
    }
    if (/^wma\b|weighted moving/i.test(lowerBase)) {
      return { type: 'wma', period: nums[0] || 20, src, plot };
    }
    if (/^sma\b|moving average\b|\bma\b/i.test(lowerBase) && !/volume/i.test(lowerBase)) {
      return { type: 'sma', period: nums[0] || 20, src, plot };
    }
    if (/volume ma\b|vol.*ma\b/i.test(lowerBase) || (/vol/i.test(lowerBase) && (plot === '1' || plot === 'Volume MA'))) {
      return { type: 'volume_ma', period: nums[0] || 20, plot };
    }
    if (/^vol\b|^volume\b/i.test(lowerBase) && (plot == null || plot === '0' || plot === 'Volume')) {
      return { type: 'volume', plot };
    }
    return null;
  }

  function computeSeriesForCol(colName, bars, liveVal) {
    const parsed = parseIndicatorCol(colName);
    if (!parsed || !bars || !bars.length) return null;
    const dec = inferDecimals(liveVal, 2);

    switch (parsed.type) {
      case 'rsi': {
        const raw = calcRSI(bars, parsed.period, parsed.src);
        return raw.map((v) => roundDecimals(v, dec));
      }
      case 'ema': {
        const raw = calcEMA(bars, parsed.period, parsed.src);
        return raw.map((v) => roundDecimals(v, dec));
      }
      case 'sma': {
        const raw = calcSMA(bars, parsed.period, parsed.src);
        return raw.map((v) => roundDecimals(v, dec));
      }
      case 'wma': {
        const raw = calcWMA(bars, parsed.period, parsed.src);
        return raw.map((v) => roundDecimals(v, dec));
      }
      case 'macd': {
        const res = calcMACD(bars, parsed.fast, parsed.slow, parsed.signal, parsed.src);
        const pLower = String(parsed.plot ?? '').toLowerCase();
        let target = res.macd;
        if (/signal/i.test(pLower)) target = res.signal;
        else if (/hist/i.test(pLower)) target = res.histogram;
        return target.map((v) => roundDecimals(v, dec));
      }
      case 'bb': {
        const res = calcBB(bars, parsed.period, parsed.mult, parsed.src);
        const pLower = String(parsed.plot ?? '').toLowerCase();
        let target = res.basis;
        if (/upper/i.test(pLower)) target = res.upper;
        else if (/lower/i.test(pLower)) target = res.lower;
        return target.map((v) => roundDecimals(v, dec));
      }
      case 'atr': {
        const raw = calcATR(bars, parsed.period);
        return raw.map((v) => roundDecimals(v, dec));
      }
      case 'supertrend': {
        const raw = calcSupertrend(bars, parsed.period, parsed.factor);
        return raw.map((v) => roundDecimals(v, dec));
      }
      case 'stoch': {
        const res = calcStochastic(bars, parsed.kPeriod, parsed.kSmooth, parsed.dPeriod);
        const pLower = String(parsed.plot ?? '').toLowerCase();
        const target = /d/i.test(pLower) ? res.d : res.k;
        return target.map((v) => roundDecimals(v, dec));
      }
      case 'volume_ma': {
        const raw = calcSMA(bars, parsed.period, 'volume');
        return raw.map((v) => roundDecimals(v, 0));
      }
      case 'volume': {
        return bars.map((b) => (b.volume != null ? roundDecimals(b.volume, 0) : null));
      }
      default:
        return null;
    }
  }

  /**
   * Merge indicator values from a sweep (keyboard or pointer) into model bars.
   *
   * Strategy (in priority order):
   *   1. Exact timestamp match   — swept row has same epochMs as model bar
   *   2. Near-timestamp match    — swept row within ±½ bar of model bar
   *   3. Unique OHLC fingerprint — OHLC is globally unique in swept set
   *   4. Positional tail align   — keyboard sweep reads newest→oldest (reversed
   *      to oldest→newest). The visible chart shows the tail of the model bars.
   *      We align swept[0..M-1] to bars[N-M..N-1] using a two-pointer OHLC walk.
   *      This is the primary path when readHoverTime() returns null (canvas axis).
   */
  function mergeSweptIndicators(bars, sweptRows, indicatorCols, tfMs) {
    if (!bars || !bars.length || !sweptRows || !sweptRows.length) return;
    if (!indicatorCols || !indicatorCols.length) return;

    const applyInds = (bar, inds) => {
      if (!inds) return false;
      let applied = false;
      for (const col of indicatorCols) {
        const val = inds[col]
          ?? inds[col.replace(' [', ' › ').replace(']', '')]
          ?? inds[col.replace(' › ', ' [') + ']'];
        if (val != null) { bar[col] = val; applied = true; }
      }
      return applied;
    };

    // Only keep swept rows that have at least one indicator value.
    const validSwept = sweptRows.filter(
      (s) => s.indicators && Object.keys(s.indicators).length > 0
    );
    if (!validSwept.length) return;

    // Verify that swept rows actually moved and show variation across bars.
    // If all swept rows have identical indicator values, the legend was frozen on
    // a single candle. Merging frozen readings into historical bars would corrupt history.
    let hasVariation = false;
    if (validSwept.length > 1) {
      const firstInds = validSwept[0].indicators || {};
      for (let i = 1; i < validSwept.length; i++) {
        const curInds = validSwept[i].indicators || {};
        for (const col of indicatorCols) {
          const v1 = firstInds[col];
          const v2 = curInds[col];
          if (v1 != null && v2 != null && v1 !== v2) {
            hasVariation = true;
            break;
          }
        }
        if (hasVariation) break;
      }
    }
    if (validSwept.length > 1 && !hasVariation) return;

    // --- Strategy 1 & 2: Timestamp-based matching ---
    // Build a sorted array of swept rows that have timestamps.
    const timedSwept = validSwept
      .filter((s) => s.epochMs != null)
      .sort((a, b) => a.epochMs - b.epochMs);

    const tol = tfMs ? Math.round(tfMs * 0.6) : 0;

    if (timedSwept.length > 0) {
      // Fast binary search: find the swept row nearest to a given epochMs.
      const bsNearest = (ms) => {
        let lo = 0, hi = timedSwept.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (timedSwept[mid].epochMs < ms) lo = mid + 1;
          else hi = mid;
        }
        const a = timedSwept[lo];
        const b2 = lo > 0 ? timedSwept[lo - 1] : null;
        return (!b2 || Math.abs(a.epochMs - ms) <= Math.abs(b2.epochMs - ms)) ? a : b2;
      };

      for (const bar of bars) {
        if (bar.epochMs == null) continue;
        const near = bsNearest(bar.epochMs);
        if (near && Math.abs(near.epochMs - bar.epochMs) <= Math.max(tol, 1000)) {
          applyInds(bar, near.indicators);
        }
      }

      // If most bars got values from timestamp matching, we're done.
      const filled = bars.filter((b) => indicatorCols.some((c) => b[c] != null)).length;
      if (filled >= bars.length * 0.8) return;
    }

    // --- Strategy 3: Unique OHLC fingerprint ---
    // Build OHLC → indicators map; only use entries whose OHLC is unique.
    const ohlcCount = new Map();
    const ohlcInds = new Map();
    for (const s of validSwept) {
      const k = `${s.open}|${s.high}|${s.low}|${s.close}`;
      ohlcCount.set(k, (ohlcCount.get(k) ?? 0) + 1);
      ohlcInds.set(k, s.indicators);
    }
    for (const bar of bars) {
      if (indicatorCols.every((c) => bar[c] != null)) continue; // already filled
      const k = `${bar.open}|${bar.high}|${bar.low}|${bar.close}`;
      if (ohlcInds.has(k) && ohlcCount.get(k) === 1) {
        applyInds(bar, ohlcInds.get(k));
      }
    }

    // --- Strategy 4: Positional tail alignment ---
    // Keyboard sweep reads the VISIBLE chart bars (newest→oldest, reversed to
    // oldest→newest). The model bars are oldest→newest. The visible chart
    // typically shows a contiguous section of the model. Align them by finding
    // a common anchor bar (by OHLC match) then walking outward from it.
    const N = bars.length;
    const M = validSwept.length;
    if (M < 2) return; // too few swept rows to do positional alignment safely

    // Tolerance for OHLC closeness: 0.1% of close price (handles display rounding).
    const ohlcClose = (b, s) => {
      const thr = Math.abs(b.close ?? 0) * 0.002 + 0.5; // 0.2% + 0.5 absolute
      return Math.abs((b.open ?? 0) - (s.open ?? 0)) <= thr
          && Math.abs((b.close ?? 0) - (s.close ?? 0)) <= thr;
    };

    // Find the best anchor: try last model bar first (most common case: newest
    // bars visible), then first bar, then middle. Search entire swept set.
    let sAnchor = -1;
    let bAnchor = -1;

    const tryAnchorAt = (bIdx) => {
      // Search the entire swept set for a row that matches bars[bIdx].
      // Prefer the swept index closest to the expected position (tail for last bar,
      // head for first bar) to avoid false matches on duplicate OHLC patterns.
      const bar = bars[bIdx];
      const expectedSI = Math.round((bIdx / N) * M); // expected position in sweep
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < M; j++) {
        if (ohlcClose(bar, validSwept[j])) {
          const dist = Math.abs(j - expectedSI);
          if (dist < bestDist) { bestDist = dist; best = j; }
        }
      }
      return best;
    };

    // Try in order: last bar, first bar, middle bar.
    for (const bIdx of [N - 1, 0, Math.floor(N / 2)]) {
      const j = tryAnchorAt(bIdx);
      if (j !== -1) { bAnchor = bIdx; sAnchor = j; break; }
    }

    if (sAnchor !== -1) {
      // Walk backwards from anchor: bars[bI] <-> validSwept[sI]
      let bI = bAnchor;
      let sI = sAnchor;
      // First walk forward to the end (newer bars).
      let bFwd = bAnchor;
      let sFwd = sAnchor;
      while (bFwd < N && sFwd < M) {
        if (ohlcClose(bars[bFwd], validSwept[sFwd])) {
          applyInds(bars[bFwd], validSwept[sFwd].indicators);
          bFwd++; sFwd++;
        } else if (bFwd + 1 < N && ohlcClose(bars[bFwd + 1], validSwept[sFwd])) {
          bFwd++; // model has extra bar the sweep missed
        } else if (sFwd + 1 < M && ohlcClose(bars[bFwd], validSwept[sFwd + 1])) {
          sFwd++; // sweep has extra reading
        } else {
          bFwd++; sFwd++;
        }
      }
      // Now walk backward to cover older bars.
      bI = bAnchor - 1; sI = sAnchor - 1;
      while (bI >= 0 && sI >= 0) {
        if (ohlcClose(bars[bI], validSwept[sI])) {
          applyInds(bars[bI], validSwept[sI].indicators);
          bI--; sI--;
        } else if (bI > 0 && ohlcClose(bars[bI - 1], validSwept[sI])) {
          bI--;
        } else if (sI > 0 && ohlcClose(bars[bI], validSwept[sI - 1])) {
          sI--;
        } else {
          bI--; sI--;
        }
      }
    }
  }

  function populateMissingIndicatorData(bars, indicatorCols, liveIndicators = {}) {
    if (!bars || !bars.length || !indicatorCols || !indicatorCols.length) return;
    for (const col of indicatorCols) {
      let missingCount = 0;
      for (const b of bars) {
        if (b[col] === undefined || b[col] === null) missingCount++;
      }
      if (missingCount === 0) continue;

      const altCol1 = col.replace(' [', ' › ').replace(']', '');
      const altCol2 = col.replace(' › ', ' [') + ']';

      // 1. Technical indicator calculation engine for known standard indicators.
      const parsedCol = parseIndicatorCol(col);
      if (parsedCol) {
        // This is a known mathematical indicator (RSI, EMA, etc.) — we can compute it.
        const liveVal = liveIndicators[col] ?? liveIndicators[altCol1] ?? liveIndicators[altCol2] ?? bars[bars.length - 1]?.[col] ?? null;
        const computed = computeSeriesForCol(col, bars, liveVal);
        if (computed && computed.length === bars.length) {
          for (let i = 0; i < bars.length; i++) {
            if (bars[i][col] === undefined || bars[i][col] === null) {
              bars[i][col] = computed[i];
            }
          }
          continue;
        }
      }

      // 2. Static level / constant plots (e.g. "+50", "-50", "0")
      const subPlot = col.includes('›')
        ? col.split('›').pop().trim()
        : (col.includes('[') ? col.replace(/.*\[([^\]]+)\].*/, '$1').trim() : '');
      if (/^[+-]?\d+(\.\d+)?$/.test(subPlot)) {
        const levelNum = Number(subPlot);
        if (Number.isFinite(levelNum)) {
          for (let i = 0; i < bars.length; i++) {
            bars[i][col] = levelNum;
          }
          continue;
        }
      }

      // 3. Custom / Pine Script indicators: interpolate between the swept values
      //    that DID get matched. Do NOT fill with liveVal — that is the current
      //    bar's value and would be wrong for all historical bars.
      //    Only interpolate if we have at least some matched values (partial sweep).
      let firstKnownIdx = -1;
      let lastKnownIdx = -1;
      for (let i = 0; i < bars.length; i++) {
        if (bars[i][col] != null) {
          if (firstKnownIdx === -1) firstKnownIdx = i;
          lastKnownIdx = i;
        }
      }

      // If we have at least 2 known values, interpolate between them.
      if (firstKnownIdx !== -1 && lastKnownIdx > firstKnownIdx) {
        let prev = firstKnownIdx;
        for (let i = firstKnownIdx + 1; i <= lastKnownIdx; i++) {
          if (bars[i][col] != null) {
            // Linear interpolation between prev and i for short gaps (<= 6 steps).
            const steps = i - prev;
            if (steps > 1 && steps <= 6) {
              const startVal = bars[prev][col];
              const endVal = bars[i][col];
              const stepDelta = (endVal - startVal) / steps;
              for (let j = prev + 1; j < i; j++) {
                bars[j][col] = roundDecimals(startVal + stepDelta * (j - prev), 2);
              }
            }
            prev = i;
          }
        }
        // Only back-fill bars before first known value if the gap is short (<= 5 bars).
        // Never back-fill hundreds of bars with the last candle value!
        if (firstKnownIdx > 0 && firstKnownIdx <= 5) {
          const firstVal = bars[firstKnownIdx][col];
          for (let i = 0; i < firstKnownIdx; i++) {
            if (bars[i][col] == null) bars[i][col] = firstVal;
          }
        }
        // Only forward-fill bars after last known value if the gap is short (<= 5 bars).
        if (lastKnownIdx < bars.length - 1 && (bars.length - 1 - lastKnownIdx) <= 5) {
          const lastVal = bars[lastKnownIdx][col];
          for (let i = lastKnownIdx + 1; i < bars.length; i++) {
            if (bars[i][col] == null) bars[i][col] = lastVal;
          }
        }
      }
      // If we have NO known values at all for a custom indicator, leave as null.
      // The CSV will have empty cells — better than wrong values.
    }
  }

  /**
   * Join model bars with per-bar study values (exact epochMs match).
   * Unpacks multi-plot values (named styles/plots or arrays) into separate columns
   * so every indicator value and parameter is mapped to its respective column.
   * Missing study points -> null (empty CSV cell) + counted for warnings.
   */
  function buildRangeRows(bars, studies, symbol, timeframe) {
    const colMaps = [];

    for (const s of (studies ?? [])) {
      if (!s) continue;
      const sName = String(s.name ?? 'Indicator').trim().slice(0, 100);
      const points = (s.points ?? []).filter((p) => p && p.epochMs != null);
      if (!points.length) continue;

      let isMultiPlot = false;
      let plotNames = Array.isArray(s.plots) && s.plots.length ? s.plots : null;
      let maxLen = 0;
      let sampleKeys = null;

      for (const p of points.slice(0, 50)) {
        if (Array.isArray(p.value)) {
          isMultiPlot = true;
          if (p.value.length > maxLen) maxLen = p.value.length;
        } else if (p.value && typeof p.value === 'object') {
          isMultiPlot = true;
          sampleKeys = Object.keys(p.value);
        }
      }

      if (!isMultiPlot) {
        const m = new Map();
        for (const p of points) {
          if (p.value != null) m.set(p.epochMs, p.value);
        }
        colMaps.push({ colName: sName, map: m });
      } else if (sampleKeys && sampleKeys.length) {
        for (const k of sampleKeys) {
          const colNameWithSymbol = `${sName} › ${k}`;
          const colNameWithBracket = `${sName} [${k}]`;
          const m = new Map();
          for (const p of points) {
            const v = p.value?.[k];
            if (v != null) m.set(p.epochMs, v);
          }
          colMaps.push({ colName: colNameWithBracket, altName: colNameWithSymbol, map: m });
        }
      } else {
        const count = plotNames ? Math.max(plotNames.length, maxLen) : maxLen;
        for (let i = 0; i < count; i++) {
          const plotLabel = plotNames && plotNames[i] ? plotNames[i] : String(i);
          const colNameWithSymbol = `${sName} › ${plotLabel}`;
          const colNameWithBracket = `${sName} [${plotLabel}]`;
          const m = new Map();
          for (const p of points) {
            const v = Array.isArray(p.value) ? p.value[i] : (i === 0 ? p.value : null);
            if (v != null) m.set(p.epochMs, v);
          }
          colMaps.push({ colName: colNameWithBracket, altName: colNameWithSymbol, map: m });
        }
      }
    }

    const indicatorCols = [...new Set(colMaps.map((c) => c.colName))];
    const missing = new Map(indicatorCols.map((c) => [c, 0]));

    const rows = (bars ?? []).map((b) => {
      const row = {
        symbol, timeframe,
        epochMs: b.epochMs ?? null,
        datetime: b.epochMs != null ? excelDate(b.epochMs) : '',
        open: b.open ?? null, high: b.high ?? null,
        low: b.low ?? null, close: b.close ?? null,
      };
      for (const c of colMaps) {
        let v = c.map.get(b.epochMs);
        if ((v === undefined || v === null) && b.epochMs != null) {
          // Nearest timestamp fallback within 180 seconds if exact ms key had tiny offset
          const bMs = b.epochMs;
          let bestDelta = Infinity;
          let bestVal = null;
          for (const [pMs, pVal] of c.map) {
            const delta = Math.abs(pMs - bMs);
            if (delta < bestDelta && delta <= 180000) {
              bestDelta = delta;
              bestVal = pVal;
            }
          }
          if (bestVal != null) v = bestVal;
        }
        if (v === undefined || v === null) {
          row[c.colName] = null;
          if (c.altName) row[c.altName] = null;
          missing.set(c.colName, (missing.get(c.colName) ?? 0) + 1);
        } else {
          row[c.colName] = v;
          if (c.altName) row[c.altName] = v;
        }
      }
      return row;
    });
    return { rows, indicatorCols, missing };
  }

  /**
   * Rows -> Excel-compatible CSV string (CRLF line endings + caller-added BOM).
   * Columns: Symbol, Timeframe, Datetime, Open, High, Low, Close, [indicators…]
   */
  function toCSV(rows, indicatorCols) {
    const header = ['Symbol', 'Timeframe', 'Datetime', 'Open', 'High', 'Low', 'Close', ...indicatorCols];
    const lines = [header.map(csvEscape).join(',')];
    for (const r of rows) {
      lines.push([
        r.symbol, r.timeframe, r.datetime,
        r.open, r.high, r.low, r.close,
        ...indicatorCols.map((c) => r[c]),
      ].map(csvEscape).join(','));
    }
    return lines.join('\r\n');
  }

  function describeRange(ms) {
    try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
    catch { return String(ms); }
  }

  function toTradingViewResolution(tf) {
    if (!tf) return null;
    const s = String(tf).trim();
    if (s.toLowerCase() === 'auto') return null;
    const mSec = s.match(/^(\d+)\s*s$/i);
    if (mSec) return `${mSec[1]}S`;
    const mMin = s.match(/^(\d+)\s*m$/i);
    if (mMin) return mMin[1];
    const mHour = s.match(/^(\d+)\s*h$/i);
    if (mHour) return String(Number(mHour[1]) * 60);
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return mDay[1] === '1' ? 'D' : `${mDay[1]}D`;
    const mWeek = s.match(/^(\d+)\s*w$/i);
    if (mWeek) return mWeek[1] === '1' ? 'W' : `${mWeek[1]}W`;
    if (/^1?M$/i.test(s)) return 'M';
    if (/^\d+$/.test(s)) return s;
    return s;
  }

  async function switchChartTimeframe(targetTf) {
    if (!targetTf || targetTf === 'auto') return false;
    const norm = normalizeTimeframe(targetTf);
    const tvRes = toTradingViewResolution(norm);

    // 1) Direct page API (main world / harness)
    try {
      if (window.__TV_EXTRACTOR__?.setResolution) {
        const res = window.__TV_EXTRACTOR__.setResolution(tvRes);
        if (res?.ok) {
          await sleep(50);
          return true;
        }
      }
    } catch { /* ignore */ }

    // 2) Page API via bridge
    try {
      const res = callPageSync('setResolution', [tvRes]);
      if (res?.ok) {
        await sleep(1500);
        return true;
      }
    } catch { /* ignore */ }

    // 3) Top toolbar buttons
    try {
      const buttons = document.querySelectorAll(
        '#header-toolbar-intervals button, [data-name="header-toolbar-intervals"] button, ' +
        '[data-name="timeframes-menu"] button, header button'
      );
      for (const btn of buttons) {
        const val = btn.getAttribute('data-value') ?? btn.getAttribute('data-interval') ?? text(btn).trim();
        if (val && (normalizeTimeframe(val) === norm || val === tvRes || text(btn).trim() === norm)) {
          btn.click();
          await sleep(1500);
          return true;
        }
      }
    } catch { /* ignore */ }

    return false;
  }

  /**
   * Orchestrator for TV_FETCH_RANGE. Returns the response object directly.
   * Never throws — all failures become { ok:false, error, message }.
   */
  async function fetchRange(startMs, endMs, requestedTimeframe) {
    // ---- 1. Validate the user-supplied range -------------------------------
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return { ok: false, error: 'INVALID_RANGE', message: 'Start/End dates could not be parsed. Use the date-time pickers.' };
    }
    if (startMs >= endMs) {
      return { ok: false, error: 'INVALID_RANGE', message: 'Start must be earlier than End.' };
    }
    if (startMs > Date.now()) {
      return { ok: false, error: 'INVALID_RANGE', message: 'Start is in the future — no candles exist there yet.' };
    }

    // ---- 2. Auto-detect symbol + timeframe (same extractors as snapshot) ----
    let pageModel = readPageModel();
    const seriesEl = queryFirst(SELECTORS.seriesItem) ?? findSeriesByOHLCText();
    let symbol = extractSymbol(seriesEl);
    if (symbol === 'UNKNOWN' && pageModel?.symbol) symbol = pageModel.symbol;
    let timeframe = extractTimeframe(pageModel);

    // If custom/requested timeframe was supplied and differs from active timeframe:
    if (requestedTimeframe && requestedTimeframe !== 'auto') {
      const normRequested = normalizeTimeframe(requestedTimeframe);
      if (normRequested !== timeframe) {
        emitProgress('timeframe', `Switching timeframe from ${timeframe} to ${normRequested}…`);
        const switched = await switchChartTimeframe(normRequested);
        if (switched) {
          pageModel = readPageModel();
          timeframe = normRequested;
        }
      }
    }

    if (symbol === 'UNKNOWN' || !seriesEl) {
      return { ...chartMissingVerdict(), data: { symbol, timeframe } };
    }

    // ---- 3. Range-size guard (prevents runaway 50k-bar exports) ------------
    const tfMs = timeframeToMs(timeframe);
    if (tfMs != null) {
      const est = Math.ceil((endMs - startMs) / tfMs);
      if (est > FETCH_MAX_BARS) {
        return {
          ok: false, error: 'RANGE_TOO_LARGE',
          message: `Selected range ≈ ${est.toLocaleString()} ${timeframe} bars (cap ${FETCH_MAX_BARS}). ` +
                   'Narrow the dates or switch to a higher timeframe.',
          data: { symbol, timeframe, estimatedBars: est },
        };
      }
    }

    // ---- 4. Read the internal model (retry once after ensuring injection) ---
    emitProgress('reading', 'Reading chart data model…');
    let coverage = readPageRange(startMs, endMs);
    if (!coverage) {
      ensureInjected();
      await sleep(1500);
      coverage = readPageRange(startMs, endMs);
    }

    const modelUsable = !!(coverage && coverage.ok && Array.isArray(coverage.bars) && ((coverage.totalLoaded ?? 0) > 0 || coverage.bars.length > 0));
    const warnings = [];
    let bars = [];
    let studies = [];
    let indicatorCols = [];
    let panned = false;
    let attempts = 0;
    let diagnostics = null; // filled on the sweep path; null on the model path
    let method = modelUsable ? 'data-model' : null;
    let earliestMs = coverage?.earliestMs ?? null;
    let latestMs = coverage?.latestMs ?? null;

    if (modelUsable) {
      // ---- 5a. Auto-pan for older history when the Start isn't loaded ------
      if (earliestMs != null && earliestMs > startMs) {
        const res = await ensureCoverage(startMs, endMs);
        coverage = res.coverage ?? coverage;
        panned = res.panned;
        attempts = res.attempts;
        earliestMs = coverage?.earliestMs ?? earliestMs;
        latestMs = coverage?.latestMs ?? latestMs;
      }
      bars = (coverage?.bars ?? []).filter((b) =>
        b && b.epochMs != null && b.epochMs >= startMs && b.epochMs <= endMs);
      studies = coverage?.studies ?? [];
      earliestMs = coverage?.earliestMs ?? null;
      latestMs = coverage?.latestMs ?? null;

      if (!bars.length) {
        const allLoaded = Array.isArray(coverage?.allBars) && coverage.allBars.length
          ? coverage.allBars
          : (Array.isArray(coverage?.bars) && coverage.bars.length ? coverage.bars : []);

        if (allLoaded.length > 0) {
          bars = allLoaded;
          studies = coverage?.allStudies ?? studies;
          warnings.push(
            `Requested range (${describeRange(startMs)} → ${describeRange(endMs)}) has no trading candles ` +
            `(market closed, weekend, or out of bounds). Exported all ${bars.length} loaded candle(s) ` +
            `from ${describeRange(earliestMs ?? bars[0].epochMs)} to ${describeRange(latestMs ?? bars[bars.length - 1].epochMs)}.`
          );
        }
      }

      if (bars.length) {
        if (earliestMs != null && earliestMs > startMs) {
          warnings.push(`Partial coverage: earliest loaded candle is ${describeRange(earliestMs)} — ` +
            `older than that is unavailable. Exported ${bars.length} bar(s) from ${describeRange(bars[0].epochMs)} onward. ` +
            'Pan further back / zoom out and retry for more.');
        }

        // ---- 6a. Join bars + studies, warn on indicator gaps ------------------
        const built = buildRangeRows(bars, studies, symbol, timeframe);
        indicatorCols = built.indicatorCols;
        bars = built.rows;
        const currentIndicators = seriesEl ? parseIndicators(seriesEl) : {};
        if (currentIndicators && Object.keys(currentIndicators).length) {
          for (const k of Object.keys(currentIndicators)) {
            const alt1 = k.replace(' › ', ' [') + ']';
            const alt2 = k.replace(' [', ' › ').replace(']', '');
            if (!indicatorCols.includes(k) && !indicatorCols.includes(alt1) && !indicatorCols.includes(alt2)) {
              indicatorCols.push(k);
            }
          }
        }

        // If custom indicators are present in the legend but missing per-bar data,
        // do a bar-by-bar keyboard sweep to get accurate per-bar readings.
        if (seriesEl && indicatorCols.length > 0) {
          const hasMissingCustom = indicatorCols.some((k) => !parseIndicatorCol(k) && bars.some((b) => b[k] == null));
          if (hasMissingCustom) {
            emitProgress('sweep', 'Sweeping candles bar-by-bar to capture custom indicator readings…');
            // Use keyboard sweep for bar-accurate readings (one press = one bar).
            // Fall back to pointer sweep if keyboard yields nothing.
            const maxKbSteps = Math.min(bars.length + 100, 2000);
            let kbRows = await sweepByKeyboard(seriesEl, maxKbSteps);
            const kbHasInds = kbRows.filter((r) => r.indicators && Object.keys(r.indicators).length > 0).length;
            if (kbRows.length > 1 && kbHasInds > 0) {
              mergeSweptIndicators(bars, kbRows, indicatorCols, tfMs);
              const matched = bars.filter((b) => indicatorCols.some((c) => !parseIndicatorCol(c) && b[c] != null)).length;
              warnings.push(`Keyboard sweep: ${kbRows.length} bars read, ${kbHasInds} with indicators, ${matched}/${bars.length} model bars matched.`);
            } else {
              // Keyboard didn't work — try pointer sweep.
              const swept = await sweepLegendRange(seriesEl, tfMs);
              if (swept && swept.rows && swept.rows.length > 1 && (swept.diagnostics?.legendChangedSteps > 0 || (swept.rows[0].indicators && swept.rows[swept.rows.length - 1].indicators && JSON.stringify(swept.rows[0].indicators) !== JSON.stringify(swept.rows[swept.rows.length - 1].indicators)))) {
                mergeSweptIndicators(bars, swept.rows, indicatorCols, tfMs);
                const matched = bars.filter((b) => indicatorCols.some((c) => !parseIndicatorCol(c) && b[c] != null)).length;
                warnings.push(`Pointer sweep fallback: ${swept.rows.length} bars read, ${matched}/${bars.length} model bars matched.`);
              } else {
                warnings.push(`SWEEP_GUARD: crosshair movements were ignored by TradingView on this chart (legend static). Retaining data model indicators without frozen-legend pollution.`);
              }
            }
          }
        }

        populateMissingIndicatorData(bars, indicatorCols, currentIndicators);
        for (const [name, count] of built.missing) {
          if (count > 0 && !indicatorCols.includes(name)) {
            warnings.push(`Indicator "${name}": ${count}/${built.rows.length} bar(s) have no value ` +
              '(warm-up period or study not computed there) — those CSV cells are left empty.');
          }
        }
        if (!indicatorCols.length) {
          warnings.push('No indicator series were readable from the chart model on this build — ' +
            'CSV contains OHLC only. (Legend shows live values, but per-bar history needs model access.)');
        }
      }
    }

    if (!bars.length) {
      const feed = getCapturedDatafeed();
      const inRangeFeed = Array.isArray(feed)
        ? feed.filter((b) => b && b.epochMs != null && b.epochMs >= startMs && b.epochMs <= endMs)
        : [];

      if (inRangeFeed.length > 0) {
        emitProgress('exporting', `Exporting ${inRangeFeed.length} candles from network datafeed…`);
        method = 'datafeed-capture';
        earliestMs = inRangeFeed[0].epochMs;
        latestMs = inRangeFeed[inRangeFeed.length - 1].epochMs;

        const currentIndicators = seriesEl ? parseIndicators(seriesEl) : {};
        if (studies && studies.length) {
          const built = buildRangeRows(inRangeFeed, studies, symbol, timeframe);
          indicatorCols = built.indicatorCols;
          bars = built.rows;
          if (currentIndicators && Object.keys(currentIndicators).length) {
            for (const k of Object.keys(currentIndicators)) {
              if (!indicatorCols.includes(k)) indicatorCols.push(k);
            }
          }
          if (seriesEl && indicatorCols.length > 0) {
            const hasMissingCustom = indicatorCols.some((k) => !parseIndicatorCol(k) && bars.some((b) => b[k] == null));
            if (hasMissingCustom) {
              emitProgress('sweep', 'Sweeping candles bar-by-bar for datafeed path…');
              const maxKbSteps = Math.min(bars.length + 50, 2000);
              let kbRows = await sweepByKeyboard(seriesEl, maxKbSteps);
              if (kbRows.length > 1) {
                mergeSweptIndicators(bars, kbRows, indicatorCols, tfMs);
              } else {
                const swept = await sweepLegendRange(seriesEl, tfMs);
                if (swept && swept.rows && swept.rows.length > 1) {
                  mergeSweptIndicators(bars, swept.rows, indicatorCols, tfMs);
                }
              }
            }
          }
          populateMissingIndicatorData(bars, indicatorCols, currentIndicators);
        } else {
          const indKeys = Object.keys(currentIndicators);
          bars = inRangeFeed.map((r) => ({
            symbol, timeframe,
            epochMs: r.epochMs ?? null,
            datetime: r.epochMs != null ? excelDate(r.epochMs) : '',
            open: r.open ?? null, high: r.high ?? null,
            low: r.low ?? null, close: r.close ?? null,
          }));
          if (indKeys.length > 0) {
            indicatorCols = indKeys;
            if (seriesEl) {
              emitProgress('sweep', 'Sweeping candles bar-by-bar for indicators…');
              const maxKbSteps = Math.min(bars.length + 50, 2000);
              let kbRows = await sweepByKeyboard(seriesEl, maxKbSteps);
              if (kbRows.length > 1) {
                mergeSweptIndicators(bars, kbRows, indicatorCols, tfMs);
              } else {
                const swept = await sweepLegendRange(seriesEl, tfMs);
                if (swept && swept.rows && swept.rows.length > 1) {
                  mergeSweptIndicators(bars, swept.rows, indicatorCols, tfMs);
                }
              }
            }
            populateMissingIndicatorData(bars, indicatorCols, currentIndicators);
            warnings.push('Indicator columns populated and calculated across all historical rows.');
          }
        }
        warnings.push('Method C (network datafeed capture) used — exact historical OHLC bars exported without crosshair sweep.');
      } else {
        // ---- 5b. Fallback: crosshair sweep across the visible chart ----------
        emitProgress('sweep', 'Data model unreachable — sweeping visible candles…');
        const swept = await sweepLegendRange(seriesEl, tfMs);
        warnings.push(...swept.warnings);
        diagnostics = swept.diagnostics;
        method = swept.diagnostics?.method ?? 'pointer-sweep';

        const inRange = swept.rows.filter((r) =>
          r.epochMs != null && r.epochMs >= startMs && r.epochMs <= endMs);
        const usable = inRange.length ? inRange : swept.rows;
        if (!usable.length) {
          return {
            ok: false,
            error: sweepErrorCode(swept.diagnostics),
            message: sweepErrorMessage(swept.diagnostics),
            data: {
              symbol, timeframe,
              diagnostics: swept.diagnostics,
              warnings: swept.warnings,
            },
          };
        }
        // A multi-bar range that yields a single candle means the crosshair is
        // stuck (TV ignoring synthetic hovers). Exporting 1 row as if it were
        // the whole range would be silently wrong — fail loudly instead.
        if (usable.length <= 1 && tfMs != null && (endMs - startMs) > tfMs) {
          return {
            ok: false,
            error: 'HOVER_NOT_MOVING',
            message: 'Only 1 candle could be read across the whole sweep while your range spans many ' +
              'bars, so the synthetic crosshair is not moving on this build. Zoom the chart so more ' +
              'candles are visible, move your real mouse over the chart once, then click Fetch again.',
            data: {
              symbol, timeframe,
              diagnostics: swept.diagnostics,
              warnings: swept.warnings,
            },
          };
        }
        if (!inRange.length && swept.rows.length) {
          warnings.push('Timestamps could not be matched to your Start/End dates, so every swept ' +
            'visible candle was exported instead. Zoom the chart to the desired span and retry.');
        }
        // Honest coverage note: the sweep samples N positions across the whole
        // visible chart — a wide zoom yields fewer rows than bars in range.
        if (tfMs != null) {
          const est = Math.ceil((endMs - startMs) / tfMs);
          if (est > usable.length) {
            warnings.push(`Coverage: the sweep sampled ${usable.length} of ~${est} ${timeframe} bars ` +
              'in your date range (one sample per visible column). Zoom the chart in so the target ' +
              'span fills the screen, then retry for full coverage.');
          }
        }
        indicatorCols = swept.indicatorCols ?? [];
        bars = usable.map((r) => {
          const row = {
            symbol, timeframe,
            epochMs: r.epochMs ?? null,
            datetime: r.epochMs != null ? excelDate(r.epochMs) : '',
            open: r.open ?? null, high: r.high ?? null,
            low: r.low ?? null, close: r.close ?? null,
          };
          for (const c of indicatorCols) row[c] = r.indicators?.[c] ?? null;
          return row;
        });
        const currentIndicators = seriesEl ? parseIndicators(seriesEl) : {};
        if (!indicatorCols.length && currentIndicators && Object.keys(currentIndicators).length) {
          indicatorCols = Object.keys(currentIndicators);
        }
        populateMissingIndicatorData(bars, indicatorCols, currentIndicators);
        if (method === 'keyboard-sweep') {
          warnings.push('Keyboard crosshair walk used (pointer hovers were ignored by this build).');
        }
        warnings.push('Sweep fallback used (internal data model not reachable on this build) — ' +
          'values come from the live legend at each hovered candle.');
      }
    }

    // ---- 7. CSV + filename --------------------------------------------------
    emitProgress('exporting', `Formatting ${bars.length} candle(s) to CSV…`);
    const csv = toCSV(bars, indicatorCols);
    const filename = `tradingview_data_${sanitizeFilename(symbol)}_${sanitizeFilename(timeframe)}.csv`;
    const preview = bars.slice(0, 3).map(({ epochMs, ...rest }) => rest);

    try {
      chrome.storage.local.set({
        tvLastRangeMeta: {
          symbol, timeframe, startMs, endMs, count: bars.length,
          filename, warnings, at: Date.now(),
        },
      }).catch(() => {});
    } catch { /* non-fatal */ }

    return {
      ok: true,
      data: {
        symbol, timeframe, startMs, endMs,
        count: bars.length, filename, csv, preview,
        warnings, panned, attempts, earliestMs, latestMs,
        indicatorColumns: indicatorCols,
        method,
        timestampsEstimated: diagnostics?.timestampsEstimated ?? false,
        diagnostics,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Message router (popup.js <-> content.js)
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (!msg || typeof msg.type !== 'string') return false;

      if (msg.type === 'TV_GET_SNAPSHOT') {
        sendResponse(buildSnapshot());
        return true;
      }
      if (msg.type === 'TV_STREAM_START') {
        // Don't let a chart-less iframe claim the stream — popup retargets.
        if (!isChartFrame()) {
          sendResponse({ ok: false, error: 'NO_CHART_IN_FRAME', message: noChartGuidance() });
          return true;
        }
        startStream(msg.intervalMs);
        sendResponse({ ok: true, streaming: true });
        return true;
      }
      if (msg.type === 'TV_STREAM_STOP') {
        stopStream();
        sendResponse({ ok: true, streaming: false });
        return true;
      }
      if (msg.type === 'TV_STREAM_STATUS') {
        sendResponse({ ok: true, streaming });
        return true;
      }
      if (msg.type === 'TV_PING') {
        sendResponse({ ok: true, ready: !!queryFirst(SELECTORS.legendRoot) });
        return true;
      }
      if (msg.type === 'TV_PROBE') {
        sendResponse({ ok: true, probe: diagnoseFrame() });
        return true;
      }
      if (msg.type === 'TV_FETCH_RANGE') {
        // Async: panning + settling takes seconds. Keep the channel open.
        (async () => {
          try {
            const res = await fetchRange(Number(msg.startMs), Number(msg.endMs), msg.requestedTimeframe);
            sendResponse(res);
          } catch (err) {
            try {
              sendResponse({ ok: false, error: 'FETCH_FAILED', message: String(err?.message ?? err) });
            } catch { /* popup gone */ }
          }
        })();
        return true;
      }
    } catch (err) {
      try { sendResponse({ ok: false, error: 'CONTENT_HANDLER_FAILED', message: String(err?.message ?? err) }); } catch { /* ignore */ }
      return true;
    }
    return false;
  });

  // Re-attach observer root if TV re-renders the legend while streaming.
  // (Lightweight: checks every 5s only while streaming.)
  setInterval(() => {
    if (!streaming || legendObserver) return;
    try {
      const root = queryFirst(SELECTORS.legendRoot);
      if (root) {
        legendObserver = new MutationObserver(() => { if (streaming) pushTick('mutation'); });
        legendObserver.observe(root, { childList: true, subtree: true, characterData: true });
      }
    } catch { /* ignore */ }
  }, 5000);

  // Boot.
  ensureInjected();
  // Re-try injection shortly after load — TV is an SPA and the widget often
  // initializes after content.js runs.
  window.addEventListener('load', ensureInjected, { once: true });
  setTimeout(ensureInjected, 3000);
})();
