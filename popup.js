/**
 * popup.js — Tier 2 Visual Multi-Condition Rule Builder & Monitoring Dashboard
 *
 * Capabilities:
 *  1. Live Inspector: Dynamic auto-discovery of all indicators & plots (zero manual typing)
 *  2. Visual Nested Rule Builder: Recursive AND/OR groups, indicator-to-indicator & value comparisons
 *  3. Active Rules Manager: Live status badges, missing plot warnings, pause/resume/delete
 *  4. 30-Day Triggered Alerts History & Multi-Channel Settings (Telegram + Audio)
 *  5. CSV Extractor backward compatibility
 */

'use strict';

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Service Discovery & API Client (Authoritative Port 3000)
// -----------------------------------------------------------------------------

function cleanTimeframe(val) {
  if (val == null) return '';
  if (typeof val === 'object') {
    const cand = val.value ?? val._value ?? val.interval ?? val.resolution ?? val.timeframe ?? val.tf ?? val.name ?? val.label ?? val.shortName ?? val.id ?? val.text;
    if (cand != null && typeof cand !== 'object') {
      return cleanTimeframe(cand);
    }
    if (typeof val.toString === 'function') {
      const s = val.toString();
      if (s && !s.toLowerCase().includes('object')) return cleanTimeframe(s);
    }
    return '';
  }
  let str = String(val).trim();
  if (!str || str === '—' || str.toLowerCase().includes('object') || str === 'undefined' || str === 'null' || str === 'UNKNOWN') {
    return '';
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
  if (val == null) return '';
  if (typeof val === 'object') {
    const cand = val.symbol ?? val.ticker ?? val.name ?? val.value ?? val.pair;
    if (cand && typeof cand !== 'object') return cleanSymbol(cand);
    return '';
  }
  let s = String(val).trim();
  if (!s || s.toLowerCase().includes('object') || s === 'undefined' || s === 'null' || s === 'UNKNOWN') return '';
  return s.split('•')[0].trim().toUpperCase();
}

// Restore cached series from localStorage on immediate load so indicators exist even if bridge is idle
try {
  const cachedSeries = localStorage.getItem('tv_cached_series');
  if (cachedSeries) {
    const parsed = JSON.parse(cachedSeries);
    if (Array.isArray(parsed) && parsed.length > 0) {
      discoveredSeriesList = parsed;
    }
  }
} catch (_) {}

let API_BASE = 'http://localhost:3000';
let WS_BASE = 'ws://localhost:3000';
let wsConn = null;
let latestPayload = null;
let discoveredSeriesList = []; // Array of { id, label, sourceObj }

let backendState = { state: 'red', label: 'Backend: Stopped' };
let chartState = { state: 'amber', label: 'Chart: Detecting...' };
let monitoringState = { state: 'amber', label: 'Monitoring: Idle' };

function updateStatusIndicators(backend = null, chart = null, monitoring = null) {
  if (backend) {
    backendState = backend;
    const dot = document.getElementById('dotBackend');
    const txt = document.getElementById('textBackend');
    if (dot) dot.className = `status-dot ${backend.state}`;
    if (txt) txt.textContent = backend.label;
  }
  if (chart) {
    chartState = chart;
    const dot = document.getElementById('dotChart');
    const txt = document.getElementById('textChart');
    if (dot) dot.className = `status-dot ${chart.state}`;
    if (txt) txt.textContent = chart.label;
  }
  if (monitoring) {
    monitoringState = monitoring;
    const dot = document.getElementById('dotMonitoring');
    const txt = document.getElementById('textMonitoring');
    if (dot) dot.className = `status-dot ${monitoring.state}`;
    if (txt) txt.textContent = monitoring.label;
  }
}

async function detectService(interactive = false) {
  if (interactive) {
    updateStatusIndicators({ state: 'amber', label: 'Backend: Connecting...' });
  }

  const customPort = localStorage.getItem('tv_service_port');
  const targetPort = customPort ? parseInt(customPort, 10) : 3000;
  const targetHttp = `http://localhost:${targetPort}`;
  const targetWs = `ws://localhost:${targetPort}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`${targetHttp}/api/health`, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);

    if (res && res.ok) {
      API_BASE = targetHttp;
      WS_BASE = targetWs;
      updateStatusIndicators({ state: 'green', label: `Backend: Running (Port ${targetPort})` });
      connectWebSocket();
      fetchLatestIndicators();
      refreshMonitoringStatus();
      return true;
    }
  } catch (_) {}

  // If port 3000 not responding, backend is stopped
  if (wsConn) {
    try { wsConn.close(); } catch (_) {}
    wsConn = null;
  }
  updateStatusIndicators({ state: 'red', label: 'Backend: Stopped' });
  refreshMonitoringStatus();
  return false;
}

async function checkChartAvailability() {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) {
    updateStatusIndicators(null, { state: 'amber', label: 'Chart: Standalone' });
    return;
  }

  try {
    const tvTabs = await chrome.tabs.query({ url: ['*://*.tradingview.com/*', '*://*.tradingview.cn/*'] });
    if (!tvTabs || tvTabs.length === 0) {
      updateStatusIndicators(null, { state: 'red', label: 'Chart: No TradingView Tab' });
      return;
    }

    const activeSym = document.getElementById('tickerSymbol')?.textContent?.trim();
    const activeTf = document.getElementById('tickerTf')?.textContent?.trim();

    if (latestPayload && (latestPayload.symbol || latestPayload.ohlcv?.close !== null)) {
      const sym = cleanSymbol(latestPayload.symbol) || activeSym || 'TV';
      const tf = cleanTimeframe(latestPayload.timeframe) || activeTf || '';
      updateStatusIndicators(null, {
        state: 'green',
        label: `Chart: Connected (${sym}${tf ? ' [' + tf + ']' : ''})`
      });
    } else if (activeSym && activeSym !== '—' && activeSym !== 'UNKNOWN') {
      updateStatusIndicators(null, {
        state: 'green',
        label: `Chart: Connected (${activeSym}${activeTf && activeTf !== '—' ? ' [' + activeTf + ']' : ''})`
      });
    } else {
      updateStatusIndicators(null, {
        state: 'amber',
        label: `Chart: Waiting for Data (${tvTabs.length} Tab${tvTabs.length > 1 ? 's' : ''})`
      });
    }
  } catch (_) {
    updateStatusIndicators(null, { state: 'amber', label: 'Chart: Detecting...' });
  }
}

async function refreshMonitoringStatus() {
  let count = 0;
  if (backendState.state === 'green') {
    try {
      const res = await fetch(`${API_BASE}/api/rules`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        const data = await res.json();
        const active = (data.rules || []).filter(r => r.status && r.status.startsWith('ACTIVE'));
        count = active.length;
        if (count > 0) {
          updateStatusIndicators(null, null, { state: 'green', label: `Monitoring: Active (${count} Rule${count > 1 ? 's' : ''})` });
        } else {
          updateStatusIndicators(null, null, { state: 'amber', label: 'Monitoring: Idle (0 Rules)' });
        }
        return;
      }
    } catch (_) {}
  }

  // Fallback: in-browser standalone rules
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get(['tvStandaloneRules']);
      const active = (data.tvStandaloneRules || []).filter(r => r.status && r.status.startsWith('ACTIVE'));
      count = active.length;
      if (count > 0) {
        updateStatusIndicators(null, null, { state: 'amber', label: `Monitoring: Standalone (${count} Rule${count > 1 ? 's' : ''})` });
      } else {
        updateStatusIndicators(null, null, { state: 'red', label: 'Monitoring: Idle (0 Rules)' });
      }
      return;
    } catch (_) {}
  }

  updateStatusIndicators(null, null, { state: 'red', label: 'Monitoring: Stopped' });
}

function updateServicePill(online, port = '') {
  if (online) {
    updateStatusIndicators({ state: 'green', label: `Backend: Running (Port ${port || '3000'})` });
  } else {
    updateStatusIndicators({ state: 'red', label: 'Backend: Stopped' });
  }
}

function connectWebSocket() {
  if (wsConn && (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING)) return;

  try {
    wsConn = new WebSocket(WS_BASE);
    wsConn.onopen = () => {
      const portStr = WS_BASE.split(':').pop();
      updateStatusIndicators({ state: 'green', label: `Backend: Running (Port ${portStr || '3000'})` });
      try {
        wsConn.send(JSON.stringify({ type: 'REGISTER_CLIENT', role: 'POPUP_UI' }));
      } catch (_) {}
    };
    wsConn.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ALERT_TRIGGERED' || msg.type === 'RULES_UPDATED' || msg.type === 'RULE_STATE_CHANGED') {
          loadActiveRules();
          loadAlertsHistory();
          refreshMonitoringStatus();
        }
        if (msg.type === 'INGEST_PAYLOAD' && msg.payload) {
          handleIncomingPayload(msg.payload);
        }
      } catch (_) {}
    };
    wsConn.onerror = (e) => {
      try { e.preventDefault?.(); } catch (_) {}
    };
    wsConn.onclose = () => {
      wsConn = null;
      updateStatusIndicators({ state: 'red', label: 'Backend: Stopped' });
      // Throttled reconnect check every 10 seconds (no console error spam)
      setTimeout(() => { detectService(false); }, 10000);
    };
  } catch (_) {
    wsConn = null;
    updateStatusIndicators({ state: 'red', label: 'Backend: Stopped' });
    setTimeout(() => { detectService(false); }, 10000);
  }
}

// -----------------------------------------------------------------------------
// Navigation Tabs
// -----------------------------------------------------------------------------

document.querySelectorAll('.tab-nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const targetId = btn.getAttribute('data-tab');
    const pane = document.getElementById(targetId);
    if (pane) pane.classList.add('active');

    try { localStorage.setItem('tv_active_tab', targetId); } catch (_) {}

    if (targetId === 'tab-rules') loadActiveRules();
    if (targetId === 'tab-history') { loadAlertsHistory(); loadSettings(); }
  });
});

// -----------------------------------------------------------------------------
// Tab 1: Live Chart & Series Inspector
// -----------------------------------------------------------------------------

function handleIncomingPayload(payload) {
  if (!payload) return;
  latestPayload = payload;

  // 1. Update Ticker Bar
  const sym = cleanSymbol(payload.symbol) || '—';
  const tf = cleanTimeframe(payload.timeframe) || '—';

  const symEl = document.getElementById('tickerSymbol');
  const tfEl = document.getElementById('tickerTf');
  if (symEl) symEl.textContent = sym;
  if (tfEl) tfEl.textContent = tf;

  // Handle both payload.ohlcv and top-level fields (from content script or server)
  const closeRaw = payload.ohlcv?.close ?? payload.close;
  const closeVal = closeRaw != null && !isNaN(Number(closeRaw)) ? Number(closeRaw).toFixed(2) : '—';
  const tickerClose = document.getElementById('tickerClose');
  if (tickerClose) tickerClose.textContent = closeVal;

  const oRaw = payload.ohlcv?.open ?? payload.open;
  const hRaw = payload.ohlcv?.high ?? payload.high;
  const lRaw = payload.ohlcv?.low ?? payload.low;
  const o = oRaw != null && !isNaN(Number(oRaw)) ? Number(oRaw).toFixed(1) : '—';
  const h = hRaw != null && !isNaN(Number(hRaw)) ? Number(hRaw).toFixed(1) : '—';
  const l = lRaw != null && !isNaN(Number(lRaw)) ? Number(lRaw).toFixed(1) : '—';
  const tickerOhl = document.getElementById('tickerOhl');
  if (tickerOhl) tickerOhl.textContent = `${o} / ${h} / ${l}`;

  const vRaw = payload.ohlcv?.volume ?? payload.volume;
  const v = vRaw != null && !isNaN(Number(vRaw)) ? Number(vRaw).toLocaleString() : '—';
  const tickerVol = document.getElementById('tickerVol');
  if (tickerVol) tickerVol.textContent = v;

  const candleState = document.getElementById('tickerCandleState');
  if (candleState) {
    if (payload.is_candle_close === 1) {
      candleState.textContent = 'Candle Close';
      candleState.style.color = '#26a69a';
    } else {
      candleState.textContent = 'Intrabar';
      candleState.style.color = '#ffa726';
    }
  }

  // 2. Refresh Series Inspector & Dropdown options
  rebuildDiscoveredSeriesList(payload);
  renderSeriesTree(payload);

  // 3. Auto-populate Symbol & Timeframe into Rule Builder (Rule Name left empty for manual entry)
  if (sym && sym !== '—' && sym !== 'UNKNOWN') {
    const symInput = document.getElementById('ruleSymbolInput');
    if (symInput) symInput.value = sym;
  }
  if (tf && tf !== '—' && tf !== 'UNKNOWN') {
    const tfInput = document.getElementById('ruleTfInput');
    if (tfInput) tfInput.value = tf;
  }
  saveActiveSymbolTf(sym, tf);

  const autoBadge = document.getElementById('chartAutoFetchStatus');
  if (autoBadge && sym && sym !== '—') {
    const count = Object.keys(payload.indicators || {}).length;
    autoBadge.textContent = `✓ Auto-synced: ${sym} (${tf}) [${count} ind]`;
    autoBadge.style.color = '#26a69a';
  }
}

function haveSeriesListsChanged(oldList, newList) {
  if (!oldList || !newList) return true;
  if (oldList.length !== newList.length) return true;
  for (let i = 0; i < oldList.length; i++) {
    if (oldList[i].id !== newList[i].id || oldList[i].label !== newList[i].label) {
      return true;
    }
  }
  return false;
}

let pendingSeriesUpdate = false;

function updateAllSeriesSelects() {
  const rootEl = document.getElementById('ruleTreeRoot');
  if (!rootEl) return;

  // CRITICAL: If the user is currently focused inside the rule tree
  // (e.g. looking at an open select dropdown or editing an input), DO NOT disrupt or close it!
  if (rootEl.contains(document.activeElement)) {
    pendingSeriesUpdate = true;
    return;
  }

  // Update existing series dropdowns in-place WITHOUT blowing away the DOM tree
  const selects = rootEl.querySelectorAll('select.series-select');
  if (selects.length === 0) {
    // If not rendered yet, render tree
    renderConditionTree();
    return;
  }

  selects.forEach(selectEl => {
    let currentSource = null;
    const currentSourceStr = selectEl.getAttribute('data-current-source');
    try {
      if (currentSourceStr) currentSource = JSON.parse(currentSourceStr);
    } catch (_) {}
    if (!currentSource && selectEl.selectedIndex >= 0) {
      try {
        currentSource = JSON.parse(selectEl.options[selectEl.selectedIndex].getAttribute('data-source'));
      } catch (_) {}
    }
    populateSeriesOptions(selectEl, currentSource);
  });
}

function rebuildDiscoveredSeriesList(payload) {
  const list = [
    { id: 'ohlcv:close', label: 'Price: Close', sourceObj: { type: 'OHLCV', field: 'close' } },
    { id: 'ohlcv:open', label: 'Price: Open', sourceObj: { type: 'OHLCV', field: 'open' } },
    { id: 'ohlcv:high', label: 'Price: High', sourceObj: { type: 'OHLCV', field: 'high' } },
    { id: 'ohlcv:low', label: 'Price: Low', sourceObj: { type: 'OHLCV', field: 'low' } },
    { id: 'ohlcv:volume', label: 'Volume (OHLCV)', sourceObj: { type: 'OHLCV', field: 'volume' } },
  ];

  if (payload.indicators && typeof payload.indicators === 'object') {
    for (const [indKey, indData] of Object.entries(payload.indicators)) {
      if (indData && typeof indData === 'object' && indData.plots) {
        // Structured indicator with plots
        for (const [plotKey, plotObj] of Object.entries(indData.plots)) {
          list.push({
            id: `ind:${indKey}:${plotKey}`,
            label: `${indData.name || indKey} ➜ ${plotKey}`,
            sourceObj: { type: 'INDICATOR', indicatorKey: indKey, plotKey }
          });
        }
      } else {
        // Flat indicator or direct numeric value from content script
        let plotKey = 'value';
        let indName = indKey;
        if (indKey.includes('›')) {
          const parts = indKey.split('›').map(s => s.trim());
          indName = parts[0];
          plotKey = parts[1] || 'value';
        } else if (indKey.includes('➜')) {
          const parts = indKey.split('➜').map(s => s.trim());
          indName = parts[0];
          plotKey = parts[1] || 'value';
        }
        list.push({
          id: `ind:${indKey}`,
          label: `Plot: ${indKey}`,
          sourceObj: { type: 'INDICATOR', indicatorKey: indKey, plotKey }
        });
      }
    }
  }

  // Check if series list actually changed before doing any work
  const hasChanged = haveSeriesListsChanged(discoveredSeriesList, list);
  discoveredSeriesList = list;
  try {
    localStorage.setItem('tv_cached_series', JSON.stringify(list));
  } catch (_) {}

  // If changed, update dropdowns smoothly without destroying the tree DOM
  if (hasChanged) {
    updateAllSeriesSelects();
  }
}

function saveActiveSymbolTf(sym, tf) {
  const cleanSym = cleanSymbol(sym);
  const cleanTf = cleanTimeframe(tf);
  if (cleanSym && cleanSym !== '—' && cleanSym !== 'UNKNOWN') {
    try { localStorage.setItem('tv_saved_symbol', cleanSym); } catch (_) {}
  }
  if (cleanTf && cleanTf !== '—') {
    try { localStorage.setItem('tv_saved_timeframe', cleanTf); } catch (_) {}
  }
}

function restoreActiveSymbolTf() {
  const symInput = document.getElementById('ruleSymbolInput');
  const tfInput = document.getElementById('ruleTfInput');

  try {
    // Purge corrupted legacy data if any
    const rawTf = localStorage.getItem('tv_saved_timeframe');
    if (rawTf && (rawTf.toLowerCase().includes('object') || rawTf === '—')) {
      localStorage.removeItem('tv_saved_timeframe');
    }
    const rawSym = localStorage.getItem('tv_saved_symbol');
    if (rawSym && rawSym.toLowerCase().includes('object')) {
      localStorage.removeItem('tv_saved_symbol');
    }

    const savedSym = cleanSymbol(localStorage.getItem('tv_saved_symbol'));
    const savedTf = cleanTimeframe(localStorage.getItem('tv_saved_timeframe'));

    if (symInput && savedSym && !symInput.value) {
      symInput.value = savedSym;
    }
    if (tfInput && savedTf && !tfInput.value) {
      tfInput.value = savedTf;
    }
  } catch (_) {}

  // Auto-save whenever user types or edits symbol/timeframe
  symInput?.addEventListener('input', () => {
    saveActiveSymbolTf(symInput.value, tfInput?.value);
  });
  tfInput?.addEventListener('input', () => {
    saveActiveSymbolTf(symInput?.value, tfInput.value);
  });
}

async function fetchLatestIndicators() {
  try {
    const res = await fetch(`${API_BASE}/api/latest-indicators`);
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data.indicators) {
        rebuildDiscoveredSeriesList(data);
        renderSeriesTree(data);

        // Auto-detect symbol & timeframe from latest snapshot if inputs are empty
        const sym = cleanSymbol(data.symbol);
        const tf = cleanTimeframe(data.timeframe);
        const symInput = document.getElementById('ruleSymbolInput');
        const tfInput = document.getElementById('ruleTfInput');
        if (symInput && !symInput.value && sym) {
          symInput.value = sym;
          saveActiveSymbolTf(sym, tf);
        }
        if (tfInput && !tfInput.value && tf) {
          tfInput.value = tf;
          saveActiveSymbolTf(sym, tf);
        }
      }
    }
  } catch (_) {}
}

function renderSeriesTree(payload) {
  const container = document.getElementById('seriesTreeContainer');
  if (!container) return;

  const inds = payload.indicators || {};
  const indKeys = Object.keys(inds);

  if (indKeys.length === 0) {
    container.innerHTML = `
      <div style="padding:14px; text-align:center; color:var(--muted);">
        No indicators detected in legend yet. Showing primary OHLCV series.
      </div>
    `;
    return;
  }

  container.innerHTML = indKeys.map(k => {
    const ind = inds[k];
    const isStructured = ind && typeof ind === 'object' && ind.plots;

    const badge = (isStructured ? ind.isReadable : (ind != null && !isNaN(Number(ind))))
      ? '<span class="badge badge-readable">Readable</span>'
      : '<span class="badge badge-unavailable">Unavailable</span>';

    let plotsHtml = '';
    if (isStructured) {
      plotsHtml = Object.entries(ind.plots || {}).map(([pName, pObj]) => {
        const valStr = pObj.value != null ? Number(pObj.value).toFixed(2) : 'null';
        const color = pObj.available !== false ? '#7ee787' : '#ef5350';
        return `
          <div class="plot-chip">
            <span style="color:var(--muted);">${pName}:</span>
            <span style="color:${color}; font-weight:700;">${valStr}</span>
          </div>
        `;
      }).join('');
    } else {
      const valStr = ind != null && !isNaN(Number(ind)) ? Number(ind).toFixed(2) : String(ind ?? '—');
      plotsHtml = `
        <div class="plot-chip">
          <span style="color:var(--muted);">Value:</span>
          <span style="color:#7ee787; font-weight:700;">${valStr}</span>
        </div>
      `;
    }

    return `
      <div class="series-row">
        <div class="series-info">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="series-title">${isStructured && ind.name ? ind.name : k}</span>
            <span style="font-size:10px; color:var(--muted); font-family:var(--font-mono);">${k}</span>
            ${badge}
          </div>
          <div class="series-plots">
            ${plotsHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// -----------------------------------------------------------------------------
// Tab 2: Visual Nested Rule Builder (Arbitrary AND / OR Depth)
// -----------------------------------------------------------------------------

let conditionTreeData = {
  logicalOperator: 'AND',
  conditions: [
    {
      id: 'c_' + Math.random().toString(36).substring(2, 9),
      leftSource: { type: 'OHLCV', field: 'close' },
      operator: 'CROSSES_ABOVE',
      rightSource: { type: 'VALUE', value: 100 }
    }
  ]
};

// Restore saved condition tree draft if present
try {
  const savedTree = localStorage.getItem('tv_saved_condition_tree');
  if (savedTree) {
    const parsed = JSON.parse(savedTree);
    if (parsed && Array.isArray(parsed.conditions) && parsed.conditions.length > 0) {
      conditionTreeData = parsed;
    }
  }
} catch (_) {}

let treeFocusListenerAttached = false;

function autoSaveConditionTree() {
  try {
    localStorage.setItem('tv_saved_condition_tree', JSON.stringify(conditionTreeData));
  } catch (_) {}
}

function renderConditionTree() {
  const rootEl = document.getElementById('ruleTreeRoot');
  if (!rootEl) return;
  autoSaveConditionTree();
  rootEl.innerHTML = '';
  rootEl.appendChild(createGroupNode(conditionTreeData, null, 0));

  if (!treeFocusListenerAttached) {
    treeFocusListenerAttached = true;
    rootEl.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!rootEl.contains(document.activeElement) && pendingSeriesUpdate) {
          pendingSeriesUpdate = false;
          updateAllSeriesSelects();
        }
      }, 150);
    });
  }
}

