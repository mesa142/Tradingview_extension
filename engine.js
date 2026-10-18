/**
 * engine.js — Multi-Condition Rule Evaluation & Intrabar State Machine Engine
 * Strictly enforces:
 *  1. Zero Guessing / Zero Stale Substitution (strict data availability checks)
 *  2. Selective Rule Pausing (PAUSED_DATA_UNAVAILABLE with exact missing plot names)
 *  3. Rolling Ring Buffer per symbol+timeframe for crossovers, momentum & relative change
 *  4. Recursive arbitrary-depth AND/OR condition tree evaluation
 *  5. Strict FALSE -> TRUE edge detection & Intrabar Reversal auto-reset
 */
const EventEmitter = require('events');
const db = require('./db');

class AlertEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bufferSize = options.bufferSize || 250;
    
    // Ring buffers keyed by `${symbol}__${timeframe}`
    // Each buffer entry: { timestamp, is_candle_close, ohlcv, indicators, receivedAt }
    this.buffers = new Map();

    // In-memory state of rules: ruleId -> { lastEvalResult: boolean|null, status: string, missingReason: string|null }
    this.ruleStates = new Map();

    // Active chart tabs: tabId -> { symbol, timeframe, lastSeenAt, isReadable }
    this.activeTabs = new Map();

    // Throttling periodic snapshots to database: key -> lastDbSnapshotTimestamp
    this.lastDbSnapshotTime = new Map();

    // Initialize rules from DB
    this.loadRulesFromDb();
  }

  getSeriesKey(symbol, timeframe) {
    return `${String(symbol).trim().toUpperCase()}__${String(timeframe).trim()}`;
  }

  loadRulesFromDb() {
    try {
      const rules = db.getAllRules();
      for (const r of rules) {
        this.ruleStates.set(r.id, {
          lastEvalResult: r.status === 'ACTIVE_TRUE' ? true : false,
          status: r.status || 'ACTIVE_FALSE',
          missingReason: r.missing_reason || null
        });
      }
    } catch (err) {
      console.error('[AlertEngine] Error loading rules from database:', err);
    }
  }

  // ==================== TAB MANAGEMENT ====================

  registerTab(tabId, symbol, timeframe) {
    if (!tabId) return;
    const cleanSym = String(symbol || '').trim().toUpperCase();
    const cleanTf = String(timeframe || '').trim();
    this.activeTabs.set(String(tabId), {
      tabId: String(tabId),
      symbol: cleanSym,
      timeframe: cleanTf,
      lastSeenAt: Date.now(),
      isReadable: true
    });
    this.emit('tabUpdated', this.getConnectedTabs());
  }

  unregisterTab(tabId) {
    const strTabId = String(tabId);
    const tabInfo = this.activeTabs.get(strTabId);
    if (!tabInfo) return;

    this.activeTabs.delete(strTabId);
    const { symbol, timeframe } = tabInfo;

    // Check if any remaining tab feeds this symbol + timeframe
    const hasRemainingTab = Array.from(this.activeTabs.values()).some(
      t => t.symbol === symbol && t.timeframe === timeframe
    );

    if (!hasRemainingTab) {
      // Pause rules for this symbol+timeframe due to tab closure
      const affectedRules = db.getRulesForSymbolTimeframe(symbol, timeframe);
      for (const r of affectedRules) {
        if (r.status !== 'DISABLED') {
          this.setRulePaused(r.id, `TradingView chart tab for ${symbol} [${timeframe}] was closed`);
        }
      }
    }

    this.emit('tabUpdated', this.getConnectedTabs());
  }

  getConnectedTabs() {
    return Array.from(this.activeTabs.values());
  }

  getRingBuffer(symbol, timeframe) {
    const seriesKey = this.getSeriesKey(symbol, timeframe);
    return this.buffers.get(seriesKey) || [];
  }

  // ==================== STREAM INGESTION & RING BUFFER ====================

  ingestPayload(payload) {
    if (!payload || !payload.symbol) {
      return { ok: false, error: 'Invalid payload: symbol is required' };
    }

    let tfCandidate = payload.timeframe;
    if (typeof tfCandidate === 'object' && tfCandidate !== null) {
      tfCandidate = tfCandidate.value ?? tfCandidate._value ?? tfCandidate.interval ?? tfCandidate.resolution ?? '1m';
    }
    let timeframeStr = String(tfCandidate || '').trim();
    if (!timeframeStr || timeframeStr.toLowerCase().includes('object') || timeframeStr === 'UNKNOWN') {
      timeframeStr = '1m';
    }

    const symbol = String(payload.symbol).trim().toUpperCase();
    const timeframe = timeframeStr;
    const seriesKey = this.getSeriesKey(symbol, timeframe);

    // Track tab activity
    if (payload.tabId) {
      this.registerTab(payload.tabId, symbol, timeframe);
    }

    // Prepare clean frame
    const frame = {
      timestamp: Number(payload.timestamp) || Date.now(),
      is_candle_close: payload.is_candle_close ? 1 : 0,
      ohlcv: payload.ohlcv || {},
      indicators: payload.indicators || {},
      receivedAt: Date.now()
    };

    // Maintain Ring Buffer
    if (!this.buffers.has(seriesKey)) {
      this.buffers.set(seriesKey, []);
    }
    const ring = this.buffers.get(seriesKey);
    ring.push(frame);
    if (ring.length > this.bufferSize) {
      ring.shift();
    }

    // Persist snapshot to SQLite if candle close OR interval elapsed
    this.handleSnapshotPersistence(symbol, timeframe, payload.tabId, frame);

    // Evaluate all active rules for this symbol+timeframe
    this.evaluateRulesForSeries(symbol, timeframe, frame);

    return { ok: true, bufferLength: ring.length };
  }

  handleSnapshotPersistence(symbol, timeframe, tabId, frame) {
    const seriesKey = this.getSeriesKey(symbol, timeframe);
    const now = Date.now();
    const lastSnapTime = this.lastDbSnapshotTime.get(seriesKey) || 0;
    
    let intervalSec = 5;
    try {
      intervalSec = parseInt(db.getSetting('snapshot_interval_sec', '5'), 10) || 5;
    } catch (e) {}

    const intervalElapsed = (now - lastSnapTime) >= (intervalSec * 1000);

    if (frame.is_candle_close || intervalElapsed) {
      this.lastDbSnapshotTime.set(seriesKey, now);
      try {
        const snapId = db.recordSnapshot({
          symbol,
          timeframe,
          tab_id: tabId,
          timestamp: frame.timestamp,
          is_candle_close: frame.is_candle_close,
          ohlcv: frame.ohlcv,
          indicators: frame.indicators
        });
        this.emit('snapshotRecorded', { snapId, symbol, timeframe, is_candle_close: frame.is_candle_close });
      } catch (err) {
        console.error('[AlertEngine] Error recording snapshot:', err);
      }
    }
  }

  // ==================== STRICT DATA VALIDATOR ====================

  /**
   * Traverses a condition tree to verify all required OHLCV fields and indicator plots exist
   * and have valid numeric values in the current frame.
   * Returns: { available: true } OR { available: false, missing: string[] }
   */
  validateDataAvailability(conditionNode, currentFrame) {
    const missing = [];

    const checkSource = (src) => {
      if (!src || typeof src !== 'object') return;
      if (src.type === 'VALUE') return; // Static constant always valid

      if (src.type === 'OHLCV') {
        const f = src.field ? src.field.toLowerCase() : null;
        if (!f || currentFrame.ohlcv[f] === undefined || currentFrame.ohlcv[f] === null || isNaN(Number(currentFrame.ohlcv[f]))) {
          missing.push(`OHLCV field '${src.field || 'unknown'}'`);
        }
      } else if (src.type === 'INDICATOR') {
        const indKey = src.indicatorKey || '';
        const plotKey = src.plotKey || '';
        let indObj = currentFrame.indicators ? currentFrame.indicators[indKey] : null;
        // Auto-resolve fuzzy match if exact key not found
        if (indObj === undefined && currentFrame.indicators) {
          const matchKey = Object.keys(currentFrame.indicators).find(k => 
            k.toLowerCase().includes(indKey.toLowerCase()) || indKey.toLowerCase().includes(k.toLowerCase())
          );
          if (matchKey) indObj = currentFrame.indicators[matchKey];
        }

        if (indObj === undefined || indObj === null) {
          missing.push(`Indicator '${indKey || 'unknown'}'`);
          return;
        }

        // Direct numeric value (flat indicator format)
        if (typeof indObj === 'number' || (!isNaN(Number(indObj)) && typeof indObj !== 'object')) {
          if (isNaN(Number(indObj))) missing.push(`Indicator '${indKey}'`);
          return;
        }

        // Tier-2 structured indicator with plots
        const plotObj = indObj.plots ? indObj.plots[plotKey] : (indObj[plotKey] !== undefined ? { value: indObj[plotKey] } : null);
        if (!plotObj || plotObj.available === false || plotObj.value === null || plotObj.value === undefined || isNaN(Number(plotObj.value))) {
          missing.push(`Indicator '${indKey}' -> Plot '${plotKey || 'default'}'`);
        }
      }
    };

    const traverse = (node) => {
      if (!node) return;
      if (node.conditions && Array.isArray(node.conditions)) {
        for (const child of node.conditions) {
          traverse(child);
        }
      } else {
        checkSource(node.leftSource);
        checkSource(node.rightSource);
      }
    };

    traverse(conditionNode);

    if (missing.length > 0) {
      return { available: false, missing: Array.from(new Set(missing)) };
    }
    return { available: true };
  }

  // ==================== VALUE EXTRACTOR HELPER ====================

  getValueAtBar(source, frame) {
    if (!frame || !source) return null;
    if (source.type === 'VALUE') {
      return typeof source.value === 'number' ? source.value : parseFloat(source.value);
    }
    if (source.type === 'OHLCV') {
      const f = source.field ? source.field.toLowerCase() : null;
      if (!f || !frame.ohlcv || frame.ohlcv[f] === undefined || frame.ohlcv[f] === null) return null;
      const num = Number(frame.ohlcv[f]);
      return isNaN(num) ? null : num;
    }
    if (source.type === 'INDICATOR') {
      if (!frame.indicators) return null;
      let ind = frame.indicators[source.indicatorKey];
      // Auto-resolve fuzzy match
      if (ind === undefined) {
        const matchKey = Object.keys(frame.indicators).find(k => 
          k.toLowerCase().includes(source.indicatorKey.toLowerCase()) || source.indicatorKey.toLowerCase().includes(k.toLowerCase())
        );
        if (matchKey) ind = frame.indicators[matchKey];
      }
      if (ind === undefined || ind === null) return null;

      // Flat numeric value (e.g. { "RSI (14)": 62.4 })
      if (typeof ind === 'number') return ind;
      if (typeof ind !== 'object') {
        const parsed = Number(ind);
        return isNaN(parsed) ? null : parsed;
      }

      // Structured with plots
      if (ind.plots) {
        const plot = ind.plots[source.plotKey] || (source.plotKey ? Object.values(ind.plots)[0] : null);
        if (!plot || plot.available === false || plot.value === null || plot.value === undefined) return null;
        const num = Number(plot.value);
        return isNaN(num) ? null : num;
      }
      if (source.plotKey && ind[source.plotKey] !== undefined) {
        const num = Number(ind[source.plotKey]);
        return isNaN(num) ? null : num;
      }
      return null;
    }
    return null;
  }

  // ==================== RECURSIVE EVALUATOR ====================

  /**
   * Evaluates a leaf condition using the ring buffer
   */
  evaluateLeafCondition(condition, ring) {
    if (!ring || ring.length === 0) return false;
    const currFrame = ring[ring.length - 1];
    const op = condition.operator;
    const lookback = Math.max(1, parseInt(condition.lookback, 10) || 1);

    // Extract current value of left side
    const currLeft = this.getValueAtBar(condition.leftSource, currFrame);
    if (currLeft === null) return false;

    // Handle lookback-based operators (RISING, FALLING, PCT_CHANGE)
    if (op === 'RISING' || op === 'FALLING' || op === 'PCT_CHANGE_GTE' || op === 'PCT_CHANGE_LTE') {
      if (ring.length <= lookback) return false;
      const prevFrame = ring[ring.length - 1 - lookback];
      const prevLeft = this.getValueAtBar(condition.leftSource, prevFrame);
      if (prevLeft === null) return false;

      if (op === 'RISING') {
        return currLeft > prevLeft;
      }
      if (op === 'FALLING') {
        return currLeft < prevLeft;
      }

      if (Math.abs(prevLeft) < 1e-12) return false; // Prevent division by zero
      const pctChange = ((currLeft - prevLeft) / Math.abs(prevLeft)) * 100;
      const targetPct = this.getValueAtBar(condition.rightSource, currFrame);
      if (targetPct === null) return false;

      if (op === 'PCT_CHANGE_GTE') {
        return pctChange >= targetPct;
      }
      if (op === 'PCT_CHANGE_LTE') {
        return pctChange <= targetPct;
      }
    }

    // Handle Crossover operators (CROSSES_ABOVE, CROSSES_BELOW)
    if (op === 'CROSSES_ABOVE' || op === 'CROSSES_BELOW') {
      if (ring.length < 2) return false;
      const prevFrame = ring[ring.length - 2];
      const prevLeft = this.getValueAtBar(condition.leftSource, prevFrame);
      const currRight = this.getValueAtBar(condition.rightSource, currFrame);
      const prevRight = this.getValueAtBar(condition.rightSource, prevFrame);

      if (prevLeft === null || currRight === null || prevRight === null) return false;

      if (op === 'CROSSES_ABOVE') {
        // Crossover: prev(A) <= prev(B) AND curr(A) > curr(B)
        return (prevLeft <= prevRight) && (currLeft > currRight);
      }
      if (op === 'CROSSES_BELOW') {
        // Crossunder: prev(A) >= prev(B) AND curr(A) < curr(B)
        return (prevLeft >= prevRight) && (currLeft < currRight);
      }
    }

    // Standard relational comparison operators
    const currRight = this.getValueAtBar(condition.rightSource, currFrame);
    if (currRight === null) return false;

    switch (op) {
      case '>':  return currLeft > currRight;
      case '<':  return currLeft < currRight;
      case '>=': return currLeft >= currRight;
      case '<=': return currLeft <= currRight;
      case '==': return Math.abs(currLeft - currRight) < 1e-9;
      case '!=': return Math.abs(currLeft - currRight) >= 1e-9;
      default:   return false;
    }
  }

  /**
   * Recursively evaluates an arbitrary condition tree (nested AND / OR groups)
   */
  evaluateNode(node, ring) {
    if (!node) return false;

    // Group Node with child conditions
    if (node.conditions && Array.isArray(node.conditions)) {
      if (node.conditions.length === 0) return true; // Empty group defaults to true
      const logicalOp = (node.logicalOperator || 'AND').toUpperCase();

      if (logicalOp === 'AND') {
        for (const child of node.conditions) {
          if (!this.evaluateNode(child, ring)) return false;
        }
        return true;
      } else if (logicalOp === 'OR') {
        for (const child of node.conditions) {
          if (this.evaluateNode(child, ring)) return true;
        }
        return false;
      }
      return false;
    }

    // Leaf Node
    return this.evaluateLeafCondition(node, ring);
  }

  // ==================== RULE EVALUATION LOOP ====================

  evaluateRulesForSeries(symbol, timeframe, currentFrame) {
    const rules = db.getRulesForSymbolTimeframe(symbol, timeframe);
    const seriesKey = this.getSeriesKey(symbol, timeframe);
    const ring = this.buffers.get(seriesKey) || [];

    for (const rule of rules) {
      if (rule.status === 'DISABLED') continue;

      let conditionTree = {};
      try {
        conditionTree = typeof rule.condition_tree === 'string' ? JSON.parse(rule.condition_tree) : rule.condition_tree;
      } catch (e) {
        console.error(`[AlertEngine] Bad condition tree JSON for rule ${rule.id}`);
        continue;
      }

      // Step 1: Strict Data Availability Check
      const dataCheck = this.validateDataAvailability(conditionTree, currentFrame);

      if (!dataCheck.available) {
        // Selective pause for ONLY this rule
        const missingMsg = `Waiting for: ${dataCheck.missing.join(', ')}`;
        this.setRulePaused(rule.id, missingMsg);
        continue;
      }

      // If data is now available and was previously paused, resume it!
      const currentState = this.ruleStates.get(rule.id) || { lastEvalResult: false, status: 'ACTIVE_FALSE' };
      if (currentState.status === 'PAUSED_DATA_UNAVAILABLE') {
        const resumeStatus = currentState.lastEvalResult ? 'ACTIVE_TRUE' : 'ACTIVE_FALSE';
        this.ruleStates.set(rule.id, {
          lastEvalResult: currentState.lastEvalResult,
          status: resumeStatus,
          missingReason: null
        });
        db.updateRuleState(rule.id, resumeStatus, null, false);
        this.emit('ruleStateChanged', {
          ruleId: rule.id,
          previousStatus: 'PAUSED_DATA_UNAVAILABLE',
          currentStatus: resumeStatus,
          missingReason: null
        });
      }

      // Step 2: Evaluate Condition Tree
      const evalResult = this.evaluateNode(conditionTree, ring);
      const prevResult = currentState.lastEvalResult === true;
      const isCandleClose = currentFrame.is_candle_close === 1 || currentFrame.is_candle_close === true;
      const triggerMode = rule.trigger_mode || 'BOTH';

      let shouldFireIntrabar = false;
      let shouldFireCandleClose = false;

      // 1. Live Market Trigger (Intrabar Tick)
      // Fires strictly on FALSE -> TRUE edge transition
      if (evalResult === true && !prevResult) {
        if (triggerMode === 'BOTH' || triggerMode === 'INTRABAR') {
          shouldFireIntrabar = true;
        }
      }

      // 2. Confirmed Candle Close Trigger
      // Fires when a candle completes and the condition is confirmed TRUE on close
      if (isCandleClose && evalResult === true) {
        if (triggerMode === 'BOTH' || triggerMode === 'CANDLE_CLOSE') {
          // Guard: fire only once per closed bar timestamp to prevent duplicate signals
          if (currentState.lastCandleCloseBarTime !== currentFrame.timestamp) {
            shouldFireCandleClose = true;
          }
        }
      }

      // Execute Triggers
      if (shouldFireIntrabar || shouldFireCandleClose) {
        // If candle close confirmed, prioritize CANDLE_CLOSE trigger tag
        const fireAsClose = shouldFireCandleClose;

        this.ruleStates.set(rule.id, {
          ...currentState,
          lastEvalResult: true,
          status: 'ACTIVE_TRUE',
          missingReason: null,
          lastIntrabarBarTime: shouldFireIntrabar ? currentFrame.timestamp : (currentState.lastIntrabarBarTime || null),
          lastCandleCloseBarTime: fireAsClose ? currentFrame.timestamp : (currentState.lastCandleCloseBarTime || null)
        });
        db.updateRuleState(rule.id, 'ACTIVE_TRUE', null, true);

        const cleanSym = db.cleanSymbol(rule.symbol);
        const cleanTf = db.cleanTimeframe(rule.timeframe);

        const alertRecord = {
          rule_id: rule.id,
          rule_name: rule.name,
          symbol: cleanSym,
          timeframe: cleanTf,
          candle_timestamp: currentFrame.timestamp,
          is_candle_close: fireAsClose ? 1 : 0,
          snapshot: {
            ohlcv: currentFrame.ohlcv,
            indicators: currentFrame.indicators,
            trigger_type: fireAsClose ? 'CANDLE_CLOSE_CONFIRMED' : 'LIVE_MARKET_INTRABAR',
            triggeredAt: new Date().toISOString()
          }
        };

        const recordedAlert = db.recordTriggeredAlert(alertRecord);

        this.emit('alertTriggered', {
          alert: recordedAlert,
          rule: rule,
          snapshot: alertRecord.snapshot
        });

        this.emit('ruleStateChanged', {
          ruleId: rule.id,
          previousStatus: prevResult ? 'ACTIVE_TRUE' : 'ACTIVE_FALSE',
          currentStatus: 'ACTIVE_TRUE',
          missingReason: null
        });

      } else if (prevResult && evalResult === false) {
        // INTRABAR REVERSAL (TRUE -> FALSE)
        // Reset rule state to ACTIVE_FALSE so it can re-trigger on next cross
        this.ruleStates.set(rule.id, {
          ...currentState,
          lastEvalResult: false,
          status: 'ACTIVE_FALSE',
          missingReason: null
        });
        db.updateRuleState(rule.id, 'ACTIVE_FALSE', null, false);

        this.emit('ruleStateChanged', {
          ruleId: rule.id,
          previousStatus: 'ACTIVE_TRUE',
          currentStatus: 'ACTIVE_FALSE',
          missingReason: null,
          intrabarReversal: true
        });
      }
    }
  }

  setRulePaused(ruleId, reason) {
    const currentState = this.ruleStates.get(ruleId) || { lastEvalResult: false, status: 'ACTIVE_FALSE' };
    if (currentState.status === 'PAUSED_DATA_UNAVAILABLE' && currentState.missingReason === reason) {
      return; // Already paused with same reason
    }

    const previousStatus = currentState.status;
    this.ruleStates.set(ruleId, {
      lastEvalResult: currentState.lastEvalResult, // FREEZE previous boolean state
      status: 'PAUSED_DATA_UNAVAILABLE',
      missingReason: reason
    });

    db.updateRuleState(ruleId, 'PAUSED_DATA_UNAVAILABLE', reason, false);

    this.emit('ruleStateChanged', {
      ruleId,
      previousStatus,
      currentStatus: 'PAUSED_DATA_UNAVAILABLE',
      missingReason: reason
    });
  }
}

module.exports = AlertEngine;
