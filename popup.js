/**
 * popup.js — popup UI + communication with content.js.
 *
 * Flows:
 *  1. Capture: one-shot `TV_GET_SNAPSHOT` -> render JSON in textarea.
 *  2. Stream:  `TV_STREAM_START/STOP` + live `TV_STREAM_TICK` listener.
 *  3. Copy / Download: clipboard + .json export of the last payload.
 *  4. Range export: `TV_FETCH_RANGE` with user Start/End -> CSV download
 *     named `tradingview_data_[symbol]_[timeframe].csv`, with live
 *     `TV_FETCH_PROGRESS` status updates (auto-pan, formatting).
 *
 * Robustness:
 *  - If the active tab isn't TradingView (or content.js isn't injected yet),
 *    we try `chrome.scripting.executeScript` as a recovery, else show a
 *    clear error instead of failing silently.
 *  - Stream toggle state is restored from the tab so reopening the popup
 *    reflects reality.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const captureBtn = $('captureBtn');
const streamToggle = $('streamToggle');
const output = $('output');
const copyBtn = $('copyBtn');
const downloadBtn = $('downloadBtn');
const statusDot = $('statusDot');
const statusText = $('statusText');
// Historical range export refs.
const timeframeSelect = $('timeframeSelect');
const customTfField = $('customTfField');
const customTfInput = $('customTfInput');
const startInput = $('startInput');
const endInput = $('endInput');
const fetchBtn = $('fetchBtn');
const rangeNote = $('rangeNote');
const diagnoseBtn = $('diagnoseBtn');

let lastPayload = null;
let applyingRemoteTick = false;

// ---------------------------------------------------------------------------
// Status + rendering helpers
// ---------------------------------------------------------------------------

function setStatus(mode, msg) {
  statusDot.className = 'dot' + (mode ? ` ${mode}` : '');
  statusText.textContent = msg;
}

function pretty(payload) {
  return JSON.stringify(payload, null, 2);
}

function render(payload, label) {
  lastPayload = payload;
  output.value = pretty(payload);
  if (label) setStatus('ok', label);
  // Persist so background/service-worker consumers can read the latest.
  chrome.storage.local.set({ tvLastPopupPayload: payload }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tab + messaging plumbing
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function isTradingViewUrl(url = '') {
  try {
    const u = new URL(url);
    return /(^|\.)tradingview\.(com|cn)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Self-contained frame probe (no closures — it gets serialized into the tab).
 * Scores each frame on chart-likeness: legend hits dominate, big canvas and
 * visible O…H…L…C text contribute. Stable JSON return, never throws outward.
 */
function tvFrameProbe() {
  try {
    const count = (sel) => {
      try { return document.querySelectorAll(sel).length; } catch { return 0; }
    };
    const legendSels = [
      '[data-name="legend"]',
      '[data-name="legend-series-item"]',
      '[data-name="legend-source-item"]',
      '.chart-title',
      'div[class*="legend"]',
    ];
    let legendHits = 0;
    for (const s of legendSels) legendHits += count(s);
    const canvases = count('canvas');
    let bigCanvas = 0;
    try {
      for (const c of document.querySelectorAll('canvas')) {
        if ((c.width || 0) > 300 && (c.height || 0) > 200) { bigCanvas = 1; break; }
      }
    } catch { /* ignore */ }
    let ohlcText = 0;
    try {
      const t = (document.body ? document.body.innerText : '').slice(0, 20000);
      ohlcText = /O\s*[−\-+]?[0-9][0-9,]*\.?[0-9]*\s+H\s*[−\-+]?[0-9]/i.test(t) ? 1 : 0;
    } catch { /* ignore */ }
    return {
      url: location.href.slice(0, 120),
      legendHits, canvases, bigCanvas, ohlcText,
      score: legendHits * 10 + bigCanvas * 5 + ohlcText * 3 + Math.min(canvases, 3),
    };
  } catch {
    return { url: '', legendHits: 0, canvases: 0, bigCanvas: 0, ohlcText: 0, score: 0 };
  }
}

/** Best chart-like frame in the tab (or null). Never throws. */
async function findChartFrame(tabId, minScore = 5) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: tvFrameProbe,
    });
    let best = null;
    for (const r of results ?? []) {
      if (!r?.result) continue;
      if (!best || r.result.score > best.result.score) best = r;
    }
    return best && best.result.score >= minScore
      ? { frameId: best.frameId, ...best.result }
      : null;
  } catch {
    return null;
  }
}