function createGroupNode(group, parentGroup, groupIndex) {
  const groupDiv = document.createElement('div');
  groupDiv.className = `condition-group ${group.logicalOperator === 'OR' ? 'op-or' : ''}`;

  // Header
  const header = document.createElement('div');
  header.className = 'group-header';

  const opToggle = document.createElement('button');
  opToggle.type = 'button';
  opToggle.className = `op-toggle-btn ${group.logicalOperator === 'OR' ? 'or-active' : ''}`;
  opToggle.textContent = `Group: ${group.logicalOperator}`;
  opToggle.addEventListener('click', () => {
    group.logicalOperator = group.logicalOperator === 'AND' ? 'OR' : 'AND';
    renderConditionTree();
  });

  const headerActions = document.createElement('div');
  headerActions.style.display = 'flex';
  headerActions.style.gap = '6px';

  const addCondBtn = document.createElement('button');
  addCondBtn.type = 'button';
  addCondBtn.className = 'btn btn-sm';
  addCondBtn.textContent = '+ Condition';
  addCondBtn.addEventListener('click', () => {
    group.conditions.push({
      id: 'c_' + Math.random().toString(36).substring(2, 9),
      leftSource: { type: 'OHLCV', field: 'close' },
      operator: '>',
      rightSource: { type: 'VALUE', value: 0 }
    });
    renderConditionTree();
  });

  const addGroupBtn = document.createElement('button');
  addGroupBtn.type = 'button';
  addGroupBtn.className = 'btn btn-sm';
  addGroupBtn.textContent = '+ Sub-Group';
  addGroupBtn.addEventListener('click', () => {
    group.conditions.push({
      logicalOperator: 'AND',
      conditions: [
        {
          id: 'c_' + Math.random().toString(36).substring(2, 9),
          leftSource: { type: 'OHLCV', field: 'close' },
          operator: '>',
          rightSource: { type: 'VALUE', value: 0 }
        }
      ]
    });
    renderConditionTree();
  });

  headerActions.appendChild(addCondBtn);
  headerActions.appendChild(addGroupBtn);

  if (parentGroup) {
    const removeGroupBtn = document.createElement('button');
    removeGroupBtn.type = 'button';
    removeGroupBtn.className = 'btn btn-sm btn-red';
    removeGroupBtn.textContent = '✕ Group';
    removeGroupBtn.addEventListener('click', () => {
      parentGroup.conditions.splice(groupIndex, 1);
      renderConditionTree();
    });
    headerActions.appendChild(removeGroupBtn);
  }

  header.appendChild(opToggle);
  header.appendChild(headerActions);
  groupDiv.appendChild(header);

  // Conditions list
  group.conditions.forEach((item, idx) => {
    if (item.conditions) {
      // Sub-group
      groupDiv.appendChild(createGroupNode(item, group, idx));
    } else {
      // Single condition row
      groupDiv.appendChild(createConditionRowNode(item, group, idx));
    }
  });

  return groupDiv;
}

