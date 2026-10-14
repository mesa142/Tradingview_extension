/**
 * tests/run.js — end-to-end tests for the extraction engine.
 * Run: node tests/run.js
 */

'use strict';

const { bootTVDom, TF_MS } = require('./harness');

let pass = 0;
let fail = 0;

function check(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? `\n        ${extra}` : ''}`);
  }
}

const HOUR = 3600 * 1000;

async function t1_capture() {
  console.log('\nT1  Capture snapshot (renamed build, split-node legend)');
  const { send, candles } = bootTVDom();
  const res = await send({ type: 'TV_GET_SNAPSHOT' });
  const d = res?.data ?? {};
  check(res?.ok === true, 'ok', JSON.stringify(res));
  check(d.symbol === 'SENSEX', `symbol SENSEX (got ${d.symbol})`);
  check(d.timeframe === '5m', `timeframe 5m (got ${d.timeframe})`);
  const last = candles[candles.length - 1];
  check(d.open === last.open && d.close === last.close,
    'OHLC matches hovered candle', JSON.stringify({ got: [d.open, d.high, d.low, d.close], want: [last.open, last.high, last.low, last.close] }));

  const keys = Object.keys(d.indicators ?? {});
  const volKeys = keys.filter((k) => k.startsWith('Vol'));
  const mbKeys = keys.filter((k) => k.startsWith('MktBreadth'));
  check(volKeys.length >= 1, `Vol keys present (${volKeys.join(', ')})`);
  check(mbKeys.length === 4, `MktBreadth has 4 plots (${mbKeys.join(', ')})`);
  const garbage = keys.filter((k) => /[A-Za-z]\d/.test(k));
  check(garbage.length === 0, `no concatenated name garbage (bad: ${garbage.join(', ')})`);
  // Values track the LAST candle (no hover in this test): vol = 200 + 59 = 259.
  check(d.indicators?.[volKeys[0]] === 259,
    `Vol[0] == 259 for the last candle (got ${d.indicators?.[volKeys[0]]})`);
  check(d.indicators?.[volKeys[1]] === 239,
    `Vol[1] (Volume MA) == 239 (got ${d.indicators?.[volKeys[1]]})`);
}

async function t2_sweepRange() {
  console.log('\nT2  Range export via legend sweep (internal model UNREACHABLE)');
  const { send, candles } = bootTVDom();
  const start = candles[0].epochMs - HOUR;
  const end = candles[candles.length - 1].epochMs + HOUR;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: start, endMs: end });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (got error=${res?.error}: ${res?.message ?? ''})`,
    JSON.stringify({ diagnostics: d.diagnostics }));
  check(d.count >= 40, `count >= 40 (got ${d.count})`);
  check(/^Symbol,Timeframe,Datetime,Open,High,Low,Close/.test(d.csv ?? ''), 'CSV header correct',
    (d.csv ?? '').split('\r\n')[0]);
  const lines = (d.csv ?? '').split('\r\n');
  check(lines.length === d.count + 1, `CSV rows == count+1 (${lines.length} vs ${d.count + 1})`);
  check(d.preview?.every((r) => r.datetime && r.datetime.length === 19), 'every preview row has YYYY-MM-DD HH:MM:SS');
  check(d.timestampsEstimated === false, `timestamps are real, not estimated (flag=${d.timestampsEstimated})`);
  check(d.method === 'pointer-sweep', `method pointer-sweep (got ${d.method})`);
  check(d.diagnostics?.distinctCandles === d.count, `diagnostics distinctCandles == count (${d.diagnostics?.distinctCandles} vs ${d.count})`);
  check((d.diagnostics?.legendChangedSteps ?? 0) > 0,
    `legend text actually changed during the sweep (got ${d.diagnostics?.legendChangedSteps})`);
}

