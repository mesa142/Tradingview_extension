/**
 * tests/test_phase4.js — Comprehensive unit & integration tests for Phase 4 & 5:
 *  - Multi-Channel Dispatch (Telegram, Discord Embed, Generic Webhook)
 *  - Interactive Tick Simulation
 *  - High-Frequency Intrabar Reversal Resilience (Edge detection, alert preservation, re-trigger)
 *  - Multi-Tab Stream Isolation
 *  - Selective Auto-Pausing & Auto-Resumption Lifecycle
 */

'use strict';

const db = require('../db');
const AlertEngine = require('../engine');
const telegram = require('../telegram');

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

async function runPhase4Tests() {
  console.log('--- RUNNING PHASE 4 & 5 TEST SUITE ---');

  // Test 1: Multi-Channel Dispatch Formatting (Telegram & Discord)
  {
    const dummyAlertData = {
      rule: { name: 'BTC Breakout', symbol: 'BTCUSDT', timeframe: '5m' },
      alert: { id: 'alt_test_1', triggered_at: new Date().toISOString(), is_candle_close: 1 },
      snapshot: {
        ohlcv: { open: 65000, high: 65800, low: 64900, close: 65700, volume: 15400 },
        indicators: {
          'RSI (14)__#1': {
            name: 'RSI (14)',
            plots: { 'Plot_1': { value: 74.5, available: true } }
          }
        }
      }
    };

    // Format Telegram message
    const tgMsg = telegram.formatAlertMessage(dummyAlertData);
    check(tgMsg.includes('BTC Breakout'), 'Telegram message includes rule name');
    check(tgMsg.includes('BTCUSDT'), 'Telegram message includes symbol');
    check(tgMsg.includes('CANDLE CLOSE CONFIRMED'), 'Telegram message includes Candle Close tag');
    check(tgMsg.includes('74.5'), 'Telegram message includes RSI plot value');

    // Discord formatting check
    const discordRes = await telegram.sendDiscord('https://invalid-discord-url.test', dummyAlertData);
    check(discordRes.ok === false, 'Discord rejects non-Discord URL safely');
  }

  // Test 2: High-Frequency Intrabar Reversal Resilience
  {
    const engine = new AlertEngine();

    // Ensure no stale test rules from interrupted runs
    const existing = db.getRulesForSymbolTimeframe('TESTREVERSAL', '1m');
    for (const r of existing) db.deleteRule(r.id);

    // Create a Breakout Rule: close > 105
    const breakoutRule = db.createRule({
      name: 'Intrabar Reversal Stress Rule',
      symbol: 'TESTREVERSAL',
      timeframe: '1m',
      condition_tree: {
        logicalOperator: 'AND',
        conditions: [
          { leftSource: { type: 'OHLCV', field: 'close' }, operator: '>', rightSource: { type: 'VALUE', value: 105 } }
        ]
      }
    });

    engine.loadRulesFromDb();
    const tabId = 'tab_reversal_test';
    const triggeredEvents = [];
    engine.on('alertTriggered', (evt) => {
      triggeredEvents.push(evt);
    });

    // Tick 1: close = 100 (Condition is FALSE)
    engine.ingestPayload({
      tabId,
      symbol: 'TESTREVERSAL',
      timeframe: '1m',
      timestamp: 1000,
      is_candle_close: 0,
      ohlcv: { open: 100, high: 101, low: 99, close: 100, volume: 50 },
      indicators: {}
    });
    check(triggeredEvents.length === 0, 'Tick 1 (close=100): Rule does not trigger');
    check(engine.ruleStates.get(breakoutRule.id).status === 'ACTIVE_FALSE', 'Tick 1: Rule state is ACTIVE_FALSE');

    // Tick 2: close = 108 (Condition is TRUE -> Edge FALSE -> TRUE triggers alert!)
    engine.ingestPayload({
      tabId,
      symbol: 'TESTREVERSAL',
      timeframe: '1m',
      timestamp: 1001,
      is_candle_close: 0,
      ohlcv: { open: 100, high: 108, low: 99, close: 108, volume: 60 },
      indicators: {}
    });
    check(triggeredEvents.length === 1, 'Tick 2 (close=108): Rule triggers alert (FALSE -> TRUE edge)');
    check(triggeredEvents[0]?.rule?.name === 'Intrabar Reversal Stress Rule', 'Tick 2: Triggered alert matches rule name');
    check(engine.ruleStates.get(breakoutRule.id).status === 'ACTIVE_TRUE', 'Tick 2: Rule state is ACTIVE_TRUE');

    // Tick 3: close = 102 (Intrabar Reversal! Price falls back below 105 before candle close)
    engine.ingestPayload({
      tabId,
      symbol: 'TESTREVERSAL',
      timeframe: '1m',
      timestamp: 1002,
      is_candle_close: 0,
      ohlcv: { open: 100, high: 108, low: 99, close: 102, volume: 70 },
      indicators: {}
    });
    check(triggeredEvents.length === 1, 'Tick 3 (close=102): Reversal does not add extra alert');
    check(engine.ruleStates.get(breakoutRule.id).status === 'ACTIVE_FALSE', 'Tick 3: Intrabar reversal resets state to ACTIVE_FALSE');

    // Verify previously triggered alert remains permanently in SQLite
    const history = db.getTriggeredAlerts(10, 0, breakoutRule.id);
    check(history.length >= 1, `Previous alert preserved in SQLite history despite reversal (count: ${history.length})`);

    // Tick 4: close = 110 (Second breakout! Condition becomes TRUE again -> Re-triggers!)
    engine.ingestPayload({
      tabId,
      symbol: 'TESTREVERSAL',
      timeframe: '1m',
      timestamp: 1003,
      is_candle_close: 0,
      ohlcv: { open: 100, high: 110, low: 99, close: 110, volume: 80 },
      indicators: {}
    });
    check(triggeredEvents.length === 2, 'Tick 4 (close=110): Second breakout re-triggers successfully (count: 2)');
    check(engine.ruleStates.get(breakoutRule.id).status === 'ACTIVE_TRUE', 'Tick 4: Rule state is ACTIVE_TRUE');

    // Clean up
    db.deleteRule(breakoutRule.id);
  }

  // Test 3: Multi-Tab Simultaneous Stream Isolation
  {
    const engine = new AlertEngine();

    // Stream from Tab A (SOLUSDT 1m)
    engine.ingestPayload({
      tabId: 'tab_A',
      symbol: 'SOLUSDT',
      timeframe: '1m',
      timestamp: 2000,
      is_candle_close: 0,
      ohlcv: { open: 140, high: 142, low: 139, close: 141, volume: 100 },
      indicators: {}
    });

    // Stream from Tab B (AVAXUSDT 5m)
    engine.ingestPayload({
      tabId: 'tab_B',
      symbol: 'AVAXUSDT',
      timeframe: '5m',
      timestamp: 2000,
      is_candle_close: 0,
      ohlcv: { open: 25, high: 26, low: 24, close: 25.5, volume: 50 },
      indicators: {}
    });

    const tabs = engine.getConnectedTabs();
    check(tabs.length === 2, `Both tabs registered in connected tabs (count: ${tabs.length})`);

    const solBuf = engine.getRingBuffer('SOLUSDT', '1m');
    const avaxBuf = engine.getRingBuffer('AVAXUSDT', '5m');
    check(solBuf.length === 1 && solBuf[0].ohlcv.close === 141, 'SOL ring buffer isolated with SOL data');
    check(avaxBuf.length === 1 && avaxBuf[0].ohlcv.close === 25.5, 'AVAX ring buffer isolated with AVAX data');
  }

  // Test 4: Selective Auto-Pausing & Resumption on Missing Indicator
  {
    const engine = new AlertEngine();

    // Ensure no stale TESTIND rules
    const existingInd = db.getRulesForSymbolTimeframe('TESTIND', '1m');
    for (const r of existingInd) db.deleteRule(r.id);

    const indRule = db.createRule({
      name: 'RSI Missing Check Rule',
      symbol: 'TESTIND',
      timeframe: '1m',
      condition_tree: {
        logicalOperator: 'AND',
        conditions: [
          {
            leftSource: { type: 'INDICATOR', indicatorKey: 'RSI (14)__#1', plotKey: 'Plot_1' },
            operator: '>',
            rightSource: { type: 'VALUE', value: 50 }
          }
        ]
      }
    });

    engine.loadRulesFromDb();

    // Ingest payload WITHOUT RSI -> rule must transition to PAUSED_DATA_UNAVAILABLE
    engine.ingestPayload({
      tabId: 'tab_ind_test',
      symbol: 'TESTIND',
      timeframe: '1m',
      timestamp: 3000,
      ohlcv: { open: 50, high: 55, low: 48, close: 52, volume: 100 },
      indicators: {} // Missing RSI
    });

    const statePaused = engine.ruleStates.get(indRule.id);
    check(statePaused.status === 'PAUSED_DATA_UNAVAILABLE', 'Rule pauses when RSI indicator is missing');
    check(statePaused.missingReason.includes('RSI (14)__#1'), 'Missing reason identifies exact indicator');

    // Ingest payload WITH valid RSI -> rule must automatically resume to ACTIVE_FALSE
    engine.ingestPayload({
      tabId: 'tab_ind_test',
      symbol: 'TESTIND',
      timeframe: '1m',
      timestamp: 3001,
      ohlcv: { open: 50, high: 55, low: 48, close: 52, volume: 100 },
      indicators: {
        'RSI (14)__#1': {
          name: 'RSI (14)',
          plots: { 'Plot_1': { value: 45.0, available: true } }
        }
      }
    });

    const stateResumed = engine.ruleStates.get(indRule.id);
    check(stateResumed.status === 'ACTIVE_FALSE', 'Rule automatically resumes to ACTIVE_FALSE when valid data returns');

    db.deleteRule(indRule.id);
  }

  console.log(`\nAll Phase 4 & 5 tests completed! Passed: ${pass}, Failed: ${fail}`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

runPhase4Tests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