function createConditionRowNode(cond, parentGroup, index) {
  const row = document.createElement('div');
  row.className = 'condition-row';

  // 1. Left Source Dropdown (Zero Typing)
  const leftSelect = document.createElement('select');
  leftSelect.className = 'series-select series-select-left';
  leftSelect.setAttribute('data-current-source', JSON.stringify(cond.leftSource));
  populateSeriesOptions(leftSelect, cond.leftSource);
  leftSelect.addEventListener('change', () => {
    const sel = leftSelect.options[leftSelect.selectedIndex];
    if (sel && sel.getAttribute('data-source')) {
      const src = JSON.parse(sel.getAttribute('data-source'));
      cond.leftSource = src;
      leftSelect.setAttribute('data-current-source', JSON.stringify(src));
      autoSaveConditionTree();
    }
  });

  // 2. Operator Dropdown
  const opSelect = document.createElement('select');
  opSelect.className = 'operator-select';
  const operators = [
    { value: '>', label: '> (Greater)' },
    { value: '<', label: '< (Less)' },
    { value: '>=', label: '>= (GTE)' },
    { value: '<=', label: '<= (LTE)' },
    { value: '==', label: '== (Equal)' },
    { value: '!=', label: '!= (Not Equal)' },
    { value: 'CROSSES_ABOVE', label: 'CROSSES ABOVE' },
    { value: 'CROSSES_BELOW', label: 'CROSSES BELOW' },
    { value: 'RISING', label: 'RISING' },
    { value: 'FALLING', label: 'FALLING' },
    { value: 'PCT_CHANGE_GTE', label: '% CHANGE >=' },
    { value: 'PCT_CHANGE_LTE', label: '% CHANGE <=' }
  ];
  opSelect.innerHTML = operators.map(o => `
    <option value="${o.value}" ${cond.operator === o.value ? 'selected' : ''}>${o.label}</option>
  `).join('');
  opSelect.addEventListener('change', () => {
    const prevOperator = cond.operator;
    cond.operator = opSelect.value;
    autoSaveConditionTree();
    const prevNeedsLookback = ['RISING', 'FALLING', 'PCT_CHANGE_GTE', 'PCT_CHANGE_LTE'].includes(prevOperator);
    const newNeedsLookback = ['RISING', 'FALLING', 'PCT_CHANGE_GTE', 'PCT_CHANGE_LTE'].includes(cond.operator);
    const prevMomentum = ['RISING', 'FALLING'].includes(prevOperator);
    const newMomentum = ['RISING', 'FALLING'].includes(cond.operator);

    // Only re-render if the DOM structure changes (lookback row or momentum toggle)
    if (prevNeedsLookback !== newNeedsLookback || prevMomentum !== newMomentum) {
      renderConditionTree();
    }
  });

  // 3. Right Source Container (Toggle between Value vs Series)
  const rightContainer = document.createElement('div');
  rightContainer.className = 'right-source-container';

  const isMomentum = ['RISING', 'FALLING'].includes(cond.operator);

  if (!isMomentum) {
    const isRightValue = cond.rightSource?.type === 'VALUE';

    // Right Type Toggle Button
    const typeToggle = document.createElement('button');
    typeToggle.type = 'button';
    typeToggle.className = 'btn btn-sm btn-type-toggle';
    typeToggle.textContent = isRightValue ? '123' : '📈';
    typeToggle.title = isRightValue ? 'Switch to compare against an Indicator/OHLCV' : 'Switch to compare against a static Value';
    typeToggle.addEventListener('click', () => {
      if (isRightValue) {
        cond.rightSource = { type: 'OHLCV', field: 'close' };
      } else {
        cond.rightSource = { type: 'VALUE', value: 0 };
      }
      renderConditionTree();
    });

    rightContainer.appendChild(typeToggle);

    if (isRightValue) {
      const valInput = document.createElement('input');
      valInput.type = 'number';
      valInput.step = 'any';
      valInput.className = 'right-val-input';
      valInput.value = cond.rightSource?.value ?? 0;
      valInput.addEventListener('input', () => {
        cond.rightSource.value = parseFloat(valInput.value) || 0;
        autoSaveConditionTree();
      });
      rightContainer.appendChild(valInput);
    } else {
      const rightSelect = document.createElement('select');
      rightSelect.className = 'series-select series-select-right';
      rightSelect.setAttribute('data-current-source', JSON.stringify(cond.rightSource));
      populateSeriesOptions(rightSelect, cond.rightSource);
      rightSelect.addEventListener('change', () => {
        const sel = rightSelect.options[rightSelect.selectedIndex];
        if (sel && sel.getAttribute('data-source')) {
          const src = JSON.parse(sel.getAttribute('data-source'));
          cond.rightSource = src;
          rightSelect.setAttribute('data-current-source', JSON.stringify(src));
          autoSaveConditionTree();
        }
      });
      rightContainer.appendChild(rightSelect);
    }
  } else {
    const momentumNote = document.createElement('span');
    momentumNote.className = 'momentum-note';
    momentumNote.textContent = 'over lookback';
    rightContainer.appendChild(momentumNote);
  }

  // 4. Remove Button
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-sm btn-red btn-condition-remove';
  removeBtn.title = 'Remove this condition';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    parentGroup.conditions.splice(index, 1);
    renderConditionTree();
  });

  row.appendChild(leftSelect);
  row.appendChild(opSelect);
  row.appendChild(rightContainer);
  row.appendChild(removeBtn);

  // Lookback input for RISING, FALLING, and PCT_CHANGE
  if (['RISING', 'FALLING', 'PCT_CHANGE_GTE', 'PCT_CHANGE_LTE'].includes(cond.operator)) {
    const lookbackRow = document.createElement('div');
    lookbackRow.className = 'condition-row-lookback';
    lookbackRow.innerHTML = `
      <span>Lookback Bars (N):</span>
      <input type="number" min="1" max="100" value="${cond.lookback || 1}" style="width:50px; padding:2px 4px; font-size:10px;" />
    `;
    const lbInput = lookbackRow.querySelector('input');
    lbInput.addEventListener('input', () => {
      cond.lookback = parseInt(lbInput.value, 10) || 1;
      autoSaveConditionTree();
    });
    row.appendChild(lookbackRow);
  }

  return row;
}

