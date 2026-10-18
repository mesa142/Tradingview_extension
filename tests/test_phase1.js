/**
 * test_phase1.js — Comprehensive unit & integration tests for Phase 1:
 *  - SQLite schemas & CRUD
 *  - 30-day retention pruning
 *  - Rolling ring-buffer lookbacks
 *  - Relational, Crossover, Momentum, and Relative Change operators
 *  - Recursive nested AND/OR condition evaluation
 *  - Strict data-availability & selective rule pausing
 *  - Intrabar reversal state machine
 *  - Tab unregistration handling
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Use a temporary database for isolation
const testDbPath = path.join(__dirname, 'test_alerts.sqlite');
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

const db = require('../db');
db.getDb(testDbPath);

const AlertEngine = require('../engine');
const telegram = require('../telegram');

console.log('--- RUNNING PHASE 1 TEST SUITE ---');
let passed = 0;
let total = 0;

function it(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

// 1. DATABASE & SETTINGS
it('DB: can create, read, update, and delete rules', () => {
  const rule = db.createRule({
    name: 'RSI Oversold',
    symbol: 'NSE:NIFTY',
    timeframe: '5m',
    condition_tree: {
      logicalOperator: 'AND',
      conditions: [
        {
          id: 'c1',
          leftSource: { type: 'INDICATOR', indicatorKey: 'RSI__#1', plotKey: 'Plot_1' },
          operator: '<',
          rightSource: { type: 'VALUE', value: 30 }
        }
      ]
    }
  });

  assert.strictEqual(rule.name, 'RSI Oversold');
  assert.strictEqual(rule.symbol, 'NSE:NIFTY');
  assert.strictEqual(rule.status, 'ACTIVE_FALSE');

  const fetched = db.getRuleById(rule.id);
  assert.ok(fetched);
  assert.strictEqual(fetched.id, rule.id);

  db.updateRule(rule.id, { name: 'RSI Deep Oversold' });
  const updated = db.getRuleById(rule.id);
  assert.strictEqual(updated.name, 'RSI Deep Oversold');

  const all = db.getAllRules();
  assert.ok(all.length >= 1);
});

it('DB: can record triggered alerts and prune history', () => {
  const rule = db.getAllRules()[0];
  const alert = db.recordTriggeredAlert({
    rule_id: rule.id,
    rule_name: rule.name,
    symbol: rule.symbol,
    timeframe: rule.timeframe,
    candle_timestamp: 1700000000000,
    is_candle_close: 1,
    snapshot: { ohlcv: { close: 100 }, indicators: {} }
  });

  assert.ok(alert.id);
  const alerts = db.getTriggeredAlerts(10, 0);
  assert.ok(alerts.length >= 1);

  // Snapshot recording
  const snapId = db.recordSnapshot({
    symbol: 'NSE:NIFTY',
    timeframe: '5m',
    timestamp: 1700000000000,
    is_candle_close: 1,
    ohlcv: { close: 22000 },
    indicators: {}
  });
  assert.ok(snapId);

  // Settings
  db.setSetting('telegram_bot_token', 'test_token_123');
  assert.strictEqual(db.getSetting('telegram_bot_token'), 'test_token_123');

  // Pruning
  const prune = db.pruneOldHistory(30);
  assert.strictEqual(typeof prune.prunedSnapshots, 'number');
  assert.strictEqual(typeof prune.prunedAlerts, 'number');
});

// 2. ENGINE: OPERATOR EVALUATION
it('Engine: Relational operators evaluate accurately', () => {
  const engine = new AlertEngine();
  const ring = [
    { ohlcv: { close: 105 }, indicators: {} }
  ];

  const condGt = {
    leftSource: { type: 'OHLCV', field: 'close' },
    operator: '>',
    rightSource: { type: 'VALUE', value: 100 }
  };
  assert.strictEqual(engine.evaluateLeafCondition(condGt, ring), true);

  const condLt = {
    leftSource: { type: 'OHLCV', field: 'close' },
    operator: '<',
    rightSource: { type: 'VALUE', value: 100 }
  };
  assert.strictEqual(engine.evaluateLeafCondition(condLt, ring), false);
});

it('Engine: Crossover operators (CROSSES_ABOVE & CROSSES_BELOW)', () => {
  const engine = new AlertEngine();
  // Bar 0: EMA fast 48 <= slow 50
  // Bar 1: EMA fast 52 > slow 50 -> CROSSES_ABOVE
  const ring = [
    {
      ohlcv: {},
      indicators: {
        'EMA_FAST__#1': { plots: { val: { value: 48, available: true } } },
        'EMA_SLOW__#2': { plots: { val: { value: 50, available: true } } }
      }
    },
    {
      ohlcv: {},
      indicators: {
        'EMA_FAST__#1': { plots: { val: { value: 52, available: true } } },
        'EMA_SLOW__#2': { plots: { val: { value: 50, available: true } } }
      }
    }
  ];

  const condCrossAbove = {
    leftSource: { type: 'INDICATOR', indicatorKey: 'EMA_FAST__#1', plotKey: 'val' },
    operator: 'CROSSES_ABOVE',
    rightSource: { type: 'INDICATOR', indicatorKey: 'EMA_SLOW__#2', plotKey: 'val' }
  };
  assert.strictEqual(engine.evaluateLeafCondition(condCrossAbove, ring), true);

  const condCrossBelow = {
    leftSource: { type: 'INDICATOR', indicatorKey: 'EMA_FAST__#1', plotKey: 'val' },
    operator: 'CROSSES_BELOW',
    rightSource: { type: 'INDICATOR', indicatorKey: 'EMA_SLOW__#2', plotKey: 'val' }
  };
  assert.strictEqual(engine.evaluateLeafCondition(condCrossBelow, ring), false);
});

it('Engine: Momentum & Relative Change (RISING, FALLING, PCT_CHANGE_GTE)', () => {
  const engine = new AlertEngine();
  const ring = [
    { ohlcv: { close: 100 }, indicators: {} },
    { ohlcv: { close: 102 }, indicators: {} },
    { ohlcv: { close: 105 }, indicators: {} }
  ];

  const condRising = {
    leftSource: { type: 'OHLCV', field: 'close' },
    operator: 'RISING',
    lookback: 2
  };
  assert.strictEqual(engine.evaluateLeafCondition(condRising, ring), true);

  const condFalling = {
    leftSource: { type: 'OHLCV', field: 'close' },
    operator: 'FALLING',
    lookback: 2
  };
  assert.strictEqual(engine.evaluateLeafCondition(condFalling, ring), false);

  // 100 to 105 is +5% change over 2 bars
  const condPctGte = {
    leftSource: { type: 'OHLCV', field: 'close' },
    operator: 'PCT_CHANGE_GTE',
    lookback: 2,
    rightSource: { type: 'VALUE', value: 4.5 }
  };
  assert.strictEqual(engine.evaluateLeafCondition(condPctGte, ring), true);

  const condPctGteTooHigh = {
    leftSource: { type: 'OHLCV', field: 'close' },
    operator: 'PCT_CHANGE_GTE',
    lookback: 2,
    rightSource: { type: 'VALUE', value: 6.0 }
  };
  assert.strictEqual(engine.evaluateLeafCondition(condPctGteTooHigh, ring), false);
});

it('Engine: Recursive nested AND/OR condition tree evaluation', () => {
  const engine = new AlertEngine();
  const ring = [
    {
      ohlcv: { close: 150 },
      indicators: {
        'RSI__#1': { plots: { main: { value: 25, available: true } } },
        'MACD__#1': { plots: { hist: { value: 1.2, available: true } } }
      }
    }
  ];

  const tree = {
    logicalOperator: 'AND',
    conditions: [
      {
        id: 'c1',
        leftSource: { type: 'INDICATOR', indicatorKey: 'RSI__#1', plotKey: 'main' },
        operator: '<',
        rightSource: { type: 'VALUE', value: 30 }
      },
      {
        logicalOperator: 'OR',
        conditions: [
          {
            id: 'c2',
            leftSource: { type: 'OHLCV', field: 'close' },
            operator: '<',
            rightSource: { type: 'VALUE', value: 100 }
          },
          {
            id: 'c3',
            leftSource: { type: 'INDICATOR', indicatorKey: 'MACD__#1', plotKey: 'hist' },
            operator: '>',
            rightSource: { type: 'VALUE', value: 0 }
          }
        ]
      }
    ]
  };

  // c1 is true (25 < 30) AND (c2 false [150 < 100] OR c3 true [1.2 > 0]) -> TRUE
  assert.strictEqual(engine.evaluateNode(tree, ring), true);
});

it('Engine: Strict Data Availability & Selective Rule Pausing', () => {
  const engine = new AlertEngine();

  // Clear existing rules from test db
  for (const r of db.getAllRules()) db.deleteRule(r.id);

  // Rule A requires RSI
  const ruleA = db.createRule({
    name: 'Rule A (RSI)',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    condition_tree: {
      logicalOperator: 'AND',
      conditions: [{
        leftSource: { type: 'INDICATOR', indicatorKey: 'RSI__#1', plotKey: 'plot1' },
        operator: '>',
        rightSource: { type: 'VALUE', value: 50 }
      }]
    }
  });

  // Rule B requires SMA
  const ruleB = db.createRule({
    name: 'Rule B (SMA)',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    condition_tree: {
      logicalOperator: 'AND',
      conditions: [{
        leftSource: { type: 'INDICATOR', indicatorKey: 'SMA__#1', plotKey: 'plot1' },
        operator: '>',
        rightSource: { type: 'VALUE', value: 100 }
      }]
    }
  });

  engine.loadRulesFromDb();

  // Stream frame where SMA is valid, but RSI is null/unavailable
  engine.ingestPayload({
    symbol: 'BTCUSDT',
    timeframe: '1m',
    tabId: 'tab_1',
    ohlcv: { close: 105 },
    indicators: {
      'RSI__#1': { plots: { plot1: { value: null, available: false } } },
      'SMA__#1': { plots: { plot1: { value: 110, available: true } } }
    }
  });

  // Rule A MUST transition to PAUSED_DATA_UNAVAILABLE naming RSI
  const stateA = db.getRuleById(ruleA.id);
  assert.strictEqual(stateA.status, 'PAUSED_DATA_UNAVAILABLE');
  assert.ok(stateA.missing_reason.includes('RSI__#1'));

  // Rule B MUST NOT pause! It should evaluate and trigger since SMA 110 > 100
  const stateB = db.getRuleById(ruleB.id);
  assert.strictEqual(stateB.status, 'ACTIVE_TRUE');
});

it('Engine: Intrabar Reversal and False->True edge detection', () => {
  const engine = new AlertEngine();
  for (const r of db.getAllRules()) db.deleteRule(r.id);

  const rule = db.createRule({
    name: 'Breakout 100',
    symbol: 'ETHUSDT',
    timeframe: '5m',
    condition_tree: {
      logicalOperator: 'AND',
      conditions: [{
        leftSource: { type: 'OHLCV', field: 'close' },
        operator: '>',
        rightSource: { type: 'VALUE', value: 100 }
      }]
    }
  });

  engine.loadRulesFromDb();
  let triggerCount = 0;
  engine.on('alertTriggered', () => { triggerCount++; });

  // Tick 1: Price 98 (Condition FALSE)
  engine.ingestPayload({
    symbol: 'ETHUSDT',
    timeframe: '5m',
    tabId: 'tab_2',
    ohlcv: { close: 98 },
    indicators: {}
  });
  assert.strictEqual(triggerCount, 0);
  assert.strictEqual(db.getRuleById(rule.id).status, 'ACTIVE_FALSE');

  // Tick 2: Price breaks to 102 (Condition TRUE -> FALSE to TRUE edge)
  engine.ingestPayload({
    symbol: 'ETHUSDT',
    timeframe: '5m',
    tabId: 'tab_2',
    ohlcv: { close: 102 },
    indicators: {}
  });
  assert.strictEqual(triggerCount, 1);
  assert.strictEqual(db.getRuleById(rule.id).status, 'ACTIVE_TRUE');

  // Tick 3: Price still at 103 (TRUE -> TRUE, must NOT re-trigger)
  engine.ingestPayload({
    symbol: 'ETHUSDT',
    timeframe: '5m',
    tabId: 'tab_2',
    ohlcv: { close: 103 },
    indicators: {}
  });
  assert.strictEqual(triggerCount, 1);

  // Tick 4: INTRABAR REVERSAL: Price dips to 99 (TRUE -> FALSE)
  // Rule resets to ACTIVE_FALSE
  engine.ingestPayload({
    symbol: 'ETHUSDT',
    timeframe: '5m',
    tabId: 'tab_2',
    ohlcv: { close: 99 },
    indicators: {}
  });
  assert.strictEqual(triggerCount, 1);
  assert.strictEqual(db.getRuleById(rule.id).status, 'ACTIVE_FALSE');

  // Tick 5: Price spikes back to 104 (FALSE -> TRUE again!)
  // Must re-trigger!
  engine.ingestPayload({
    symbol: 'ETHUSDT',
    timeframe: '5m',
    tabId: 'tab_2',
    ohlcv: { close: 104 },
    indicators: {}
  });
  assert.strictEqual(triggerCount, 2);
  assert.strictEqual(db.getRuleById(rule.id).status, 'ACTIVE_TRUE');
});

it('Engine: Tab unregistration pauses affected rules when no stream remains', () => {
  const engine = new AlertEngine();
  for (const r of db.getAllRules()) db.deleteRule(r.id);

  const rule = db.createRule({
    name: 'SOL Alert',
    symbol: 'SOLUSDT',
    timeframe: '15m',
    condition_tree: {
      logicalOperator: 'AND',
      conditions: [{
        leftSource: { type: 'OHLCV', field: 'close' },
        operator: '>',
        rightSource: { type: 'VALUE', value: 20 }
      }]
    }
  });

  engine.loadRulesFromDb();

  // Tab connects & streams
  engine.ingestPayload({
    symbol: 'SOLUSDT',
    timeframe: '15m',
    tabId: 'tab_sol_1',
    ohlcv: { close: 25 },
    indicators: {}
  });

  assert.strictEqual(db.getRuleById(rule.id).status, 'ACTIVE_TRUE');

  // Tab unregisters
  engine.unregisterTab('tab_sol_1');

  // Rule is now paused with tab closure reason
  const pausedRule = db.getRuleById(rule.id);
  assert.strictEqual(pausedRule.status, 'PAUSED_DATA_UNAVAILABLE');
  assert.ok(pausedRule.missing_reason.includes('closed'));
});

it('Telegram: formats alert notification message properly', () => {
  const sampleAlert = {
    rule: { name: 'SuperTrend Buy', symbol: 'BTCUSDT', timeframe: '1h' },
    alert: { is_candle_close: 1, triggered_at: new Date().toISOString() },
    snapshot: {
      ohlcv: { open: 65000, high: 65500, low: 64900, close: 65450, volume: 1200 },
      indicators: {
        'SuperTrend__#1': {
          name: 'SuperTrend',
          plots: { 'Up Trend': { value: 64800 } }
        }
      }
    }
  };

  const formatted = telegram.formatAlertMessage(sampleAlert);
  assert.ok(formatted.includes('CANDLE CLOSE CONFIRMED'));
  assert.ok(formatted.includes('SuperTrend Buy'));
  assert.ok(formatted.includes('BTCUSDT'));
  assert.ok(formatted.includes('65450'));
  assert.ok(formatted.includes('Up Trend'));
});

console.log(`\nAll Phase 1 tests passed successfully! (${passed}/${total})\n`);

// Clean up test database
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
} catch (e) {}