async function t3_invalidRange() {
  console.log('\nT3  Invalid date range is rejected');
  const { send, candles } = bootTVDom({ candleCount: 5 });
  const a = candles[2].epochMs;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: a + HOUR, endMs: a });
  check(res?.ok === false && res?.error === 'INVALID_RANGE', `INVALID_RANGE (got ${res?.error})`);

  const fut = await send({ type: 'TV_FETCH_RANGE', startMs: Date.now() + HOUR, endMs: Date.now() + 2 * HOUR });
  check(fut?.ok === false && fut?.error === 'INVALID_RANGE', `future start rejected (got ${fut?.error})`);
}

async function t4_tooLarge() {
  console.log('\nT4  Oversized range is refused before any work');
  const { send } = bootTVDom({ candleCount: 5 });
  const now = Date.now();
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: now - 365 * 24 * HOUR, endMs: now });
  check(res?.ok === false && res?.error === 'RANGE_TOO_LARGE', `RANGE_TOO_LARGE (got ${res?.error})`, JSON.stringify(res));
}

async function t5_dataModel() {
  console.log('\nT5  Range export via internal data model (Method A reachable)');
  const { send, candles } = bootTVDom({ model: true });
  const start = candles[10].epochMs;
  const end = candles[39].epochMs;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: start, endMs: end });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  check(d.count === 30, `exactly 30 candles in [10..39] (got ${d.count})`);
  check(d.method === 'data-model', `method data-model (got ${d.method})`);
  const first = (d.csv ?? '').split('\r\n')[1] ?? '';
  check(first.startsWith('SENSEX,5m,'), `first CSV row has symbol+tf (got ${first.slice(0, 30)})`);
}

async function t6_zeroLayoutCanvas() {
  console.log('\nT6  Degraded: canvas has no layout box -> precise error, not a mystery');
  const { send } = bootTVDom({ canvasLayout: false });
  const now = Date.now();
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: now - 2 * HOUR, endMs: now });
  check(res?.ok === false, 'returned an error');
  check(res?.error === 'CANVAS_NO_LAYOUT', `CANVAS_NO_LAYOUT (got ${res?.error})`, JSON.stringify(res?.data?.diagnostics));
  check(!!res?.data?.diagnostics?.canvas, 'diagnostics included in the error payload');
}

async function t7_crosshairNotMoving() {
  console.log('\nT7  Degraded: crosshair cannot move -> HOVER_NOT_MOVING (was MODEL_UNREACHABLE)');
  const { send } = bootTVDom({ workingCrosshair: false });
  const now = Date.now();
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: now - 2 * HOUR, endMs: now });
  check(res?.ok === false, 'returned an error');
  check(res?.error === 'HOVER_NOT_MOVING', `HOVER_NOT_MOVING (got ${res?.error})`, JSON.stringify(res?.data?.diagnostics));
  const dg = res?.data?.diagnostics ?? {};
  check(dg.seriesFoundSteps > 0, `diagnostics show the legend WAS found (${dg.seriesFoundSteps} steps)`);
  check(dg.ohlcReadSteps > 0, `diagnostics show OHLC WAS readable (${dg.ohlcReadSteps} steps)`);
  check((dg.distinctCandles ?? 0) <= 1, `only 1 distinct candle (got ${dg.distinctCandles})`);
}