function populateSeriesOptions(selectEl, selectedSource) {
  selectEl.innerHTML = '';
  const series = discoveredSeriesList && discoveredSeriesList.length > 0 ? discoveredSeriesList : [
    { id: 'ohlcv:close', label: 'Price: Close', sourceObj: { type: 'OHLCV', field: 'close' } },
    { id: 'ohlcv:open', label: 'Price: Open', sourceObj: { type: 'OHLCV', field: 'open' } },
    { id: 'ohlcv:high', label: 'Price: High', sourceObj: { type: 'OHLCV', field: 'high' } },
    { id: 'ohlcv:low', label: 'Price: Low', sourceObj: { type: 'OHLCV', field: 'low' } },
    { id: 'ohlcv:volume', label: 'Volume (OHLCV)', sourceObj: { type: 'OHLCV', field: 'volume' } },
  ];

  const ohlcvItems = series.filter(s => s.sourceObj?.type === 'OHLCV');
  const indicatorItems = series.filter(s => s.sourceObj?.type === 'INDICATOR');
  const otherItems = series.filter(s => s.sourceObj?.type !== 'OHLCV' && s.sourceObj?.type !== 'INDICATOR');

  let hasMatched = false;

  function appendGroup(groupLabel, items) {
    if (!items || items.length === 0) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupLabel;

    items.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      opt.setAttribute('data-source', JSON.stringify(item.sourceObj));

      // Match check
      if (!hasMatched) {
        if (selectedSource?.type === 'OHLCV' && item.sourceObj?.type === 'OHLCV' && selectedSource.field === item.sourceObj.field) {
          opt.selected = true;
          hasMatched = true;
        } else if (
          selectedSource?.type === 'INDICATOR' &&
          item.sourceObj?.type === 'INDICATOR' &&
          selectedSource.indicatorKey === item.sourceObj.indicatorKey &&
          (selectedSource.plotKey === item.sourceObj.plotKey || (!selectedSource.plotKey && item.sourceObj.plotKey === 'value'))
        ) {
          opt.selected = true;
          hasMatched = true;
        }
      }

      optgroup.appendChild(opt);
    });

    selectEl.appendChild(optgroup);
  }

  appendGroup('📊 Price & Volume (OHLCV)', ohlcvItems);
  appendGroup('📈 Chart Indicators & Plots', indicatorItems);
  if (otherItems.length > 0) {
    appendGroup('Other Available Series', otherItems);
  }

  // If no match was selected yet, default to first option
  if (!hasMatched && selectEl.options.length > 0) {
    selectEl.options[0].selected = true;
  }
}

// Auto-fill symbol & timeframe button
document.getElementById('btnAutoFillActiveTab')?.addEventListener('click', async () => {
  const hint = document.getElementById('symbolAutoSavedHint');
  if (hint) {
    hint.textContent = 'Scanning chart for symbol, timeframe & indicators...';
    hint.style.color = '#ffa726';
  }
  const fetched = await autoFetchFromChartTab(true);
  if (fetched) {
    if (hint) {
      hint.textContent = '✓ Active chart synchronized successfully!';
      hint.style.color = '#26a69a';
    }
  } else if (latestPayload) {
    const sym = cleanSymbol(latestPayload.symbol);
    const tf = cleanTimeframe(latestPayload.timeframe);
    if (sym) document.getElementById('ruleSymbolInput').value = sym;
    if (tf) document.getElementById('ruleTfInput').value = tf;
    saveActiveSymbolTf(sym, tf);
    if (hint) {
      hint.textContent = '✓ Populated from cached snapshot!';
      hint.style.color = '#26a69a';
    }
  } else {
    if (hint) {
      hint.textContent = 'Make sure a TradingView chart tab is open.';
      hint.style.color = '#ef5350';
    }
  }
});

document.getElementById('btnSendToBuilder')?.addEventListener('click', async () => {
  if (latestPayload) {
    const sym = cleanSymbol(latestPayload.symbol);
    const tf = cleanTimeframe(latestPayload.timeframe);
    if (sym) document.getElementById('ruleSymbolInput').value = sym;
    if (tf) document.getElementById('ruleTfInput').value = tf;
    saveActiveSymbolTf(sym, tf);
  } else {
    await autoFetchFromChartTab(false);
  }
  document.querySelector('[data-tab="tab-builder"]')?.click();
});

// Save Rule Button
document.getElementById('btnSaveRule')?.addEventListener('click', async () => {
  const name = document.getElementById('ruleNameInput').value.trim();
  const rawSymbol = document.getElementById('ruleSymbolInput').value.trim();
  const rawTf = document.getElementById('ruleTfInput').value.trim();
  const triggerMode = document.getElementById('ruleTriggerMode')?.value || 'BOTH';
  const symbol = cleanSymbol(rawSymbol);
  const tf = cleanTimeframe(rawTf);
  const hint = document.getElementById('ruleValidationHint');

  if (!name) {
    hint.textContent = '⚠ Please enter an Alert Name manually.';
    hint.style.color = '#ef5350';
    document.getElementById('ruleNameInput')?.focus();
    return;
  }
  if (!symbol || !tf) {
    hint.textContent = '⚠ Symbol or Timeframe missing. Click "Refresh From Active Chart".';
    hint.style.color = '#ef5350';
    return;
  }

  // Persist symbol and timeframe for future PC sessions
  saveActiveSymbolTf(symbol, tf);

  try {
    const res = await fetch(`${API_BASE}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        symbol,
        timeframe: tf,
        condition_tree: conditionTreeData,
        trigger_mode: triggerMode
      })
    });

    if (res.ok) {
      hint.textContent = '✓ Rule saved successfully!';
      hint.style.color = '#26a69a';
      document.getElementById('ruleNameInput').value = '';
      try {
        localStorage.removeItem('tv_saved_rule_name');
        localStorage.removeItem('tv_setting_draft_rule_name');
        localStorage.removeItem('tv_saved_condition_tree');
      } catch (_) {}
      setTimeout(() => {
        document.querySelector('[data-tab="tab-rules"]')?.click();
      }, 600);
      return;
    } else {
      const err = await res.json();
      hint.textContent = `Error: ${err.error || 'Failed to save'}`;
      hint.style.color = '#ef5350';
    }
  } catch (err) {
    // Self-healing / Auto-resolve: Save to chrome.storage.local for Standalone In-Browser Engine!
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const localData = await chrome.storage.local.get(['tvStandaloneRules']);
        const rules = localData.tvStandaloneRules || [];
        const newRule = {
          id: `rule_local_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          name,
          symbol,
          timeframe: tf,
          condition_tree: conditionTreeData,
          trigger_mode: triggerMode,
          status: 'ACTIVE_FALSE',
          trigger_count: 0,
          created_at: new Date().toISOString()
        };
        rules.unshift(newRule);
        await chrome.storage.local.set({ tvStandaloneRules: rules });
        hint.textContent = '✓ Saved to In-Browser Standalone Engine (Offline backup ready)!';
        hint.style.color = '#26a69a';
        document.getElementById('ruleNameInput').value = '';
        try { localStorage.removeItem('tv_saved_rule_name'); } catch (_) {}
        setTimeout(() => {
          document.querySelector('[data-tab="tab-rules"]')?.click();
        }, 600);
        return;
      } catch (_) {}
    }
    hint.textContent = `Network error: ${err.message}. Start service or check bridge.`;
    hint.style.color = '#ef5350';
  }
});

