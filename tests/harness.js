/**
 * tests/harness.js — boots a simulated TradingView chart page in jsdom so
 * content.js can be exercised end-to-end without a browser.
 *
 * The simulated page deliberately mirrors the user's real build:
 *   - NO data-name attributes on the legend (renamed build)
 *   - series row built from split nodes -> concatenated textContent
 *   - indicator rows as plain divs with .title / .value spans
 *   - a price canvas whose crosshair ACTUALLY updates the legend on hover
 *
 * Options:
 *   canvasLayout:false   -> canvas has a 0x0 layout box (hidden-buffer bug)
 *   workingCrosshair:false -> no hover listeners (crosshair cannot move)
 *   model:true           -> install a fake window.__TV_EXTRACTOR__ data model
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const TF_MS = 5 * 60 * 1000; // 5m, matching the toolbar button below

/** Deterministic candle series, oldest first, ending at endMs. */
function makeCandles(n, endMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const epochMs = endMs - (n - 1 - i) * TF_MS;
    const base = 72000 + i * 12.5;
    out.push({
      epochMs,
      open: base,
      high: base + 40,
      low: base - 35,
      close: base + 22,
      vol: 200 + i,
      volMa: 180 + i,
    });
  }
  return out;
}

const num = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Local-time "YYYY-MM-DD HH:MM:SS" — matches what TradingView's hover label
 * shows in the user's own timezone, and what Date.parse() treats as local.
 * (toISOString() is UTC; parsing that as local shifts by the UTC offset.)
 */
function fmtLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function buildHTML({ candles }) {
  const last = candles[candles.length - 1];
  return `<!doctype html>
<html><head><title>SENSEX ${num(last.close)} &mdash; TradingView</title></head>
<body>
  <header id="header-toolbar-intervals">
    <button data-value="60" aria-pressed="false">1h</button>
    <button data-value="5" aria-pressed="true">5m</button>
  </header>
  <div class="chart-container" data-name="chart-container">
    <canvas id="price" width="2000" height="800"></canvas>
    <!-- renamed build: legend identifiable only via class*="legend" -->
    <div class="legendWrapper">
      <div class="legend" id="legend">
        <div class="seriesRow" id="seriesRow">
          <span>SENSEX</span><span>O</span><span id="sO" class="value">${num(last.open)}</span><span>H</span><span id="sH" class="value">${num(last.high)}</span><span>L</span><span id="sL" class="value">${num(last.low)}</span><span>C</span><span id="sC" class="value">${num(last.close)}</span><span id="sChg">+183.07 (+0.25%)</span>
        </div>
        <div class="indRow" id="indVol"><span class="t">Vol</span><span id="v1" class="value">244.41 K</span><span id="v2" class="value">134.28 K</span></div>
        <div class="indRow" id="indMB"><span class="t">MktBreadth</span><span id="m1" class="value">-41.31</span><span id="m2" class="value">-53.64</span><span id="m3" class="value">-55.40</span><span id="m4" class="value">-5.30</span></div>
      </div>
    </div>
    <div class="timeAxisHighlight" id="hoverTime">${fmtLocal(last.epochMs)}</div>
  </div>
</body></html>`;
}

function stubRect(el, x, y, w, h) {
  el.getBoundingClientRect = () => ({
    x, y, left: x, top: y, width: w, height: h,
    right: x + w, bottom: y + h, toJSON() { return this; },
  });
}