/** Errors meaning "asked the wrong frame" — worth one retarget attempt. */
const RETARGETABLE = new Set(['NO_CHART_IN_FRAME', 'NO_CHART_ON_PAGE', 'CHART_NOT_READY']);

/**
 * Send a message to content.js, injecting it first if the tab is a
 * TradingView page but the content script hasn't loaded (e.g. installed
 * mid-session before navigation).
 *
 * Frame handling: content.js lives in every frame and the first response
 * wins, so a chart-less iframe can shadow the real chart. On a retargetable
 * error we probe all frames once and re-send directly to the best chart-like
 * frame via { frameId }.
 */
async function sendToContent(message, opts = {}) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab found.');

  if (!isTradingViewUrl(tab.url)) {
    throw new Error('Active tab is not TradingView. Open a tradingview.com chart first.');
  }

  // Fast path: broadcast (the chart frame usually answers first).
  try {
    const res = await chrome.tabs.sendMessage(tab.id, message);
    if (!opts.retargeted && res && RETARGETABLE.has(res.error)) {
      // The answer may come from a chart-less iframe shadowing the real
      // chart frame — probe all frames and ask the best one directly.
      const target = await findChartFrame(tab.id);
      if (target?.frameId != null) {
        try {
          return await chrome.tabs.sendMessage(tab.id, message, { frameId: target.frameId });
        } catch { /* fall through: return the original answer */ }
      }
    }
    return res;
  } catch (err) {
    // Recovery: force-inject content.js everywhere, then retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
      await new Promise((r) => setTimeout(r, 400));
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      throw new Error(
        'Could not reach the chart. Reload the TradingView tab and try again.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function onCapture() {
  captureBtn.disabled = true;
  setStatus('', 'Capturing…');
  try {
    const res = await sendToContent({ type: 'TV_GET_SNAPSHOT' });
    if (res?.ok) {
      render(res.data, `Captured ${res.data.symbol} ${res.data.timeframe} · ${res.data.timestamp}`);
    } else {
      // Structured error from content.js (chart loading etc.) — still show
      // the partial payload so the user sees what WAS detected.
      render(
        { error: res?.error ?? 'UNKNOWN', message: res?.message ?? 'Capture failed.', ...(res?.data ?? {}) },
        `⚠ ${res?.error ?? 'Capture failed'} — see JSON`
      );
      setStatus('err', `⚠ ${res?.error ?? 'Capture failed'}`);
    }
  } catch (err) {
    output.value = `// ERROR\n${err.message}`;
    setStatus('err', `⚠ ${err.message}`);
  } finally {
    captureBtn.disabled = false;
  }
}

async function onStreamToggle() {
  const want = streamToggle.checked;
  try {
    if (want) {
      await sendToContent({ type: 'TV_STREAM_START', intervalMs: 1000 });
      setStatus('live', '● Streaming live — move crosshair or wait for candles');
    } else {
      await sendToContent({ type: 'TV_STREAM_STOP' });
      setStatus('ok', 'Stream stopped.');
    }
  } catch (err) {
    streamToggle.checked = false;
    setStatus('err', `⚠ ${err.message}`);
  }
}

async function onCopy() {
  const text = output.value.trim();
  if (!text) {
    setStatus('err', 'Nothing to copy yet — capture first.');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    const prev = statusText.textContent;
    setStatus('ok', 'Copied to clipboard ✓');
    setTimeout(() => { if (statusText.textContent.includes('Copied')) setStatus('ok', prev); }, 1800);
  } catch {
    // Fallback for clipboard permission denial: select-all so Ctrl+C works.
    output.focus();
    output.select();
    setStatus('err', 'Clipboard blocked — text selected, press Ctrl+C.');
  }
}

function onDownload() {
  if (!lastPayload) {
    setStatus('err', 'Nothing to download yet — capture first.');
    return;
  }
  try {
    const sym = String(lastPayload.symbol ?? 'TV').replace(/[^A-Za-z0-9_.-]+/g, '_');
    const tf = String(lastPayload.timeframe ?? 'tf').replace(/[^A-Za-z0-9_.-]+/g, '_');
    const blob = new Blob([pretty(lastPayload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tv-${sym}-${tf}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    setStatus('err', `Download failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Historical range export (Start/End -> Excel-compatible CSV)
// ---------------------------------------------------------------------------

function setRangeNote(kind, msg) {
  rangeNote.className = 'range-note' + (kind ? ` ${kind}` : '');
  rangeNote.textContent = msg;
}

/** Date -> "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> (local time). */
function toLocalInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function downloadCSV(filename, csv) {
  // \uFEFF BOM makes Excel open UTF-8 CSVs correctly; CRLF rows from content.js.
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------------
// Diagnose: probe every frame and report where the chart legend lives
// ---------------------------------------------------------------------------

async function onDiagnose() {
  diagnoseBtn.disabled = true;
  setRangeNote('', 'Probing all frames for the chart…');
  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab found.');
    if (!isTradingViewUrl(tab.url)) {
      throw new Error('Active tab is not TradingView. Open a tradingview.com chart first.');
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: tvFrameProbe,
    });
    const frames = (results ?? []).filter((r) => r?.result)
      .map((r) => ({ frameId: r.frameId, ...r.result }))
      .sort((a, b) => b.score - a.score);

    const lines = [
      `// Diagnose — ${tab.url}`,
      '// Score = legendHits×10 + bigCanvas×5 + ohlcText×3 + canvases.',
    ];
    for (const f of frames) {
      lines.push(`// frame ${f.frameId} score=${f.score} legend=${f.legendHits} ` +
                 `canvas=${f.canvases} big=${f.bigCanvas} ohlcText=${f.ohlcText} :: ${f.url}`);
    }
    const top = frames[0];
    if (top && top.score > 0) {
      try {
        const detail = await chrome.tabs.sendMessage(tab.id, { type: 'TV_PROBE' }, { frameId: top.frameId });
        if (detail?.probe) {
          const p = detail.probe;
          lines.push(`// probe(frame ${top.frameId}): page=${p.pageType} isChart=${p.isChartFrame} ` +
                     `isTop=${p.isTop} container=${p.hasChartContainer} canvases=${p.canvasCount}`);
          lines.push(`// symbol≈${p.symbolGuess} timeframe≈${p.timeframeGuess} :: ${p.title}`);
          const hits = Object.entries(p.seriesHits ?? {}).filter(([, n]) => n > 0);
          lines.push(hits.length
            ? `// legend selectors hit: ${hits.map(([s, n]) => `${s}×${n}`).join(', ')}`
            : '// legend selectors hit: NONE — layout renamed or chart still loading');
        }
      } catch (e) {
        lines.push(`// detailed probe failed: ${e.message ?? e}`);
      }
      setRangeNote('ok', `Best frame: ${top.frameId} (score ${top.score}). ` +
        'Capture / Fetch now auto-retarget to it — just retry.');
    } else {
      lines.push('// No chart-like frame found. Open tradingview.com/chart/ with rendered candles, then retry.');
      setRangeNote('warn', 'No chart frame detected — open a TradingView chart first.');
    }
    output.value = lines.join('\n');
  } catch (err) {
    setRangeNote('err', `Diagnose failed: ${err.message}`);
  } finally {
    diagnoseBtn.disabled = false;
  }
}

async function onFetchRange() {
  const startMs = startInput.value ? new Date(startInput.value).getTime() : NaN;
  const endMs = endInput.value ? new Date(endInput.value).getTime() : NaN;

  // ---- Client-side validation (content.js re-validates defensively) ----
  if (!startInput.value || !endInput.value || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    setRangeNote('err', 'Pick both Start and End date/time first.');
    return;
  }
  if (startMs >= endMs) {
    setRangeNote('err', 'Start must be earlier than End.');
    return;
  }

  let requestedTimeframe = timeframeSelect ? timeframeSelect.value : 'auto';
  if (requestedTimeframe === 'custom') {
    const customVal = customTfInput ? customTfInput.value.trim() : '';
    if (!customVal) {
      setRangeNote('err', 'Enter a custom timeframe (e.g. 2m, 12h, 3D).');
      return;
    }
    requestedTimeframe = customVal;
  }

  fetchBtn.disabled = true;
  setRangeNote('', 'Fetching range — reading chart, auto-panning if needed…');
  setStatus('', 'Fetching historical range…');
  try {
    const res = await sendToContent({ type: 'TV_FETCH_RANGE', startMs, endMs, requestedTimeframe });
    if (res?.ok && res.data) {
      const d = res.data;
      downloadCSV(d.filename, d.csv);
      const warnText = (d.warnings ?? []).map((w) => `  • ${w}`).join('\n');
      // Show a compact summary in the textarea (full data is in the CSV file).
      output.value = [
        `// Exported ${d.count} candle(s) -> ${d.filename}`,
        `// ${d.symbol} ${d.timeframe} · method: ${d.method ?? 'data-model'}`,
        // Columns: Symbol, Timeframe, Datetime, Open, High, Low, Close, [indicators…]
        `// Columns: Symbol, Timeframe, Datetime, Open, High, Low, Close` +
          (d.indicatorColumns?.length ? `, ${d.indicatorColumns.join(', ')}` : ' (no indicator history)'),
        ...(d.timestampsEstimated
          ? ['// ⚠ TIMESTAMPS WERE ESTIMATED from sweep position + timeframe — verify the Datetime column.']
          : []),
        ...(warnText ? ['// Warnings:', ...warnText.split('\n').map((l) => `// ${l.replace(/^  • /, '')}`)] : []),
        pretty({ symbol: d.symbol, timeframe: d.timeframe, count: d.count, preview: d.preview }),
      ].join('\n');
      setRangeNote(d.warnings?.length ? 'warn' : 'ok',
        d.timestampsEstimated
          ? `Saved ${d.filename} (${d.count} rows) — timestamps ESTIMATED, verify the Datetime column.`
          : d.warnings?.length
            ? `Saved ${d.filename} (${d.count} rows) with ${d.warnings.length} warning(s) — see output.`
            : `Saved ${d.filename} (${d.count} rows).`);
      setStatus('ok', `Exported ${d.count} ${d.symbol} ${d.timeframe} rows.`);
    } else {
      // Structured errors: invalid range, chart not ready, sweep gates, etc.
      const detail = [
        `// ${res?.error ?? 'FETCH_FAILED'}`,
        `// ${res?.message ?? 'Unknown error.'}`,
        '',
      ];
      const d = res?.data?.diagnostics;
      if (d) {
        detail.push('// --- sweep diagnostics ---');
        detail.push(`// method: ${d.method ?? 'n/a'}  sweepSteps: ${d.sweepSteps ?? 'n/a'}`);
        if (d.canvas) {
          detail.push(`// canvas: found=${d.canvas.found} layout=${d.canvas.layoutWidth}x${d.canvas.layoutHeight} ` +
            `attrs=${d.canvas.attrWidth}x${d.canvas.attrHeight} tag=${d.canvas.tag ?? '?'}`);
        }
        detail.push(`// dispatchOk: ${d.dispatchOk ?? 0}  seriesFoundSteps: ${d.seriesFoundSteps ?? 0}  ` +
          `ohlcReadSteps: ${d.ohlcReadSteps ?? 0}  distinctCandles: ${d.distinctCandles ?? 0}`);
        detail.push(`// legendChangedSteps: ${d.legendChangedSteps ?? 0}  ` +
          `(0 = the legend NEVER moved, so hovers are being ignored by TV)`);
        if (d.canvasLabels?.length) {
          detail.push(`// canvas candidates (${d.canvasCandidates ?? d.canvasLabels.length}): ` +
            `${d.canvasLabels.join(' | ')}`);
        }
        detail.push(`// responsiveCanvas: ${d.responsiveCanvas ?? 'none — no candidate moved the legend'}`);
        for (const p of d.canvasProbe ?? []) detail.push(`//   probe: ${p}`);
        detail.push(`// hoverTargets: ${(d.hoverTargets ?? []).join(', ') || 'none'}  ` +
          `axisTicks: ${d.axisTicks ?? 0}  keyboardFallbackRows: ${d.keyboardFallbackRows ?? 'n/a'}`);
        if (d.lastSeriesText) detail.push(`// lastSeriesText: ${d.lastSeriesText}`);
        detail.push('');
      }
      for (const w of res?.data?.warnings ?? []) detail.push(`// warning: ${w}`);
      if (res?.data?.symbol) {
        detail.push('');
        detail.push(pretty({ symbol: res.data.symbol, timeframe: res.data.timeframe, ...res.data.diagnostics }));
      }
      output.value = detail.join('\n');
      setRangeNote('err', `⚠ ${res?.error ?? 'FETCH_FAILED'} — see diagnostics in the box above.`);
      setStatus('err', `⚠ ${res?.error ?? 'Fetch failed'}`);
    }
  } catch (err) {
    setRangeNote('err', `⚠ ${err.message}`);
    setStatus('err', `⚠ ${err.message}`);
  } finally {
    fetchBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Live stream ticks (pushed by content.js)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  // Live progress for long range fetches (scrolling / formatting phases).
  if (msg.type === 'TV_FETCH_PROGRESS') {
    setRangeNote('', `${msg.detail ?? msg.phase ?? 'Working…'}`);
    return;
  }
  if (msg.type !== 'TV_STREAM_TICK') return;
  try {
    applyingRemoteTick = true;
    if (msg.ok) {
      render(msg.data, `● LIVE ${msg.data.symbol} ${msg.data.timeframe} · C ${msg.data.close ?? '—'}`);
      setStatus('live', `● LIVE ${msg.data.symbol} ${msg.data.timeframe} · ${msg.reason ?? 'tick'}`);
    } else {
      setStatus('err', `⚠ ${msg.error ?? 'Stream tick failed'} — waiting for chart…`);
    }
    // Keep the toggle reflecting the streaming tab even if user toggled elsewhere.
    if (!streamToggle.checked) streamToggle.checked = true;
  } finally {
    applyingRemoteTick = false;
  }
});

// ---------------------------------------------------------------------------
// Init: restore stream state + last payload for a smooth reopen
// ---------------------------------------------------------------------------

async function init() {
  captureBtn.addEventListener('click', onCapture);
  streamToggle.addEventListener('change', onStreamToggle);
  copyBtn.addEventListener('click', onCopy);
  downloadBtn.addEventListener('click', onDownload);
  fetchBtn.addEventListener('click', onFetchRange);
  diagnoseBtn.addEventListener('click', onDiagnose);

  if (timeframeSelect) {
    timeframeSelect.value = '3m';
    timeframeSelect.addEventListener('change', () => {
      if (timeframeSelect.value === 'custom') {
        customTfField.style.display = 'grid';
        customTfInput.focus();
      } else {
        customTfField.style.display = 'none';
      }
    });
  }

  // Sensible defaults: last 24h -> now (user adjusts per timeframe).
  try {
    const now = new Date();
    endInput.value = toLocalInputValue(now);
    startInput.value = toLocalInputValue(new Date(now.getTime() - 24 * 3600 * 1000));
  } catch { /* inputs stay empty — user picks manually */ }

  try {
    const tab = await getActiveTab();
    if (!tab || !isTradingViewUrl(tab.url)) {
      setStatus('err', 'Not on TradingView — open a chart tab first.');
      output.placeholder = 'Open a TradingView chart tab, then click "Capture Current Candle".';
      return;
    }
    // Reflect actual streaming state of this tab (frame-aware via sendToContent).
    try {
      const st = await sendToContent({ type: 'TV_STREAM_STATUS' }, { retargeted: true });
      streamToggle.checked = !!st?.streaming;
      if (st?.streaming) setStatus('live', '● Streaming live');
      else setStatus('ok', `Ready — ${new URL(tab.url).hostname}`);
    } catch {
      setStatus('', 'Ready — click Capture.');
    }

    // Auto-detect currently active chart timeframe and reflect in the selector
    try {
      const snap = await sendToContent({ type: 'TV_GET_SNAPSHOT' });
      if (snap?.ok && snap?.data?.timeframe && snap.data.timeframe !== 'unknown') {
        const activeTf = snap.data.timeframe;
        if (timeframeSelect) {
          const autoOpt = Array.from(timeframeSelect.options).find((o) => o.value === 'auto');
          if (autoOpt) autoOpt.textContent = `Auto (Active: ${activeTf})`;
        }
      }
    } catch { /* keep default auto label */ }

    // Restore last payload for continuity across popup opens.
    const { tvLastSnapshot } = await chrome.storage.local.get('tvLastSnapshot');
    if (tvLastSnapshot && !output.value) render(tvLastSnapshot, 'Restored last snapshot — capture for fresh data.');
  } catch (err) {
    setStatus('err', `Init failed: ${err.message}`);
  }
}

init();