// -----------------------------------------------------------------------------
// Tab 3: Active Rules & Monitoring
// -----------------------------------------------------------------------------

async function loadActiveRules() {
  const tbody = document.getElementById('activeRulesTbody');
  if (!tbody) return;

  try {
    const res = await fetch(`${API_BASE}/api/rules`);
    const data = await res.json();
    const rules = data.rules || [];

    if (rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--muted); padding:16px;">No rules saved yet. Build one in Rule Builder!</td></tr>';
      return;
    }

    tbody.innerHTML = rules.map(r => {
      let badgeClass = 'badge-active-false';
      let statusLabel = r.status;
      let missingWarning = '';

      if (r.status === 'ACTIVE_TRUE') badgeClass = 'badge-active-true';
      else if (r.status === 'PAUSED_DATA_UNAVAILABLE') {
        badgeClass = 'badge-paused';
        statusLabel = 'PAUSED';
        if (r.missing_indicators) {
          missingWarning = `<div style="font-size:9px; color:var(--orange); margin-top:2px;" title="${r.missing_indicators}">Missing: ${r.missing_indicators}</div>`;
        }
      } else if (r.status === 'DISABLED') badgeClass = 'badge-disabled';

      const summary = formatRuleSummary(r.condition_tree);
      const isPaused = r.is_active === 0 || r.status === 'DISABLED';
      const toggleLabel = isPaused ? '▶ Resume' : '⏸ Pause';
      const cleanSym = cleanSymbol(r.symbol);
      const cleanTf = cleanTimeframe(r.timeframe);
      const triggerMode = r.trigger_mode || 'BOTH';
      let triggerBadge = '';
      if (triggerMode === 'CANDLE_CLOSE') {
        triggerBadge = '<div style="font-size:9px; color:#26a69a; margin-top:2px;" title="Confirmed on Candle Close Only">🔔 Close Only</div>';
      } else if (triggerMode === 'INTRABAR') {
        triggerBadge = '<div style="font-size:9px; color:#ffa726; margin-top:2px;" title="Live Market Intrabar Only">⚡ Live Only</div>';
      } else {
        triggerBadge = '<div style="font-size:9px; color:#7ee787; margin-top:2px;" title="Live Market + Confirmed Candle Close">⚡ Live + 🔔 Close</div>';
      }

      return `
        <tr>
          <td style="font-weight:600; color:var(--text-bright);">${r.name}</td>
          <td><code>${cleanSym}</code></td>
          <td><code>${cleanTf}</code></td>
          <td>
            <span class="badge ${badgeClass}">${statusLabel}</span>
            ${triggerBadge}
            ${missingWarning}
          </td>
          <td style="font-size:10px; color:var(--muted); max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${summary}">
            ${summary}
          </td>
          <td>${r.trigger_count}</td>
          <td>
            <div style="display:flex; gap:4px;">
              <button class="btn btn-sm" onclick="window.popupEditRule('${r.id}')">✏</button>
              <button class="btn btn-sm" onclick="window.popupToggleRule('${r.id}')">${toggleLabel}</button>
              <button class="btn btn-sm btn-red" onclick="window.popupDeleteRule('${r.id}')">✕</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--red);">Failed to load rules: ${err.message}</td></tr>`;
  }
}

window.popupEditRule = async (id) => {
  try {
    const res = await fetch(`${API_BASE}/api/rules/${id}`);
    const data = await res.json();
    const r = data.rule;
    if (!r) return;

    document.getElementById('ruleNameInput').value = r.name || '';
    document.getElementById('ruleSymbolInput').value = cleanSymbol(r.symbol);
    document.getElementById('ruleTfInput').value = cleanTimeframe(r.timeframe);

    if (r.trigger_mode) {
      const modeSelect = document.getElementById('ruleTriggerMode');
      if (modeSelect) modeSelect.value = r.trigger_mode;
      try { localStorage.setItem('tv_saved_trigger_mode', r.trigger_mode); } catch (_) {}
    }

    if (r.condition_tree) {
      conditionTreeData = typeof r.condition_tree === 'string' ? JSON.parse(r.condition_tree) : r.condition_tree;
      renderConditionTree();
    }

    document.querySelector('[data-tab="tab-builder"]')?.click();
  } catch (err) {
    alert('Failed to load rule: ' + err.message);
  }
};

function formatRuleSummary(tree) {
  if (!tree) return '—';
  if (typeof tree === 'string') {
    try { tree = JSON.parse(tree); } catch (_) { return tree; }
  }
  if (tree.conditions && Array.isArray(tree.conditions)) {
    const parts = tree.conditions.map(c => {
      if (c.conditions) return `(${formatRuleSummary(c)})`;
      const l = c.leftSource?.indicatorKey || c.leftSource?.field || 'L';
      const r = c.rightSource?.type === 'VALUE' ? c.rightSource.value : (c.rightSource?.plotKey || c.rightSource?.indicatorKey || c.rightSource?.field || 'R');
      return `${l} ${c.operator} ${r}`;
    });
    return parts.join(` ${tree.logicalOperator || 'AND'} `);
  }
  return 'Rule';
}

window.popupToggleRule = async (id) => {
  await fetch(`${API_BASE}/api/rules/${id}/toggle`, { method: 'POST' });
  loadActiveRules();
};

window.popupDeleteRule = async (id) => {
  if (!confirm('Delete this alert rule?')) return;
  await fetch(`${API_BASE}/api/rules/${id}`, { method: 'DELETE' });
  loadActiveRules();
};

document.getElementById('btnRefreshRules')?.addEventListener('click', loadActiveRules);

// -----------------------------------------------------------------------------
// Tab 4: Triggered Alerts History & Settings
// -----------------------------------------------------------------------------

async function loadAlertsHistory() {
  const tbody = document.getElementById('alertsHistoryTbody');
  if (!tbody) return;

  try {
    const res = await fetch(`${API_BASE}/api/alerts?limit=25`);
    const data = await res.json();
    const alerts = data.alerts || [];

    if (alerts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:14px;">No alerts triggered yet.</td></tr>';
      return;
    }

    tbody.innerHTML = alerts.map(a => {
      const time = new Date(a.triggered_at).toLocaleTimeString();
      const typeBadge = a.is_candle_close === 1
        ? '<span style="color:#26a69a;">Close</span>'
        : '<span style="color:#ffa726;">Intrabar</span>';
      const price = a.snapshot?.ohlcv?.close != null ? Number(a.snapshot.ohlcv.close).toFixed(2) : '—';
      const tgStatus = a.telegram_sent
        ? '<span style="color:#4caf50;">✓ Sent</span>'
        : '<span style="color:#8b949e;">—</span>';

      const cleanSym = cleanSymbol(a.symbol);
      const cleanTf = cleanTimeframe(a.timeframe);

      return `
        <tr>
          <td><code>${time}</code></td>
          <td style="font-weight:600; color:var(--text-bright);">${a.rule_name}</td>
          <td><code>${cleanSym} ${cleanTf}</code></td>
          <td>${typeBadge}</td>
          <td><code>${price}</code></td>
          <td>${tgStatus}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--red);">Error: ${err.message}</td></tr>`;
  }
}

let tgAutoSaveTimeout = null;
function handleTelegramSettingAutoSave() {
  const token = document.getElementById('tgTokenInput')?.value.trim() || '';
  const chatId = document.getElementById('tgChatIdInput')?.value.trim() || '';
  const badge = document.getElementById('tgStatusBadge');

  if (badge) {
    if (token && chatId) {
      badge.className = 'badge badge-readable';
      badge.textContent = 'Configured (Ready)';
    } else {
      badge.className = 'badge badge-unavailable';
      badge.textContent = 'Not Configured';
    }
  }

  // Instant local save
  try {
    localStorage.setItem('tv_tg_bot_token', token);
    localStorage.setItem('tv_tg_chat_id', chatId);
  } catch (_) {}

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ telegram_bot_token: token, telegram_chat_id: chatId }).catch(() => {});
  }

  // Debounced backend sync
  if (tgAutoSaveTimeout) clearTimeout(tgAutoSaveTimeout);
  tgAutoSaveTimeout = setTimeout(() => {
    fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_bot_token: token, telegram_chat_id: chatId })
    }).catch(() => {});
  }, 400);
}