function bootTVDom(opts = {}) {
  const {
    candleCount = 60,
    canvasLayout = true,
    workingCrosshair = true,
    model = false,
    hoverTimeVisible = true,
    decoyCanvas = false,
  } = opts;

  const endMs = Math.floor(Date.now() / TF_MS) * TF_MS;
  const candles = makeCandles(candleCount, endMs);

  const vc = new (require('jsdom').VirtualConsole)();
  vc.on('jsdomError', () => { /* silence "not implemented" noise */ });

  const dom = new JSDOM(buildHTML({ candles }), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const win = dom.window;
  const doc = win.document;

  // ---- PointerEvent polyfill (jsdom does not implement it) -----------------
  if (typeof win.PointerEvent === 'undefined') {
    win.PointerEvent = class PointerEvent extends win.MouseEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? '';
        this.isPrimary = init.isPrimary ?? false;
        this.width = init.width ?? 1;
        this.height = init.height ?? 1;
        this.pressure = init.pressure ?? 0;
      }
    };
  }

  // ---- Layout: jsdom does no layout, so we paint the rects in ourselves ---
  const canvas = doc.getElementById('price');
  stubRect(canvas, 0, 0, canvasLayout ? 1000 : 0, canvasLayout ? 400 : 0);
  // hoverTimeVisible:false must REMOVE the node (a canvas-rendered time axis
  // has no DOM at all). display:none would still expose textContent.
  const hoverNode = doc.getElementById('hoverTime');
  if (!hoverTimeVisible && hoverNode) hoverNode.remove();

  // decoyCanvas:true reproduces the user's real page — a LARGER canvas stacked
  // on top of the pane with no crosshair listener, so naive "biggest canvas"
  // selection lands on the wrong surface and the legend never moves.
  let decoy = null;
  if (decoyCanvas) {
    decoy = doc.createElement('canvas');
    decoy.id = 'decoy';
    decoy.width = 2000;
    decoy.height = 1000;
    stubRect(decoy, 0, 0, canvasLayout ? 1000 : 0, canvasLayout ? 500 : 0);
    canvas.parentNode.insertBefore(decoy, canvas.nextSibling);
  }

  // elementFromPoint: return the TOPMOST canvas while the pointer is over it.
  doc.elementFromPoint = (x, y) => {
    const top = decoy ?? canvas;
    const r = top.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return top;
    return null;
  };

  // ---- Simulated crosshair: THIS is what real TradingView does -----------
  const setLegend = (c) => {
    doc.getElementById('sO').textContent = num(c.open);
    doc.getElementById('sH').textContent = num(c.high);
    doc.getElementById('sL').textContent = num(c.low);
    doc.getElementById('sC').textContent = num(c.close);
    doc.getElementById('v1').textContent = `${c.vol.toFixed(2)} K`;
    doc.getElementById('v2').textContent = `${c.volMa.toFixed(2)} K`;
    doc.getElementById('m1').textContent = c.open > 72500 ? '12.50' : '-12.50';
    doc.getElementById('m2').textContent = '-53.64';
    doc.getElementById('m3').textContent = '-55.40';
    doc.getElementById('m4').textContent = '-5.30';
    if (hoverTimeVisible) doc.getElementById('hoverTime').textContent = fmtLocal(c.epochMs);
  };
  setLegend(candles[candles.length - 1]);

  if (workingCrosshair) {
    const onHover = (e) => {
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const idx = Math.max(0, Math.min(candles.length - 1, Math.floor(fx * candles.length)));
      setLegend(candles[idx]);
    };
    canvas.addEventListener('pointermove', onHover);
    canvas.addEventListener('mousemove', onHover);
  }

  // ---- chrome.* stub -------------------------------------------------------
  const listeners = [];
  const sent = [];
  win.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); },
      getURL: (p) => `chrome-extension://test/${p}`,
    },
    storage: { local: { set: () => Promise.resolve(), get: () => Promise.resolve({}) } },
  };

  // ---- Optional: fake internal data model (Method A reachable) -------------
  if (model) {
    let currentTf = opts.timeframe ?? '5';
    win.__TV_EXTRACTOR__ = {
      __ready: true,
      version: '2.0.0',
      getSnapshot: () => ({
        source: 'page-internal-model', symbol: 'SENSEX', timeframe: currentTf,
        bars: candles.slice(-5).map((c) => ({ epochMs: c.epochMs, iso: null, open: c.open, high: c.high, low: c.low, close: c.close })),
        studies: opts.studies ?? [],
      }),
      getRange: (startMs, endMs) => {
        const all = candles.map((c) => ({
          epochMs: c.epochMs, iso: null,
          open: c.open, high: c.high, low: c.low, close: c.close,
        }));
        return {
          ok: true, source: 'page-internal-model', symbol: 'SENSEX', timeframe: currentTf,
          bars: all.filter((b) => b.epochMs >= startMs && b.epochMs <= endMs),
          allBars: all,
          studies: opts.studies ?? [],
          allStudies: opts.studies ?? [],
          totalLoaded: all.length,
          earliestMs: all[0].epochMs,
          latestMs: all[all.length - 1].epochMs,
        };
      },
      scrollChart: () => ({ ok: false, error: 'SCROLL_API_NOT_FOUND' }),
      setResolution: (res) => {
        currentTf = res;
        return { ok: true, resolution: res };
      },
    };
  }

  // ---- Load the extension's content script ---------------------------------
  win.eval(CONTENT_SRC);

  /** Send a message exactly like the popup does; resolves with sendResponse. */
  function send(msg) {
    return new Promise((resolve) => {
      let settled = false;
      for (const fn of listeners) {
        try {
          fn(msg, {}, (value) => { settled = true; resolve(value); });
        } catch (err) { /* keep other listeners */ }
      }
      if (!settled && listeners.length === 0) resolve(undefined);
    });
  }

  return { dom, win, doc, canvas, candles, send, sent, endMs };
}

module.exports = { bootTVDom, makeCandles, TF_MS };