async function t8_noTimestamps() {
  console.log('\nT8  Sweep with NO hover-time label -> timestamps estimated, still exports');
  const { send, candles } = bootTVDom({ hoverTimeVisible: false });
  const start = candles[0].epochMs - HOUR;
  const end = candles[candles.length - 1].epochMs + HOUR;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: start, endMs: end });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (got ${res?.error}: ${res?.message ?? ''})`, JSON.stringify(d.diagnostics));
  check(d.timestampsEstimated === true, `timestampsEstimated=true (got ${d.timestampsEstimated})`);
  check(d.preview?.every((r) => r.datetime), 'Datetime still populated (estimated, not blank)');
  check((d.warnings ?? []).some((w) => /TIMESTAMPS_ESTIMATED/.test(w)), 'TIMESTAMPS_ESTIMATED warning present');
}

async function t9_decoyCanvas() {
  console.log('\nT9  15-canvas build: a LARGER overlay canvas with no listener must not win');
  const { send, candles } = bootTVDom({ decoyCanvas: true });
  const start = candles[0].epochMs - HOUR;
  const end = candles[candles.length - 1].epochMs + HOUR;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: start, endMs: end });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (got error=${res?.error}: ${res?.message ?? ''})`,
    JSON.stringify(d.diagnostics));
  check(d.count >= 40, `count >= 40 despite the decoy (got ${d.count})`);
  check(/price/.test(d.diagnostics?.responsiveCanvas ?? ''),
    `probe picked the real pane (got ${d.diagnostics?.responsiveCanvas})`);
  const probe = (d.diagnostics?.canvasProbe ?? []).join(' | ');
  check(/decoy.*moved=false/.test(probe), `decoy rejected as unresponsive (${probe})`);
  check(/price.*moved=true/.test(probe), `price accepted as responsive (${probe})`);
  check((d.diagnostics?.legendChangedSteps ?? 0) > 0, 'legend changed during sweep');
}

async function t10_customTimeframe() {
  console.log('\nT10 Custom / Requested Timeframe export');
  const { send, candles } = bootTVDom({ model: true, timeframe: '5' });
  const start = candles[10].epochMs;
  const end = candles[39].epochMs;
  // Request 1h instead of default 5m
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: start, endMs: end, requestedTimeframe: '1h' });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  check(d.timeframe === '1h', `timeframe switched to 1h (got ${d.timeframe})`);
  const first = (d.csv ?? '').split('\r\n')[1] ?? '';
  check(first.startsWith('SENSEX,1h,'), `first CSV row has symbol+1h (got ${first.slice(0, 30)})`);
}

async function t11_indicatorColumnsWithParameters() {
  console.log('\nT11 Export all indicators with parameters into dedicated columns');
  const firstHarness = bootTVDom({ model: true, candleCount: 2 });
  const c1Time = firstHarness.candles[0].epochMs;
  const c2Time = firstHarness.candles[1].epochMs;
  const mockStudies = [
    {
      name: 'RSI (14, close)',
      points: [
        { epochMs: c1Time, value: 55.4 },
        { epochMs: c2Time, value: 62.1 },
      ],
    },
    {
      name: 'MACD (12, 26, close, 9)',
      plots: ['MACD', 'Signal', 'Histogram'],
      points: [
        { epochMs: c1Time, value: [1.25, 0.95, 0.30] },
        { epochMs: c2Time, value: [1.40, 1.05, 0.35] },
      ],
    },
  ];

  const { send } = bootTVDom({ model: true, candleCount: 2, studies: mockStudies });
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: c1Time, endMs: c2Time });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  const header = (d.csv ?? '').split('\r\n')[0] ?? '';
  check(header.includes('RSI (14, close)'), 'CSV header has RSI with parameters', header);
  check(header.includes('MACD (12, 26, close, 9) [MACD]'), 'CSV header has MACD plot', header);
  check(header.includes('MACD (12, 26, close, 9) [Signal]'), 'CSV header has Signal plot', header);
  check(header.includes('MACD (12, 26, close, 9) [Histogram]'), 'CSV header has Histogram plot', header);
  const rows = (d.csv ?? '').split('\r\n');
  check(rows.length === 3, `3 lines total: header + 2 candles (got ${rows.length})`);
  check(rows[2].includes('62.1'), 'last row has RSI calculated value 62.1');
}