async function loadSettings() {
  const tokenInput = document.getElementById('tgTokenInput');
  const chatIdInput = document.getElementById('tgChatIdInput');
  const badge = document.getElementById('tgStatusBadge');

  let savedToken = '';
  let savedChatId = '';

  // 1. Try chrome.storage.local
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const data = await chrome.storage.local.get(['telegram_bot_token', 'telegram_chat_id']);
      if (data.telegram_bot_token) savedToken = data.telegram_bot_token;
      if (data.telegram_chat_id) savedChatId = data.telegram_chat_id;
    } catch (_) {}
  }

  // 2. Try localStorage
  if (!savedToken) {
    try { savedToken = localStorage.getItem('tv_tg_bot_token') || ''; } catch (_) {}
  }
  if (!savedChatId) {
    try { savedChatId = localStorage.getItem('tv_tg_chat_id') || ''; } catch (_) {}
  }

  // 3. Try backend if available
  try {
    const res = await fetch(`${API_BASE}/api/settings`, { signal: AbortSignal.timeout(600) });
    if (res.ok) {
      const data = await res.json();
      if (data.settings?.telegram_chat_id && !savedChatId) {
        savedChatId = data.settings.telegram_chat_id;
      }
    }
  } catch (_) {}

  if (tokenInput && savedToken) tokenInput.value = savedToken;
  if (chatIdInput && savedChatId) chatIdInput.value = savedChatId;

  // Auto-save on every character typed or pasted
  tokenInput?.removeEventListener('input', handleTelegramSettingAutoSave);
  tokenInput?.addEventListener('input', handleTelegramSettingAutoSave);
  tokenInput?.removeEventListener('change', handleTelegramSettingAutoSave);
  tokenInput?.addEventListener('change', handleTelegramSettingAutoSave);

  chatIdInput?.removeEventListener('input', handleTelegramSettingAutoSave);
  chatIdInput?.addEventListener('input', handleTelegramSettingAutoSave);
  chatIdInput?.removeEventListener('change', handleTelegramSettingAutoSave);
  chatIdInput?.addEventListener('change', handleTelegramSettingAutoSave);

  if (badge) {
    if (savedToken && savedChatId) {
      badge.className = 'badge badge-readable';
      badge.textContent = 'Configured (Ready)';
    } else {
      badge.className = 'badge badge-unavailable';
      badge.textContent = 'Not Configured';
    }
  }

  // 4. Restore and auto-save Trigger Timing mode (Live Market & Candle Close)
  const triggerModeSelect = document.getElementById('ruleTriggerMode');
  if (triggerModeSelect) {
    try {
      const savedMode = localStorage.getItem('tv_setting_trigger_mode') || localStorage.getItem('tv_saved_trigger_mode');
      if (savedMode) triggerModeSelect.value = savedMode;
    } catch (_) {}
    triggerModeSelect.removeEventListener('change', handleTriggerModeChange);
    triggerModeSelect.addEventListener('change', handleTriggerModeChange);
  }

  // 5. Restore and auto-save Extractor Timeframe
  const tfSelect = document.getElementById('timeframeSelect');
  if (tfSelect) {
    try {
      const savedTf = localStorage.getItem('tv_setting_timeframe_select');
      if (savedTf) tfSelect.value = savedTf;
    } catch (_) {}
    tfSelect.removeEventListener('change', handleTfSelectChange);
    tfSelect.addEventListener('change', handleTfSelectChange);
  }

  // 6. Restore and auto-save Extractor Timezone
  const tzSelect = document.getElementById('timezoneSelect');
  if (tzSelect) {
    try {
      const savedTz = localStorage.getItem('tv_setting_timezone_select');
      if (savedTz) tzSelect.value = savedTz;
    } catch (_) {}
    tzSelect.removeEventListener('change', handleTzSelectChange);
    tzSelect.addEventListener('change', handleTzSelectChange);
  }

  // 7. Restore and auto-save Stream toggle
  const streamToggle = document.getElementById('streamToggle');
  if (streamToggle) {
    try {
      const savedStream = localStorage.getItem('tv_setting_stream_toggle');
      if (savedStream !== null) streamToggle.checked = savedStream === 'true';
    } catch (_) {}
    streamToggle.removeEventListener('change', handleStreamToggleChange);
    streamToggle.addEventListener('change', handleStreamToggleChange);
  }

  // 8. Restore and auto-save Draft Rule Name
  const ruleNameInput = document.getElementById('ruleNameInput');
  if (ruleNameInput) {
    try {
      const savedName = localStorage.getItem('tv_setting_draft_rule_name');
      if (savedName && !ruleNameInput.value) ruleNameInput.value = savedName;
    } catch (_) {}
    ruleNameInput.removeEventListener('input', handleRuleNameInput);
    ruleNameInput.addEventListener('input', handleRuleNameInput);
  }
}

function handleTriggerModeChange(e) {
  const mode = e.target.value;
  try {
    localStorage.setItem('tv_setting_trigger_mode', mode);
    localStorage.setItem('tv_saved_trigger_mode', mode);
  } catch (_) {}
}

function handleTfSelectChange(e) {
  try { localStorage.setItem('tv_setting_timeframe_select', e.target.value); } catch (_) {}
}

function handleTzSelectChange(e) {
  try { localStorage.setItem('tv_setting_timezone_select', e.target.value); } catch (_) {}
}

function handleStreamToggleChange(e) {
  try { localStorage.setItem('tv_setting_stream_toggle', e.target.checked ? 'true' : 'false'); } catch (_) {}
}

function handleRuleNameInput(e) {
  try { localStorage.setItem('tv_setting_draft_rule_name', e.target.value); } catch (_) {}
}

function restoreActiveTab() {
  try {
    const savedTab = localStorage.getItem('tv_active_tab');
    if (savedTab) {
      const btn = document.querySelector(`.tab-nav-btn[data-tab="${savedTab}"]`);
      const pane = document.getElementById(savedTab);
      if (btn && pane) {
        document.querySelectorAll('.tab-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        pane.classList.add('active');
        if (savedTab === 'tab-rules') loadActiveRules();
        if (savedTab === 'tab-history') { loadAlertsHistory(); loadSettings(); }
      }
    }
  } catch (_) {}
}

// Toggle Show/Hide Token
document.getElementById('btnToggleTgToken')?.addEventListener('click', () => {
  const input = document.getElementById('tgTokenInput');
  const btn = document.getElementById('btnToggleTgToken');
  if (input) {
    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.textContent = '🔒';
    } else {
      input.type = 'password';
      if (btn) btn.textContent = '👁';
    }
  }
});

