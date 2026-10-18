/**
 * db.js — Production-grade SQLite persistence layer for TV Alert Extension
 * Supports both better-sqlite3 (if native build exists) and node:sqlite (built-in Node 22+)
 */
const path = require('path');
const fs = require('fs');

let dbInstance = null;
let isNodeSqlite = false;

function getDb(customPath) {
  if (dbInstance) return dbInstance;

  const dbPath = customPath || path.join(__dirname, 'tradingview_alerts.sqlite');
  
  // Try better-sqlite3 first if installed; fallback to Node.js 22 built-in DatabaseSync
  try {
    const BetterSqlite3 = require('better-sqlite3');
    dbInstance = new BetterSqlite3(dbPath);
    isNodeSqlite = false;
  } catch (err) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      dbInstance = new DatabaseSync(dbPath);
      isNodeSqlite = true;
    } catch (e2) {
      throw new Error(`Failed to initialize SQLite database: ${err.message} | ${e2.message}`);
    }
  }

  // Optimize SQLite PRAGMAs for fast local IPC & logging
  try {
    dbInstance.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
  } catch (e) {
    // Some in-memory or custom environments may restrict WAL
  }

  initSchema();
  return dbInstance;
}

function cleanTimeframe(val) {
  if (val == null) return '1m';
  if (typeof val === 'object') {
    const cand = val.value ?? val._value ?? val.interval ?? val.resolution ?? val.timeframe ?? val.tf ?? val.name ?? val.label ?? val.shortName ?? val.id ?? val.text;
    if (cand != null && typeof cand !== 'object') {
      return cleanTimeframe(cand);
    }
    return '1m';
  }
  let str = String(val).trim();
  if (!str || str === '—' || str.toLowerCase().includes('object') || str === 'undefined' || str === 'null' || str === 'UNKNOWN') {
    return '1m';
  }
  str = str.replace(/[\[\]"']/g, '').trim();
  const num = Number(str);
  if (!isNaN(num) && num > 0) {
    if (num === 60) return '1h';
    if (num === 120) return '2h';
    if (num === 240) return '4h';
    return `${num}m`;
  }
  return str;
}

function cleanSymbol(val) {
  if (val == null) return 'SYMBOL';
  if (typeof val === 'object') {
    const cand = val.symbol ?? val.ticker ?? val.name ?? val.value ?? val.pair;
    if (cand && typeof cand !== 'object') return cleanSymbol(cand);
    return 'SYMBOL';
  }
  let s = String(val).trim();
  if (!s || s.toLowerCase().includes('object') || s === 'undefined' || s === 'null' || s === 'UNKNOWN') return 'SYMBOL';
  return s.split('•')[0].trim().toUpperCase();
}

function initSchema() {
  const db = dbInstance || getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      condition_tree TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE_FALSE',
      missing_reason TEXT,
      trigger_mode TEXT NOT NULL DEFAULT 'BOTH',
      trigger_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rules_symbol_tf ON alert_rules(symbol, timeframe);
    CREATE INDEX IF NOT EXISTS idx_rules_status ON alert_rules(status);

    CREATE TABLE IF NOT EXISTS triggered_alerts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      candle_timestamp INTEGER,
      is_candle_close INTEGER NOT NULL DEFAULT 0,
      snapshot_json TEXT NOT NULL,
      telegram_sent INTEGER NOT NULL DEFAULT 0,
      telegram_error TEXT,
      FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_triggered_at ON triggered_alerts(triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_rule_id ON triggered_alerts(rule_id);

    CREATE TABLE IF NOT EXISTS indicator_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      tab_id TEXT,
      timestamp INTEGER NOT NULL,
      is_candle_close INTEGER NOT NULL DEFAULT 0,
      ohlcv_json TEXT NOT NULL,
      indicators_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_sym_tf_ts ON indicator_snapshots(symbol, timeframe, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON indicator_snapshots(created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed default settings if missing
  const defaultSettings = [
    { key: 'telegram_bot_token', value: '' },
    { key: 'telegram_chat_id', value: '' },
    { key: 'snapshot_interval_sec', value: '5' },
    { key: 'audio_enabled', value: '1' }
  ];

  const checkStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const insertStmt = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');

  for (const s of defaultSettings) {
    const existing = checkStmt.get(s.key);
    if (!existing) {
      insertStmt.run(s.key, s.value);
    }
  }

  // Safe migration for existing databases
  try {
    db.exec(`ALTER TABLE alert_rules ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'BOTH'`);
  } catch (_) {}
}

// ==================== ALERT RULES CRUD ====================

function getAllRules() {
  const db = getDb();
  return db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();
}

function getRulesForSymbolTimeframe(symbol, timeframe) {
  const db = getDb();
  const cleanSym = cleanSymbol(symbol);
  const cleanTf = cleanTimeframe(timeframe);
  return db.prepare(`
    SELECT * FROM alert_rules 
    WHERE UPPER(symbol) = UPPER(?) AND timeframe = ? AND status != 'DISABLED'
  `).all(cleanSym, cleanTf);
}

function getRuleById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
}

function createRule(rule) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = rule.id || `rule_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const treeJson = typeof rule.condition_tree === 'string' ? rule.condition_tree : JSON.stringify(rule.condition_tree || {});
  const triggerMode = rule.trigger_mode || 'BOTH';
  const cleanSym = cleanSymbol(rule.symbol);
  const cleanTf = cleanTimeframe(rule.timeframe);

  const stmt = db.prepare(`
    INSERT INTO alert_rules (
      id, name, symbol, timeframe, condition_tree, status, missing_reason,
      trigger_mode, trigger_count, last_triggered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
  `);

  stmt.run(
    id,
    rule.name || 'Untitled Rule',
    cleanSym,
    cleanTf,
    treeJson,
    rule.status || 'ACTIVE_FALSE',
    rule.missing_reason || null,
    triggerMode,
    now,
    now
  );

  return getRuleById(id);
}

function updateRule(id, updates) {
  const db = getDb();
  const current = getRuleById(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const name = updates.name !== undefined ? updates.name : current.name;
  const symbol = updates.symbol !== undefined ? cleanSymbol(updates.symbol) : current.symbol;
  const timeframe = updates.timeframe !== undefined ? cleanTimeframe(updates.timeframe) : current.timeframe;
  const condition_tree = updates.condition_tree !== undefined ? 
    (typeof updates.condition_tree === 'string' ? updates.condition_tree : JSON.stringify(updates.condition_tree)) : 
    current.condition_tree;
  const status = updates.status !== undefined ? updates.status : current.status;
  const missing_reason = updates.missing_reason !== undefined ? updates.missing_reason : current.missing_reason;
  const trigger_mode = updates.trigger_mode !== undefined ? updates.trigger_mode : (current.trigger_mode || 'BOTH');

  const stmt = db.prepare(`
    UPDATE alert_rules
    SET name = ?, symbol = ?, timeframe = ?, condition_tree = ?, status = ?, missing_reason = ?, trigger_mode = ?, updated_at = ?
    WHERE id = ?
  `);

  stmt.run(name, symbol, timeframe, condition_tree, status, missing_reason, trigger_mode, now, id);
  return getRuleById(id);
}

function updateRuleState(id, status, missingReason = null, triggerIncrement = false) {
  const db = getDb();
  const now = new Date().toISOString();

  if (triggerIncrement) {
    db.prepare(`
      UPDATE alert_rules
      SET status = ?, missing_reason = ?, trigger_count = trigger_count + 1, last_triggered_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, missingReason, now, now, id);
  } else {
    db.prepare(`
      UPDATE alert_rules
      SET status = ?, missing_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(status, missingReason, now, id);
  }
}

function deleteRule(id) {
  const db = getDb();
  // Child alerts are cascaded or deleted manually for safety
  db.prepare('DELETE FROM triggered_alerts WHERE rule_id = ?').run(id);
  const result = db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==================== TRIGGERED ALERTS ====================

function recordTriggeredAlert(alert) {
  const db = getDb();
  const id = alert.id || `alt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = alert.triggered_at || new Date().toISOString();
  const snapshotJson = typeof alert.snapshot === 'string' ? alert.snapshot : JSON.stringify(alert.snapshot || {});
  const cleanSym = cleanSymbol(alert.symbol);
  const cleanTf = cleanTimeframe(alert.timeframe);

  const stmt = db.prepare(`
    INSERT INTO triggered_alerts (
      id, rule_id, rule_name, symbol, timeframe, triggered_at,
      candle_timestamp, is_candle_close, snapshot_json, telegram_sent, telegram_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    alert.rule_id,
    alert.rule_name,
    cleanSym,
    cleanTf,
    now,
    alert.candle_timestamp || null,
    alert.is_candle_close ? 1 : 0,
    snapshotJson,
    alert.telegram_sent ? 1 : 0,
    alert.telegram_error || null
  );

  return { id, ...alert, symbol: cleanSym, timeframe: cleanTf, triggered_at: now };
}

function getTriggeredAlerts(limit = 100, offset = 0, ruleId = null) {
  const db = getDb();
  if (ruleId) {
    return db.prepare(`
      SELECT * FROM triggered_alerts 
      WHERE rule_id = ? 
      ORDER BY triggered_at DESC 
      LIMIT ? OFFSET ?
    `).all(ruleId, limit, offset);
  }
  return db.prepare(`
    SELECT * FROM triggered_alerts 
    ORDER BY triggered_at DESC 
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function updateAlertTelegramStatus(alertId, sent, errorMessage = null) {
  const db = getDb();
  db.prepare(`
    UPDATE triggered_alerts
    SET telegram_sent = ?, telegram_error = ?
    WHERE id = ?
  `).run(sent ? 1 : 0, errorMessage, alertId);
}

// ==================== SNAPSHOTS ====================

function recordSnapshot(snapshot) {
  const db = getDb();
  const now = new Date().toISOString();
  const ohlcvJson = typeof snapshot.ohlcv === 'string' ? snapshot.ohlcv : JSON.stringify(snapshot.ohlcv || {});
  const indicatorsJson = typeof snapshot.indicators === 'string' ? snapshot.indicators : JSON.stringify(snapshot.indicators || {});
  const cleanSym = cleanSymbol(snapshot.symbol);
  const cleanTf = cleanTimeframe(snapshot.timeframe);

  const stmt = db.prepare(`
    INSERT INTO indicator_snapshots (
      symbol, timeframe, tab_id, timestamp, is_candle_close, ohlcv_json, indicators_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    cleanSym,
    cleanTf,
    snapshot.tab_id ? String(snapshot.tab_id) : null,
    snapshot.timestamp || Date.now(),
    snapshot.is_candle_close ? 1 : 0,
    ohlcvJson,
    indicatorsJson,
    now
  );

  return result.lastInsertRowid;
}

function getRecentSnapshots(symbol, timeframe, limit = 50) {
  const db = getDb();
  const cleanSym = cleanSymbol(symbol);
  const cleanTf = cleanTimeframe(timeframe);
  return db.prepare(`
    SELECT * FROM indicator_snapshots
    WHERE UPPER(symbol) = UPPER(?) AND timeframe = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(cleanSym, cleanTf, limit);
}

function getLatestSnapshot(symbol = null, timeframe = null) {
  const db = getDb();
  if (symbol && timeframe) {
    return db.prepare(`
      SELECT * FROM indicator_snapshots
      WHERE UPPER(symbol) = UPPER(?) AND timeframe = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(cleanSymbol(symbol), cleanTimeframe(timeframe));
  } else if (symbol) {
    return db.prepare(`
      SELECT * FROM indicator_snapshots
      WHERE UPPER(symbol) = UPPER(?)
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(cleanSymbol(symbol));
  }
  return db.prepare(`
    SELECT * FROM indicator_snapshots
    ORDER BY timestamp DESC
    LIMIT 1
  `).get();
}

// ==================== SETTINGS ====================

function getSetting(key, fallback = '') {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function getAllSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ==================== 30-DAY PRUNING ====================

function pruneOldHistory(retentionDays = 30) {
  const db = getDb();
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Prune snapshots older than 30 days
  const snapResult = db.prepare(`
    DELETE FROM indicator_snapshots
    WHERE created_at < ? OR timestamp < ?
  `).run(cutoffIso, cutoffMs);

  // Prune alerts older than 30 days
  const alertResult = db.prepare(`
    DELETE FROM triggered_alerts
    WHERE triggered_at < ?
  `).run(cutoffIso);

  return {
    prunedSnapshots: snapResult.changes,
    prunedAlerts: alertResult.changes,
    cutoffDate: cutoffIso
  };
}

module.exports = {
  getDb,
  initSchema,
  getAllRules,
  getRulesForSymbolTimeframe,
  getRuleById,
  createRule,
  updateRule,
  updateRuleState,
  deleteRule,
  recordTriggeredAlert,
  getTriggeredAlerts,
  updateAlertTelegramStatus,
  recordSnapshot,
  getRecentSnapshots,
  getLatestSnapshot,
  getSetting,
  getAllSettings,
  setSetting,
  pruneOldHistory,
  cleanSymbol,
  cleanTimeframe
};
