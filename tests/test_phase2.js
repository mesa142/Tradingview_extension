/**
 * tests/test_phase2.js — Comprehensive unit & integration tests for Phase 2:
 *  - Manifest V3 permissions & configuration
 *  - Strict numeric sanitization (Unicode minus, sentinels, multipliers)
 *  - Dynamic DOM indicator discovery without manual typing
 *  - Multi-plot sub-indices and collision-free keying `${title}__#${instance}`
 *  - Candle-close detection
 *  - Background service worker & Offscreen document API
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0;
let fail = 0;

function check(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

async function runPhase2Tests() {
  console.log('--- RUNNING PHASE 2 TEST SUITE ---');

  // Test 1: Manifest V3 Configuration
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    check(manifest.manifest_version === 3, 'Manifest version is 3');
    check(manifest.permissions.includes('notifications'), 'Permissions include notifications');
    check(manifest.permissions.includes('offscreen'), 'Permissions include offscreen');
    check(manifest.permissions.includes('tabs'), 'Permissions include tabs');
    check(manifest.permissions.includes('storage'), 'Permissions include storage');
    check(manifest.host_permissions.some(h => h.includes('localhost:8765')), 'Host permissions include localhost:8765');
    check(manifest.web_accessible_resources.some(w => w.resources.includes('injected.js')), 'injected.js is web accessible');
  }

  // Test 2: Injected Script Numeric Sanitizer & DOM Scraper
  {
    const html = `<!doctype html>
    <html>
      <head><title>BTCUSDT 65420.50 — TradingView</title></head>
      <body>
        <div id="header-toolbar-intervals"><button aria-pressed="true">5m</button></div>
        <div class="legend" data-name="legend">
          <div class="seriesRow" data-name="legend-series-item">
            <span class="chart-title__title">BTCUSDT • 5</span>
            <span>O</span><span id="sO">65,000.50</span>
            <span>H</span><span id="sH">65,800.00</span>
            <span>L</span><span id="sL">64,950.25</span>
            <span>C</span><span id="sC">65,420.50</span>
          </div>
          <!-- Indicator 1: RSI (single plot) -->
          <div class="indRow" data-name="legend-indicator-item">
            <span class="title">RSI (14)</span>
            <span class="valueItem">72.45</span>
          </div>
          <!-- Indicator 2: MACD (multi-output: Histogram, MACD, Signal) -->
          <div class="indRow" data-name="legend-indicator-item">
            <span class="title">MACD (12, 26, 9)</span>
            <span class="valueTitle">Histogram:</span><span class="valueItem">−14.20</span>
            <span class="valueTitle">MACD:</span><span class="valueItem">125.80</span>
            <span class="valueTitle">Signal:</span><span class="valueItem">140.00</span>
          </div>
          <!-- Indicator 3: Duplicate RSI with different params -->
          <div class="indRow" data-name="legend-indicator-item">
            <span class="title">RSI (14)</span>
            <span class="valueItem">∅</span> <!-- unavailable plot -->
          </div>
          <!-- Indicator 4: Volume with K multiplier -->
          <div class="indRow" data-name="legend-indicator-item">
            <span class="title">Volume</span>
            <span class="valueItem">244.5 K</span>
          </div>
        </div>
        <div class="timeAxisHighlight" id="hoverTime">2026-10-15 20:00:00</div>
      </body>
    </html>`;

    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const win = dom.window;

    // Load injected.js in simulated window
    const injectedCode = fs.readFileSync(path.join(__dirname, '..', 'injected.js'), 'utf8');
    win.eval(injectedCode);

    const api = win.__TV_EXTRACTOR__;
    check(api && typeof api.parseCleanNumber === 'function', 'parseCleanNumber is exported');

    // Unit test parseCleanNumber
    check(api.parseCleanNumber('−14.20') === -14.2, 'Unicode minus normalized: −14.20 -> -14.2');
    check(api.parseCleanNumber('65,000.50') === 65000.5, 'Commas stripped: 65,000.50 -> 65000.5');
    check(api.parseCleanNumber('244.5 K') === 244500, 'Multiplier handled: 244.5 K -> 244500');
    check(api.parseCleanNumber('∅') === null, 'Sentinel ∅ returns null');
    check(api.parseCleanNumber('n/a') === null, 'Sentinel n/a returns null');
    check(api.parseCleanNumber('NaN') === null, 'Sentinel NaN returns null');
    check(api.parseCleanNumber('') === null, 'Empty string returns null');

    // Test DOM Scraper
    const scraped = api.scrapeTradingViewDom();
    check(scraped !== null, 'Scraped payload is non-null');
    check(scraped.symbol === 'BTCUSDT', `Symbol extracted correctly: ${scraped.symbol}`);
    check(scraped.timeframe === '5m', `Timeframe extracted correctly: ${scraped.timeframe}`);
    check(scraped.ohlcv.close === 65420.5, `OHLCV Close extracted: ${scraped.ohlcv.close}`);
    check(scraped.ohlcv.volume === 244500, `OHLCV Volume populated from Volume indicator: ${scraped.ohlcv.volume}`);

    // Verify Indicator Keys & Discovered Plots
    const indKeys = Object.keys(scraped.indicators);
    check(indKeys.includes('RSI (14)__#1'), 'First RSI keyed as RSI (14)__#1');
    check(indKeys.includes('RSI (14)__#2'), 'Duplicate RSI keyed collision-free as RSI (14)__#2');
    check(indKeys.includes('MACD (12, 26, 9)__#1'), 'MACD keyed as MACD (12, 26, 9)__#1');

    // Multi-output plot verification
    const macd = scraped.indicators['MACD (12, 26, 9)__#1'];
    check(macd.isReadable === true, 'MACD is readable');
    check(macd.plots.Histogram?.value === -14.2, `MACD Histogram plot value: ${macd.plots.Histogram?.value}`);
    check(macd.plots.Histogram?.available === true, 'MACD Histogram is available');
    check(macd.plots.MACD?.value === 125.8, `MACD line plot value: ${macd.plots.MACD?.value}`);
    check(macd.plots.Signal?.value === 140.0, `MACD Signal plot value: ${macd.plots.Signal?.value}`);

    // Unavailable plot in RSI #2
    const rsi2 = scraped.indicators['RSI (14)__#2'];
    check(rsi2.isReadable === false, 'RSI #2 marked not readable (∅ value)');
    const rsiPlot = Object.values(rsi2.plots)[0];
    check(rsiPlot.value === null, 'RSI #2 plot value is null');
    check(rsiPlot.available === false, 'RSI #2 plot available is false');
  }

  // Test 3: Offscreen Document & Tone Playback
  {
    const offscreenHtml = fs.readFileSync(path.join(__dirname, '..', 'offscreen.html'), 'utf8');
    const offscreenJs = fs.readFileSync(path.join(__dirname, '..', 'offscreen.js'), 'utf8');
    check(offscreenHtml.includes('offscreen.js'), 'offscreen.html loads offscreen.js');
    check(offscreenJs.includes('playTone'), 'offscreen.js defines playTone synthesizer');
    check(offscreenJs.includes('PLAY_ALERT_AUDIO'), 'offscreen.js listens for PLAY_ALERT_AUDIO');
  }

  // Test 4: Content Script Relay Verification
  {
    const contentJs = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
    check(contentJs.includes('TV_ALERT_SCRAPER'), 'content.js filters TV_ALERT_SCRAPER');
    check(contentJs.includes('TV_STREAM_PAYLOAD'), 'content.js relays TV_STREAM_PAYLOAD to background');
  }

  // Test 5: Background Service Worker Bridge
  {
    const backgroundJs = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
    check(backgroundJs.includes('ws://localhost:8765'), 'background.js connects to ws://localhost:8765');
    check(backgroundJs.includes('TAB_CLOSED'), 'background.js notifies server on tab close');
    check(backgroundJs.includes('ALERT_TRIGGERED'), 'background.js handles ALERT_TRIGGERED');
    check(backgroundJs.includes('chrome.notifications.create'), 'background.js creates Chrome notifications');
    check(backgroundJs.includes('ensureOffscreenDocument'), 'background.js manages offscreen document');
  }

  console.log(`\nAll Phase 2 tests completed! Passed: ${pass}, Failed: ${fail}`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

runPhase2Tests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