// Save & Test Telegram Connection
document.getElementById('btnSaveAndTestTelegram')?.addEventListener('click', async () => {
  const token = document.getElementById('tgTokenInput')?.value.trim();
  const chatId = document.getElementById('tgChatIdInput')?.value.trim();
  const fb = document.getElementById('settingsFeedback');
  const badge = document.getElementById('tgStatusBadge');

  if (fb) {
    fb.style.display = 'block';
    fb.style.background = '#2a2415';
    fb.style.color = '#ffa726';
    fb.style.border = '1px solid #ffa726';
    fb.textContent = '⏳ Testing connection to Telegram API...';
  }

  if (!token || !chatId) {
    if (fb) {
      fb.style.background = '#2d1b1b';
      fb.style.color = '#ef5350';
      fb.style.border = '1px solid #ef5350';
      fb.textContent = '⚠ Please enter both Telegram Bot Token and Chat ID above.';
    }
    return;
  }

  // Persist locally in chrome.storage.local & localStorage
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ telegram_bot_token: token, telegram_chat_id: chatId }).catch(() => {});
  }
  try {
    localStorage.setItem('tv_tg_bot_token', token);
    localStorage.setItem('tv_tg_chat_id', chatId);
  } catch (_) {}

  // Sync with backend if available
  try {
    fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_bot_token: token, telegram_chat_id: chatId })
    }).catch(() => {});
  } catch (_) {}

  // Step 1: Validate Bot Token via getMe
  let botUsername = '';
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meData = await meRes.json();
    if (!meData.ok) {
      const errDesc = meData.description || 'Invalid Bot Token (401 Unauthorized)';
      if (fb) {
        fb.style.background = '#2d1b1b';
        fb.style.color = '#ef5350';
        fb.style.border = '1px solid #ef5350';
        fb.innerHTML = `❌ <strong>Token Error:</strong> ${errDesc}.<br>Verify your token from <code>@BotFather</code>.`;
      }
      if (badge) {
        badge.className = 'badge badge-unavailable';
        badge.textContent = 'Invalid Token';
      }
      return;
    }
    botUsername = meData.result?.username || 'Bot';
  } catch (netErr) {
    console.warn('Direct getMe check error:', netErr);
  }

  // Step 2: Send test alert message
  const testMsg = `✅ <b>TradingView Multi-Condition Alert Test</b>\n` +
    `🤖 <b>Bot:</b> @${botUsername || 'TradingAlertsBot'}\n` +
    `🎯 <b>Chat ID:</b> <code>${chatId}</code>\n` +
    `⏱ <b>Timestamp:</b> ${new Date().toUTCString()}\n\n` +
    `<i>Congratulations! Your Telegram connection is fully verified and active.</i>`;

  try {
    const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: testMsg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const sendData = await sendRes.json();

    if (sendData.ok) {
      if (fb) {
        fb.style.background = '#152b22';
        fb.style.color = '#26a69a';
        fb.style.border = '1px solid #26a69a';
        fb.innerHTML = `✓ <strong>Connected to Telegram!</strong> Bot: <code>@${botUsername}</code>.<br>Test message delivered to Chat ID <code>${chatId}</code>! Check your Telegram app.`;
      }
      if (badge) {
        badge.className = 'badge badge-readable';
        badge.textContent = `Active (@${botUsername})`;
      }
      return;
    } else {
      let errMsg = sendData.description || 'Message delivery failed';
      if (errMsg.includes('chat not found') || errMsg.includes('chat_id is empty')) {
        errMsg = `Chat ID not found (${chatId}). You MUST open <strong>@${botUsername}</strong> in Telegram and click <strong>/start</strong> first!`;
      }
      if (fb) {
        fb.style.background = '#2d1b1b';
        fb.style.color = '#ef5350';
        fb.style.border = '1px solid #ef5350';
        fb.innerHTML = `❌ <strong>Telegram Delivery Error:</strong> ${errMsg}`;
      }
      if (badge) {
        badge.className = 'badge badge-unavailable';
        badge.textContent = 'Chat Not Found';
      }
      return;
    }
  } catch (err) {
    // Backend fallback if direct browser fetch failed
    try {
      const bRes = await fetch(`${API_BASE}/api/test-telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_token: token, chat_id: chatId })
      });
      const bData = await bRes.json();
      if (bData.ok) {
        if (fb) {
          fb.style.background = '#152b22';
          fb.style.color = '#26a69a';
          fb.style.border = '1px solid #26a69a';
          fb.textContent = '✓ Telegram test message delivered successfully via Backend Service!';
        }
        if (badge) {
          badge.className = 'badge badge-readable';
          badge.textContent = 'Active (Ready)';
        }
        return;
      }
    } catch (_) {}

    if (fb) {
      fb.style.background = '#2d1b1b';
      fb.style.color = '#ef5350';
      fb.style.border = '1px solid #ef5350';
      fb.textContent = '❌ Failed to reach Telegram API: ' + err.message;
    }
  }
});

document.getElementById('btnTestTelegram')?.addEventListener('click', () => {
  document.getElementById('btnSaveAndTestTelegram')?.click();
});

document.getElementById('btnTestChime')?.addEventListener('click', () => {
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: 'TEST_AUDIO', sound: 'chime' });
  }
  // Also invoke directly if offscreen/audioCtx available
  if (typeof window.playTone === 'function') {
    window.playTone('chime');
  }
});

document.getElementById('btnPruneHistory')?.addEventListener('click', async () => {
  if (!confirm('Prune alerts and snapshots older than 30 days?')) return;
  try {
    const res = await fetch(`${API_BASE}/api/prune`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 30 }) });
    const data = await res.json();
    alert(`Pruning complete! Removed ${data.prunedAlerts || 0} old alerts and ${data.prunedSnapshots || 0} snapshots.`);
    loadAlertsHistory();
  } catch (e) {
    alert('Pruning error: ' + e.message);
  }
});

// -----------------------------------------------------------------------------
// Tab 5: CSV Extractor Backward Compatibility
// -----------------------------------------------------------------------------

const captureBtn = document.getElementById('captureBtn');
const streamToggle = document.getElementById('streamToggle');
const output = document.getElementById('output');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const fetchBtn = document.getElementById('fetchBtn');
const rangeNote = document.getElementById('rangeNote');

captureBtn?.addEventListener('click', async () => {
  if (latestPayload) {
    output.value = JSON.stringify(latestPayload, null, 2);
  } else {
    output.value = 'Requesting candle snapshot from active TradingView tab...';
    if (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'TV_GET_SNAPSHOT' });
          if (res?.data) {
            handleIncomingPayload(res.data);
            output.value = JSON.stringify(res.data, null, 2);
          }
        }
      } catch (_) {
        output.value = 'No chart response. Make sure a TradingView tab is open and active.';
      }
    }
  }
});

streamToggle?.addEventListener('change', async () => {
  const isStreaming = streamToggle.checked;
  if (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: isStreaming ? 'TV_STREAM_START' : 'TV_STREAM_STOP',
        intervalMs: 1000
      }).catch(() => {});
    }
  }
});

copyBtn?.addEventListener('click', () => {
  if (output?.value) {
    navigator.clipboard.writeText(output.value);
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = '📋 Copy JSON'; }, 1500);
  }
});

downloadBtn?.addEventListener('click', () => {
  if (!output?.value) return;
  const blob = new Blob([output.value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tv_snapshot_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

fetchBtn?.addEventListener('click', async () => {
  const tf = document.getElementById('timeframeSelect')?.value || '3m';
  const start = document.getElementById('startInput')?.value;
  const end = document.getElementById('endInput')?.value;

  if (!start || !end) {
    rangeNote.textContent = 'Please choose both Start and End date/time.';
    rangeNote.style.color = '#ef5350';
    return;
  }

  rangeNote.textContent = 'Connecting to chart and fetching range data...';
  rangeNote.style.color = '#ffa726';

  if (typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const startMs = new Date(start).getTime();
        const endMs = new Date(end).getTime();
        const tz = document.getElementById('timezoneSelect')?.value || 'auto';
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: 'TV_FETCH_RANGE',
          startMs,
          endMs,
          requestedTimeframe: tf,
          requestedTimezone: tz
        });

        if (res?.ok && res.data?.csv) {
          rangeNote.textContent = `✓ Exported ${res.data.count || 0} bars to CSV!`;
          rangeNote.style.color = '#26a69a';
          // Trigger download
          const blob = new Blob([res.data.csv], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = res.data.filename || `tv_range_${Date.now()}.csv`;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          rangeNote.textContent = `Error: ${res?.error || 'Range fetch failed'}`;
          rangeNote.style.color = '#ef5350';
        }
      }
    } catch (e) {
      rangeNote.textContent = 'Communication error: ' + e.message;
      rangeNote.style.color = '#ef5350';
    }
  }
});

// -----------------------------------------------------------------------------
// Chrome Runtime Message Listener (Ticking from Content Script)
// -----------------------------------------------------------------------------

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TV_STREAM_PAYLOAD' && msg.payload) {
      handleIncomingPayload(msg.payload);
    } else if (msg && msg.type === 'TV_STREAM_TICK' && msg.data) {
      handleIncomingPayload(msg.data);
    }
  });
}

// -----------------------------------------------------------------------------
// Auto-Fetch Active Chart Tab (Symbol, Timeframe & Indicators)
// -----------------------------------------------------------------------------

async function autoFetchFromChartTab(showFeedback = true) {
  const statusEl = document.getElementById('chartAutoFetchStatus');
  if (statusEl && showFeedback) {
    statusEl.textContent = 'Scanning chart...';
    statusEl.style.color = '#ffa726';
  }

  let targetTab = null;
  let tvTabsCount = 0;
  if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
    try {
      // 1. Check active tab in current window
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.url && (activeTab.url.includes('tradingview.com') || activeTab.url.includes('tradingview.cn'))) {
        targetTab = activeTab;
      }
      // 2. Query any open TradingView tabs
      const tvTabs = await chrome.tabs.query({ url: ['*://*.tradingview.com/*', '*://*.tradingview.cn/*'] });
      if (tvTabs && tvTabs.length > 0) {
        tvTabsCount = tvTabs.length;
        if (!targetTab) targetTab = tvTabs.find(t => t.active) || tvTabs[0];
      }
    } catch (_) {}
  }

  if (targetTab && targetTab.id) {
    try {
      const res = await chrome.tabs.sendMessage(targetTab.id, { type: 'TV_GET_SNAPSHOT' });
      if (res && res.data && (res.data.symbol || res.data.close != null || res.data.ohlcv?.close != null)) {
        const cleanSym = cleanSymbol(res.data.symbol);
        const cleanTf = cleanTimeframe(res.data.timeframe);
        res.data.symbol = cleanSym || res.data.symbol;
        res.data.timeframe = cleanTf || res.data.timeframe;
        handleIncomingPayload(res.data);
        const indCount = res.data.indicators ? Object.keys(res.data.indicators).length : 0;
        if (statusEl) {
          statusEl.textContent = `✓ Synced with chart: ${cleanSym || 'Chart'} (${cleanTf || ''}) [${indCount} ind]`;
          statusEl.style.color = '#26a69a';
        }
        updateStatusIndicators(null, {
          state: 'green',
          label: `Chart: Connected (${cleanSym || 'TV'} [${cleanTf || 'Auto'}])`
        });
        return true;
      }
    } catch (err) {
      // If content script not yet active in existing TV tab, inject dynamically
      try {
        if (typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content.js']
          });
          await new Promise(r => setTimeout(r, 350));
          const retryRes = await chrome.tabs.sendMessage(targetTab.id, { type: 'TV_GET_SNAPSHOT' });
          if (retryRes && retryRes.data && (retryRes.data.symbol || retryRes.data.close != null || retryRes.data.ohlcv?.close != null)) {
            const cleanSym = cleanSymbol(retryRes.data.symbol);
            const cleanTf = cleanTimeframe(retryRes.data.timeframe);
            retryRes.data.symbol = cleanSym || retryRes.data.symbol;
            retryRes.data.timeframe = cleanTf || retryRes.data.timeframe;
            handleIncomingPayload(retryRes.data);
            if (statusEl) {
              statusEl.textContent = `✓ Auto-injected & synced: ${cleanSym || 'Chart'} (${cleanTf || ''})`;
              statusEl.style.color = '#26a69a';
            }
            updateStatusIndicators(null, {
              state: 'green',
              label: `Chart: Connected (${cleanSym || 'TV'} [${cleanTf || 'Auto'}])`
            });
            return true;
          }
        }
      } catch (_) {}
    }
    // Tab found, but chart data not ready yet
    updateStatusIndicators(null, { state: 'amber', label: `Chart: Waiting for Data (${tvTabsCount} Tab${tvTabsCount > 1 ? 's' : ''})` });
  } else {
    // No TradingView tab found
    updateStatusIndicators(null, { state: 'red', label: 'Chart: No TradingView Tab' });
  }

  // Fallback to recent backend indicators if available
  try {
    await fetchLatestIndicators();
  } catch (_) {}

  return false;
}

// -----------------------------------------------------------------------------
// Status Controls & Navigation Handlers
// -----------------------------------------------------------------------------

// "Check Status / Retry" Button
document.getElementById('btnCheckStatus')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnCheckStatus');
  if (btn) btn.textContent = '🔄 Checking...';

  updateStatusIndicators(
    { state: 'amber', label: 'Backend: Checking...' },
    { state: 'amber', label: 'Chart: Checking...' },
    null
  );

  await detectService(true);
  await autoFetchFromChartTab(true);
  await refreshMonitoringStatus();

  if (btn) {
    btn.textContent = '✓ Updated';
    setTimeout(() => { btn.textContent = '🔄 Check Status / Retry'; }, 1500);
  }
});

// CSV Screen "Back to Home" Button
document.getElementById('btnCsvBackToHome')?.addEventListener('click', () => {
  document.querySelector('.tab-nav-btn[data-tab="tab-inspector"]')?.click();
});

async function startBridgeConnectionAndFetch(interactive = false) {
  await detectService(interactive);
  await autoFetchFromChartTab(true);
  await refreshMonitoringStatus();
}

document.getElementById('btnOneClickBridge')?.addEventListener('click', async () => {
  const btn = document.getElementById('btnOneClickBridge');
  const original = btn ? btn.textContent : '';
  if (btn) btn.textContent = '⚡ Connecting...';
  await startBridgeConnectionAndFetch(true);
  if (btn) btn.textContent = original;
});

// Bridge Assistant Modal listeners
document.getElementById('btnCloseBridgeModal')?.addEventListener('click', () => {
  const m = document.getElementById('bridgeLaunchModal');
  if (m) m.style.display = 'none';
});

document.getElementById('btnAssistantRetryConnect')?.addEventListener('click', async () => {
  const st = document.getElementById('bridgeAssistantStatus');
  if (st) st.textContent = 'Scanning all ports...';
  await startBridgeConnectionAndFetch(true);
});

document.getElementById('btnAssistantCopyCommand')?.addEventListener('click', () => {
  navigator.clipboard.writeText('npm run dev');
  const btn = document.getElementById('btnAssistantCopyCommand');
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ <strong>Command Copied (npm run dev)!</strong>';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }
});

document.getElementById('btnAssistantDownloadBat')?.addEventListener('click', () => {
  const batContent = `@echo off\ncd /d "%~dp0"\ntitle TradingView Multi-Condition Alert Generator\necho Starting Local PC Service...\nwhere node >nul 2>nul || (echo [ERROR] Node.js missing! && pause && exit /b 1)\nif not exist "%~dp0node_modules\\express" call npm install\nnode server.js\npause\n`;
  const blob = new Blob([batContent], { type: 'application/x-bat' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'start_service.bat';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btnAssistantOpenWebConsole')?.addEventListener('click', () => {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    chrome.tabs.create({ url: API_BASE || 'http://localhost:3000' });
  } else {
    window.open(API_BASE || 'http://localhost:3000', '_blank');
  }
});

// -----------------------------------------------------------------------------
// Cross-Browser Alert Transfer (Export / Import Rules)
// -----------------------------------------------------------------------------

async function getExportRulesData() {
  try {
    const res = await fetch(`${API_BASE}/api/rules/export`);
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (_) {}

  // Fallback: build backup from locally stored rules
  let localRules = [];
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['tvStandaloneRules']);
      localRules = stored.tvStandaloneRules || [];
    } catch (_) {}
  }

  return {
    version: '2.0.0',
    app: 'TradingView Multi-Condition Alert Generator',
    exported_at: new Date().toISOString(),
    count: localRules.length,
    rules: localRules
  };
}

async function openTransferModal(tab = 'export') {
  const modal = document.getElementById('transferModal');
  if (!modal) return;
  modal.style.display = 'flex';

  const exportPane = document.getElementById('transferExportPane');
  const importPane = document.getElementById('transferImportPane');
  const exportTabBtn = document.getElementById('tabBtnTransferExport');
  const importTabBtn = document.getElementById('tabBtnTransferImport');

  if (tab === 'export') {
    if (exportPane) exportPane.style.display = 'block';
    if (importPane) importPane.style.display = 'none';
    exportTabBtn?.classList.add('active');
    importTabBtn?.classList.remove('active');

    const data = await getExportRulesData();
    const txtArea = document.getElementById('transferExportText');
    if (txtArea) {
      txtArea.value = JSON.stringify(data, null, 2);
    }
  } else {
    if (exportPane) exportPane.style.display = 'none';
    if (importPane) importPane.style.display = 'block';
    importTabBtn?.classList.add('active');
    exportTabBtn?.classList.remove('active');
  }
}

document.getElementById('btnOpenTransferModal')?.addEventListener('click', () => openTransferModal('export'));
document.getElementById('btnExportRulesQuick')?.addEventListener('click', () => openTransferModal('export'));
document.getElementById('btnImportRulesQuick')?.addEventListener('click', () => openTransferModal('import'));

document.getElementById('btnCloseTransferModal')?.addEventListener('click', () => {
  const m = document.getElementById('transferModal');
  if (m) m.style.display = 'none';
});

document.getElementById('tabBtnTransferExport')?.addEventListener('click', () => openTransferModal('export'));
document.getElementById('tabBtnTransferImport')?.addEventListener('click', () => openTransferModal('import'));

document.getElementById('btnDownloadRulesJson')?.addEventListener('click', async () => {
  const data = await getExportRulesData();
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().slice(0, 10);
  a.download = `tradingview_alerts_backup_${dateStr}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btnCopyRulesJson')?.addEventListener('click', () => {
  const txtArea = document.getElementById('transferExportText');
  if (txtArea && txtArea.value) {
    navigator.clipboard.writeText(txtArea.value);
    const btn = document.getElementById('btnCopyRulesJson');
    if (btn) {
      btn.textContent = '✓ Copied to Clipboard!';
      setTimeout(() => { btn.textContent = '📋 Copy to Clipboard'; }, 2000);
    }
  }
});

// File upload for Import
document.getElementById('transferFileInput')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const content = ev.target?.result;
    const txt = document.getElementById('transferImportText');
    if (txt && content) {
      txt.value = content;
    }
  };
  reader.readAsText(file);
});