async function t12_calculatedIndicatorHistoricalValues() {
  console.log('\nT12 Historical indicator data calculation when model study buffer is missing');
  const { dom, send, candles } = bootTVDom({ model: true, candleCount: 30, studies: [] });
  // Add an RSI indicator row to the DOM legend
  const legend = dom.window.document.getElementById('legend');
  const rsiRow = dom.window.document.createElement('div');
  rsiRow.className = 'indRow';
  rsiRow.innerHTML = '<span class="t">RSI (14, close)</span><span class="value">64.50</span>';
  legend.appendChild(rsiRow);

  const startMs = candles[0].epochMs;
  const endMs = candles[candles.length - 1].epochMs;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs, endMs });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  const lines = (d.csv ?? '').split('\r\n');
  const header = lines[0] ?? '';
  check(header.includes('RSI (14, close)'), 'CSV header includes RSI (14, close)', header);
  check(lines.length === 31, `31 lines total: header + 30 candles (got ${lines.length})`);

  // Parse RFC-4180 CSV line considering quoted commas
  const parseCSVRow = (line) => {
    const re = /(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^",]*))/g;
    const out = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
    }
    return out;
  };

  const headerCols = parseCSVRow(header);
  const rsiColIdx = headerCols.indexOf('RSI (14, close)');
  check(rsiColIdx !== -1, 'found RSI column index in header');
  const lastRow = parseCSVRow(lines[lines.length - 1]);
  const midRow = parseCSVRow(lines[20]);
  check(lastRow[rsiColIdx] !== '' && lastRow[rsiColIdx] != null, `last row has non-empty RSI value (got ${lastRow[rsiColIdx]})`);
  check(midRow[rsiColIdx] !== '' && midRow[rsiColIdx] != null, `row 20 has non-empty RSI value (got ${midRow[rsiColIdx]})`);
  check(Number.isFinite(Number(lastRow[rsiColIdx])), `last row RSI is a valid number (got ${lastRow[rsiColIdx]})`);
  check(Number.isFinite(Number(midRow[rsiColIdx])), `row 20 RSI is a valid number (got ${midRow[rsiColIdx]})`);
}

async function t13_customPineScriptSweepBackfill() {
  console.log('\nT13 Custom Pine Script indicator sweep backfill and static levels');
  const { dom, send, candles } = bootTVDom({ candleCount: 30 });
  const legend = dom.window.document.getElementById('legend');
  
  // Add SENSEX UT ADX V1.5 with static level plots
  const adxRow = dom.window.document.createElement('div');
  adxRow.className = 'indRow';
  adxRow.innerHTML = '<span class="t">SENSEX UT ADX V1.5</span>' +
    '<span class="value" title="SENSEX Weighted UT Breadth">-0.41</span>' +
    '<span class="value" title="UT Breadth EMA">-2.39</span>' +
    '<span class="value" title="+50">50.00</span>' +
    '<span class="value" title="-50">-50.00</span>';
  legend.appendChild(adxRow);

  const startMs = candles[0].epochMs;
  const endMs = candles[candles.length - 1].epochMs;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs, endMs });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  const lines = (d.csv ?? '').split('\r\n');
  const header = lines[0] ?? '';
  check(header.includes('MktBreadth'), 'CSV header includes MktBreadth', header);
  check(header.includes('SENSEX UT ADX V1.5 › +50'), 'CSV header includes +50 level', header);
  check(header.includes('SENSEX UT ADX V1.5 › -50'), 'CSV header includes -50 level', header);
  check(lines.length === 31, `31 lines total: header + 30 candles (got ${lines.length})`);

  const parseCSVRow = (line) => {
    const re = /(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^",]*))/g;
    const out = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : (m[2] ?? ''));
    }
    return out;
  };

  const headerCols = parseCSVRow(header);
  const p50Idx = headerCols.indexOf('SENSEX UT ADX V1.5 › +50');
  const m50Idx = headerCols.indexOf('SENSEX UT ADX V1.5 › -50');
  const mb0Idx = headerCols.findIndex((c) => c.startsWith('MktBreadth'));

  check(p50Idx !== -1, 'found +50 column index');
  check(m50Idx !== -1, 'found -50 column index');
  check(mb0Idx !== -1, 'found MktBreadth column index');

  const row1 = parseCSVRow(lines[1]);
  const row15 = parseCSVRow(lines[15]);
  const rowLast = parseCSVRow(lines[30]);

  check(row1[p50Idx] === '50', `row 1 +50 level populated (got ${row1[p50Idx]})`);
  check(row15[p50Idx] === '50', `row 15 +50 level populated (got ${row15[p50Idx]})`);
  check(rowLast[p50Idx] === '50', `last row +50 level populated (got ${rowLast[p50Idx]})`);

  check(row1[m50Idx] === '-50', `row 1 -50 level populated (got ${row1[m50Idx]})`);
  check(row15[m50Idx] === '-50', `row 15 -50 level populated (got ${row15[m50Idx]})`);
  check(rowLast[m50Idx] === '-50', `last row -50 level populated (got ${rowLast[m50Idx]})`);

  check(row1[mb0Idx] !== '' && row1[mb0Idx] != null, `row 1 MktBreadth populated (got ${row1[mb0Idx]})`);
  check(row15[mb0Idx] !== '' && row15[mb0Idx] != null, `row 15 MktBreadth populated (got ${row15[mb0Idx]})`);
  check(rowLast[mb0Idx] !== '' && rowLast[mb0Idx] != null, `last row MktBreadth populated (got ${rowLast[mb0Idx]})`);
}

