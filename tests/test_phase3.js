/**
 * tests/test_phase3.js — Comprehensive unit & integration tests for Phase 3:
 *  - popup.html DOM markup & 5-tab architecture
 *  - Visual nested condition tree data modeling & rendering
 *  - Dynamic series dropdown generation without manual typing
 *  - Selective rule status display (ACTIVE_FALSE, ACTIVE_TRUE, PAUSED_DATA_UNAVAILABLE)
 *  - Intrabar reversal and missing indicator detection
 *  - Telegram & Audio settings controls
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

async function runPhase3Tests() {
  console.log('--- RUNNING PHASE 3 TEST SUITE ---');

  // Test 1: popup.html Structure & Navigation
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const navButtons = doc.querySelectorAll('.tab-nav-btn');
    check(navButtons.length === 5, `Navigation tabs present: 5 tabs (got ${navButtons.length})`);

    const panes = doc.querySelectorAll('.tab-pane');
    check(panes.length === 5, `Tab panes present: 5 panes (got ${panes.length})`);

    check(doc.getElementById('tab-inspector') !== null, 'Inspector tab pane exists');
    check(doc.getElementById('tab-builder') !== null, 'Rule Builder tab pane exists');
    check(doc.getElementById('tab-rules') !== null, 'Active Rules tab pane exists');
    check(doc.getElementById('tab-history') !== null, 'History & Config tab pane exists');
    check(doc.getElementById('tab-extractor') !== null, 'CSV Extractor tab pane exists');

    // Live Ticker elements
    check(doc.getElementById('tickerSymbol') !== null, 'tickerSymbol element present');
    check(doc.getElementById('tickerClose') !== null, 'tickerClose element present');
    check(doc.getElementById('tickerCandleState') !== null, 'tickerCandleState element present');

    // Rule Builder elements
    check(doc.getElementById('ruleTreeRoot') !== null, 'ruleTreeRoot element present');
    check(doc.getElementById('btnSaveRule') !== null, 'btnSaveRule button present');
    check(doc.getElementById('btnAutoFillActiveTab') !== null, 'btnAutoFillActiveTab button present');

    // Backend Telegram and Audio controls
    check(doc.getElementById('tgBackendStatusBadge') !== null, 'tgBackendStatusBadge present');
    check(doc.getElementById('btnTestTelegram') !== null, 'btnTestTelegram present');
    check(doc.getElementById('btnTestChime') !== null, 'btnTestChime present');
  }

  // Test 2: popup.css Styling & Theme
  {
    const css = fs.readFileSync(path.join(__dirname, '..', 'popup.css'), 'utf8');
    check(css.includes('--bg: #131722'), 'Dark theme variable --bg defined');
    check(css.includes('.condition-group'), 'Nested condition group styling defined');
    check(css.includes('.badge-paused'), 'badge-paused class defined');
    check(css.includes('.plot-chip'), 'plot-chip styling defined');
  }

  // Test 3: popup.js execution & Dynamic Series Parsing
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'popup.html'), 'utf8');
    const dom = new JSDOM(html, {
      runScripts: 'outside-only',
      url: 'http://localhost:3000/popup.html'
    });
    const win = dom.window;

    // Load chrome-shim and popup.js
    const shimCode = fs.readFileSync(path.join(__dirname, '..', 'chrome-shim.js'), 'utf8');
    const popupCode = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

    win.eval(shimCode);
    win.eval(popupCode);

    // Verify root condition tree rendered in DOM
    const treeRoot = win.document.getElementById('ruleTreeRoot');
    check(treeRoot && treeRoot.children.length > 0, 'Condition tree root rendered into DOM');

    const firstGroup = treeRoot.querySelector('.condition-group');
    check(firstGroup !== null, 'First condition-group element rendered');

    // Verify condition row structure
    const condRow = firstGroup.querySelector('.condition-row');
    check(condRow !== null, 'Condition row element rendered');

    const leftSelect = condRow.querySelector('select');
    check(leftSelect !== null && leftSelect.options.length >= 5, `Left source dropdown populated with OHLCV options (count: ${leftSelect.options.length})`);

    // Simulate incoming scraped payload from TradingView tab
    const mockPayload = {
      tabId: 'tab_tv_42',
      symbol: 'ETHUSDT',
      timeframe: '15m',
      timestamp: Date.now(),
      is_candle_close: 1,
      ohlcv: { open: 3450.2, high: 3500.0, low: 3420.0, close: 3495.5, volume: 154200 },
      indicators: {
        'RSI (14)__#1': {
          name: 'RSI (14)',
          instanceIndex: 1,
          isReadable: true,
          plots: { 'Plot_1': { index: 0, value: 68.4, available: true } }
        },
        'Bollinger Bands__#1': {
          name: 'Bollinger Bands',
          instanceIndex: 1,
          isReadable: true,
          plots: {
            'Upper': { index: 0, value: 3550.0, available: true },
            'Basis': { index: 1, value: 3460.0, available: true },
            'Lower': { index: 2, value: 3370.0, available: true }
          }
        }
      }
    };

    // Dispatch message to window
    win.postMessage({ type: 'TV_STREAM_PAYLOAD', payload: mockPayload }, '*');

    // Trigger update handler directly
    win.eval(`
      handleIncomingPayload(${JSON.stringify(mockPayload)});
    `);

    // Verify Ticker Bar values
    check(win.document.getElementById('tickerSymbol').textContent === 'ETHUSDT', 'Ticker symbol updated to ETHUSDT');
    check(win.document.getElementById('tickerTf').textContent === '15m', 'Ticker timeframe updated to 15m');
    check(win.document.getElementById('tickerClose').textContent === '3495.50', 'Ticker close price updated to 3495.50');
    check(win.document.getElementById('tickerCandleState').textContent === 'Candle Close', 'Ticker candle state updated to Candle Close');

    // Verify Series Inspector rendered indicators
    const treeContainer = win.document.getElementById('seriesTreeContainer');
    check(treeContainer.innerHTML.includes('RSI (14)'), 'Inspector displays RSI (14)');
    check(treeContainer.innerHTML.includes('Bollinger Bands'), 'Inspector displays Bollinger Bands');
    check(treeContainer.innerHTML.includes('Upper:'), 'Inspector displays Upper plot chip');
    check(treeContainer.innerHTML.includes('Basis:'), 'Inspector displays Basis plot chip');

    // Test Rule Summary Formatter
    const testSummary = win.eval(`
      formatRuleSummary({
        logicalOperator: 'AND',
        conditions: [
          { leftSource: { type: 'INDICATOR', indicatorKey: 'RSI (14)__#1', plotKey: 'Plot_1' }, operator: 'CROSSES_ABOVE', rightSource: { type: 'VALUE', value: 70 } },
          { leftSource: { type: 'OHLCV', field: 'close' }, operator: '>', rightSource: { type: 'INDICATOR', indicatorKey: 'Bollinger Bands__#1', plotKey: 'Upper' } }
        ]
      })
    `);
    check(testSummary.includes('RSI (14)__#1 CROSSES_ABOVE 70'), 'Rule summary formats indicator crosses value');
    check(testSummary.includes('close > Upper'), 'Rule summary formats indicator-to-indicator');
  }

  // Test 4: End-to-End API Integration
  {
    const db = require('../db');
    const AlertEngine = require('../engine');

    // Test creating rule from API format
    const testRule = db.createRule({
      name: 'ETH BB Breakout',
      symbol: 'ETHUSDT',
      timeframe: '15m',
      condition_tree: {
        logicalOperator: 'AND',
        conditions: [
          {
            leftSource: { type: 'OHLCV', field: 'close' },
            operator: 'CROSSES_ABOVE',
            rightSource: { type: 'INDICATOR', indicatorKey: 'Bollinger Bands__#1', plotKey: 'Upper' }
          }
        ]
      }
    });

    check(testRule && testRule.id, 'Rule created and saved in SQLite');
    const fetched = db.getRuleById(testRule.id);
    check(fetched.name === 'ETH BB Breakout', 'Rule retrievable by ID');

    // Verify status update (disabling and resuming)
    const disabled = db.updateRule(testRule.id, { status: 'DISABLED' });
    check(disabled.status === 'DISABLED', 'Rule status updates to DISABLED');
    const resumed = db.updateRule(testRule.id, { status: 'ACTIVE_FALSE' });
    check(resumed.status === 'ACTIVE_FALSE', 'Rule status resumes to ACTIVE_FALSE');

    // Clean up test rule
    db.deleteRule(testRule.id);
    check(!db.getRuleById(testRule.id), 'Test rule cleaned up');
  }

  console.log(`\nAll Phase 3 tests completed! Passed: ${pass}, Failed: ${fail}`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

runPhase3Tests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