// Execute Import Button
document.getElementById('btnExecuteImport')?.addEventListener('click', async () => {
  const txt = document.getElementById('transferImportText');
  const fb = document.getElementById('transferFeedback');
  const raw = txt?.value?.trim();

  if (!raw) {
    if (fb) {
      fb.textContent = 'Please paste backup JSON or select a file first.';
      fb.style.color = '#ef5350';
    }
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (fb) {
      fb.textContent = 'Invalid JSON format: ' + err.message;
      fb.style.color = '#ef5350';
    }
    return;
  }

  const rulesList = Array.isArray(parsed) ? parsed : (parsed.rules || []);
  if (!Array.isArray(rulesList) || rulesList.length === 0) {
    if (fb) {
      fb.textContent = 'No valid alert rules found in backup JSON.';
      fb.style.color = '#ef5350';
    }
    return;
  }

  if (fb) {
    fb.textContent = `Importing ${rulesList.length} alert rules...`;
    fb.style.color = '#ffa726';
  }

  let importedBackend = false;
  try {
    const res = await fetch(`${API_BASE}/api/rules/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: rulesList, mode: 'merge' })
    });
    if (res.ok) {
      importedBackend = true;
    }
  } catch (_) {}

  // Also store into standalone storage so offline usage is preserved
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(['tvStandaloneRules']);
      const current = stored.tvStandaloneRules || [];
      const combined = [...rulesList, ...current];
      // Deduplicate by name + symbol + timeframe
      const seen = new Set();
      const deduped = combined.filter(r => {
        const key = `${r.name}_${r.symbol}_${r.timeframe}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await chrome.storage.local.set({ tvStandaloneRules: deduped });
    } catch (_) {}
  }

  if (fb) {
    fb.textContent = `✓ Successfully transferred and activated ${rulesList.length} rules!`;
    fb.style.color = '#26a69a';
  }

  loadActiveRules();
  setTimeout(() => {
    const m = document.getElementById('transferModal');
    if (m) m.style.display = 'none';
  }, 1200);
});

// -----------------------------------------------------------------------------
// Initialization & Automatic Chart Polling
// -----------------------------------------------------------------------------

restoreActiveSymbolTf();
detectService();
checkChartAvailability();
renderConditionTree();
loadSettings();
restoreActiveTab();
autoFetchFromChartTab(true);
refreshMonitoringStatus();

// Periodically synchronize with chart and check tab availability while side panel is open
setInterval(() => {
  autoFetchFromChartTab(false);
  checkChartAvailability();
}, 3500);

document.getElementById('btnReconnectBridge')?.addEventListener('click', () => {
  const fb = document.getElementById('settingsFeedback');
  if (fb) fb.textContent = 'Probing Local PC Service ports...';
  detectService();
  fetchLatestIndicators();
  autoFetchFromChartTab(true);
});

document.getElementById('btnRefreshInspector')?.addEventListener('click', () => {
  fetchLatestIndicators();
  autoFetchFromChartTab(true);
});

// Try loading last snapshot from storage on startup
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(['tvLastSnapshot']).then((res) => {
    if (res?.tvLastSnapshot) {
      handleIncomingPayload(res.tvLastSnapshot);
    }
  }).catch(() => {});
}

// Set default datetime inputs (past 24 hours)
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
function toLocalDatetimeString(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const startInput = document.getElementById('startInput');
const endInput = document.getElementById('endInput');
if (startInput && !startInput.value) startInput.value = toLocalDatetimeString(yesterday);
if (endInput && !endInput.value) endInput.value = toLocalDatetimeString(now);

// Expose on window for external callers, tests, and iframe coordination
window.handleIncomingPayload = handleIncomingPayload;
window.formatRuleSummary = formatRuleSummary;
window.rebuildDiscoveredSeriesList = rebuildDiscoveredSeriesList;
window.renderConditionTree = renderConditionTree;
window.conditionTreeData = conditionTreeData;
window.autoFetchFromChartTab = autoFetchFromChartTab;
window.startBridgeConnectionAndFetch = startBridgeConnectionAndFetch;
window.openTransferModal = openTransferModal;