async function t14_outOfMarketHoursLoadedBarsFallback() {
  console.log('\nT14 Out of market hours / non-trading period loaded bars fallback');
  const { send, candles } = bootTVDom({ model: true, candleCount: 20 });
  // Request a window between candles where no candle exists (simulating market closed / weekend)
  const start = candles[2].epochMs + 1000;
  const end = candles[2].epochMs + 10000;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs: start, endMs: end });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  check(d.count === 20, `exported all 20 loaded candles despite requested range having 0 candles (got ${d.count})`);
  check((d.warnings ?? []).some((w) => /no trading candles/i.test(w)), 'warning explains no trading candles in requested range');
  const lines = (d.csv ?? '').split('\r\n');
  check(lines.length === 21, `21 lines total: header + 20 candles (got ${lines.length})`);
}

async function t15_multiPlotPineScriptModelPoints() {
  console.log('\nT15 Multi-plot Pine Script indicators per-bar continuous historical values');
  const candleCount = 10;
  const mockStudies = [
    {
      name: 'MktBreadth (SENSEX, Top 30, 5, 21, true, true, 14, 60, 40, true, 10, 1.5, Index Weightage %, true, t)',
      plots: ['Combined Breadth', 'Adaptive Signal', 'Breadth Momentum'],
      points: [],
    },
    {
      name: 'VolSTEALTH v7',
      plots: ['Volume', 'Volume MA'],
      points: [],
    },
  ];

  const firstHarness = bootTVDom({ model: true, candleCount });
  const candles = firstHarness.candles;

  for (let i = 0; i < candleCount; i++) {
    const cTime = candles[i].epochMs;
    mockStudies[0].points.push({
      index: i,
      epochMs: cTime,
      value: [
        +(10 + i * 2.5).toFixed(2),
        +(-5 + i * 1.2).toFixed(2),
        +(3 + i * 0.8).toFixed(2),
      ],
    });
    mockStudies[1].points.push({
      index: i,
      epochMs: cTime,
      value: [
        +(150 + i * 10).toFixed(1),
        +(140 + i * 8).toFixed(1),
      ],
    });
  }

  const { send } = bootTVDom({ model: true, candleCount, studies: mockStudies });
  const startMs = candles[0].epochMs;
  const endMs = candles[candleCount - 1].epochMs;
  const res = await send({ type: 'TV_FETCH_RANGE', startMs, endMs });
  const d = res?.data ?? {};
  check(res?.ok === true, `ok (error=${res?.error ?? ''})`);
  check(d.count === candleCount, `exported ${candleCount} candles`);

  const lines = (d.csv ?? '').split('\r\n');
  check(lines.length === candleCount + 1, `CSV has header + ${candleCount} rows (got ${lines.length})`);

  const parseCSVRow = (line) => {
    const re = /(?:^|,)(?:"([^"]*(?:""[^"]*)*)"|([^",]*))/g;
    const out = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : (m[2] ?? ''));
    }
    return out;
  };

  const headerCols = parseCSVRow(lines[0]);
  const combinedIdx = headerCols.findIndex((c) => c.includes('Combined Breadth'));
  const adaptiveIdx = headerCols.findIndex((c) => c.includes('Adaptive Signal'));
  const breadthMomIdx = headerCols.findIndex((c) => c.includes('Breadth Momentum'));
  const stealthVolIdx = headerCols.findIndex((c) => c.includes('VolSTEALTH') && c.includes('Volume'));

  check(combinedIdx !== -1, 'Combined Breadth column exists in CSV');
  check(adaptiveIdx !== -1, 'Adaptive Signal column exists in CSV');
  check(breadthMomIdx !== -1, 'Breadth Momentum column exists in CSV');
  check(stealthVolIdx !== -1, 'VolSTEALTH Volume column exists in CSV');

  const r1 = parseCSVRow(lines[1]);
  const rLast = parseCSVRow(lines[candleCount]);

  check(r1[combinedIdx] !== '' && r1[combinedIdx] != null, `row 1 Combined Breadth populated (got ${r1[combinedIdx]})`);
  check(rLast[combinedIdx] !== '' && rLast[combinedIdx] != null, `last row Combined Breadth populated (got ${rLast[combinedIdx]})`);
  check(r1[combinedIdx] !== rLast[combinedIdx], `values change per candle (row 1: ${r1[combinedIdx]}, last: ${rLast[combinedIdx]})`);

  check(r1[breadthMomIdx] !== '' && r1[breadthMomIdx] != null, `row 1 Breadth Momentum populated (got ${r1[breadthMomIdx]})`);
  check(rLast[breadthMomIdx] !== '' && rLast[breadthMomIdx] != null, `last row Breadth Momentum populated (got ${rLast[breadthMomIdx]})`);
  check(r1[breadthMomIdx] !== rLast[breadthMomIdx], `breadth momentum changes per candle (row 1: ${r1[breadthMomIdx]}, last: ${rLast[breadthMomIdx]})`);

  check(r1[stealthVolIdx] !== '' && r1[stealthVolIdx] != null, `row 1 VolSTEALTH populated (got ${r1[stealthVolIdx]})`);
  check(rLast[stealthVolIdx] !== '' && rLast[stealthVolIdx] != null, `last row VolSTEALTH populated (got ${rLast[stealthVolIdx]})`);
  check(r1[stealthVolIdx] !== rLast[stealthVolIdx], `VolSTEALTH changes per candle (row 1: ${r1[stealthVolIdx]}, last: ${rLast[stealthVolIdx]})`);
}

(async () => {
  const started = Date.now();
  await t1_capture();
  await t2_sweepRange();
  await t3_invalidRange();
  await t4_tooLarge();
  await t5_dataModel();
  await t6_zeroLayoutCanvas();
  await t7_crosshairNotMoving();
  await t8_noTimestamps();
  await t9_decoyCanvas();
  await t10_customTimeframe();
  await t11_indicatorColumnsWithParameters();
  await t12_calculatedIndicatorHistoricalValues();
  await t13_customPineScriptSweepBackfill();
  await t14_outOfMarketHoursLoadedBarsFallback();
  await t15_multiPlotPineScriptModelPoints();
  console.log(`\n${pass} passed, ${fail} failed  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  process.exit(fail ? 1 : 0);
})();
