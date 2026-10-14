/**
 * injected.js — runs in the PAGE's main world (not the content-script isolated world).
 *
 * Purpose (Method A — "Preferred / Most Robust"):
 *   TradingView renders candles on <canvas>, so DOM scraping alone can never
 *   give us timestamps or full history. The real data lives inside the page's
 *   JS chart widget model. This file safely probes for that model without
 *   breaking the page, then exposes a minimal read-only snapshot API:
 *
   *     window.__TV_EXTRACTOR__.getSnapshot()
   *       -> { symbol, timeframe, bars: [{time, open, high, low, close, ...}], source }
   *       -> or { error, hint } when the widget isn't reachable (yet).
   *     window.__TV_EXTRACTOR__.getRange(startMs, endMs)
   *       -> { bars, studies, earliestMs, latestMs, totalLoaded } filtered to range
   *     window.__TV_EXTRACTOR__.scrollChart('older' | 'newer', steps)
   *       -> { ok, methods } best-effort auto-pan to backfill older history
 *
 * It NEVER writes to the chart, NEVER overrides TradingView functions, and
 * wraps everything in try/catch so a failed probe cannot break the page.
 *
 * Loading: content.js injects this file via a <script src="chrome-extension://.../injected.js">
 * tag (see manifest `web_accessible_resources`), which is the MV3-safe way to
 * enter the page context.
 */

(() => {
  'use strict';

  // Guard against double-injection (SPA navigations can re-run content.js).
  // Re-injectable when the API version differs (allows upgrades without reload).
  if (window.__TV_EXTRACTOR__?.version === '2.0.0') return;

  /** Last-known-good snapshot, returned stale-while-revalidating. */
  let lastSnapshot = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Safe number coercion: "1,234.5" -> 1234.5, garbage -> null (never NaN). */
  function toNum(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** Epoch seconds (TradingView native) -> { epochMs, iso }. */
  function timeToStamp(t) {
    // TradingView bar times are usually UNIX seconds (sometimes ms).
    let epochMs = null;
    if (typeof t === 'number' && Number.isFinite(t)) {
      epochMs = t > 1e12 ? t : t > 1e10 ? t : t * 1000;
    } else if (typeof t === 'string' && t) {
      const parsed = Date.parse(t);
      if (!Number.isNaN(parsed)) epochMs = parsed;
    }
    return {
      epochMs,
      iso: epochMs != null ? new Date(epochMs).toISOString() : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Probe 1: official widget library (embedded widgets + some TV pages)
  //   window.TradingView.widget instances expose chart() / activeChart().
  // ---------------------------------------------------------------------------
  function probeOfficialWidget() {
    try {
      const TV = window.TradingView;
      if (!TV) return null;
      // Embedded widgets register themselves here in some builds.
      const candidates = [];
      if (Array.isArray(TV.widgets)) candidates.push(...TV.widgets);
      if (TV.widget) candidates.push(TV.widget);
      if (window.tvWidget) candidates.push(window.tvWidget);

      for (const w of candidates) {
        try {
          const chart = typeof w?.activeChart === 'function'
            ? w.activeChart()
            : typeof w?.chart === 'function' ? w.chart() : null;
          if (!chart) continue;
          // getSeries / getStudies would give us real bars if exposed.
          if (typeof chart.getSeries === 'function') {
            return { kind: 'official-widget', chart };
          }
        } catch { /* try next candidate */ }
      }
    } catch { /* non-fatal */ }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Probe 2: internal chart-widget collection (tradingview.com advanced chart)
  //   The advanced chart keeps its model on opaque internal objects. We do NOT
  //   depend on exact minified names — instead we duck-type: look for objects
  //   that smell like a chart (have activeChart / _chartWidget / panes etc.)
  //   reachable from a handful of known global roots.
  // ---------------------------------------------------------------------------
  function unwrapChart(obj) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return null;
    let curr = obj;
    for (let depth = 0; depth < 6; depth++) {
      if (!curr || (typeof curr !== 'object' && typeof curr !== 'function')) break;
      if (typeof curr.activeChartWidget === 'function') {
        try {
          const w = curr.activeChartWidget();
          if (w) { curr = typeof w.value === 'function' ? w.value() : (w.value || w); continue; }
        } catch {}
      }
      if (curr.activeChartWidget) {
        const val = typeof curr.activeChartWidget.value === 'function'
          ? curr.activeChartWidget.value()
          : (curr.activeChartWidget.value || curr.activeChartWidget);
        if (val && val !== curr && (typeof val === 'object' || typeof val === 'function')) { curr = val; continue; }
      }
      if (curr._activeChartWidget) {
        const val = typeof curr._activeChartWidget.value === 'function'
          ? curr._activeChartWidget.value()
          : (curr._activeChartWidget.value || curr._activeChartWidget);
        if (val && val !== curr && (typeof val === 'object' || typeof val === 'function')) { curr = val; continue; }
      }
      if (typeof curr.activeChart === 'function') {
        try { const c = curr.activeChart(); if (c && c !== curr && typeof c === 'object') { curr = c; continue; } } catch {}
      }
      if (typeof curr.getCharts === 'function') {
        try { const cs = curr.getCharts(); if (Array.isArray(cs) && cs[0] && cs[0] !== curr) { curr = cs[0]; continue; } } catch {}
      }
      if (Array.isArray(curr._chartWidgets) && curr._chartWidgets[0]) {
        curr = curr._chartWidgets[0];
        continue;
      }
      if (curr._chartWidget || curr.chartWidget) {
        curr = curr._chartWidget || curr.chartWidget;
        continue;
      }
      if (curr._chart || curr.chart) {
        const c = curr._chart || curr.chart;
        if (c && typeof c === 'object' && c !== curr) { curr = c; continue; }
      }
      break;
    }
    return curr;
  }

  function probeReactFiber() {
    try {
      if (typeof document === 'undefined') return null;
      const sels = ['.chart-container', '[data-name="chart-container"]', '.tv-chart-container', 'canvas'];
      for (const sel of sels) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
          if (!key) continue;
          let fiber = el[key];
          let depth = 0;
          while (fiber && depth < 40) {
            const sn = fiber.stateNode;
            if (sn) {
              if (looksLikeChart(sn)) return sn;
              if (sn._chartWidget && looksLikeChart(sn._chartWidget)) return sn._chartWidget;
              if (sn.chartWidget && looksLikeChart(sn.chartWidget)) return sn.chartWidget;
              if (sn._model && looksLikeChart(sn._model)) return sn._model;
              if (sn.model && looksLikeChart(sn.model)) return sn.model;
            }
            const props = fiber.memoizedProps;
            if (props) {
              if (props.chartWidget && looksLikeChart(props.chartWidget)) return props.chartWidget;
              if (props.chart && looksLikeChart(props.chart)) return props.chart;
              if (props.model && looksLikeChart(props.model)) return props.model;
              if (props.widget && looksLikeChart(props.widget)) return props.widget;
            }
            let s = fiber.memoizedState;
            while (s) {
              const stateVal = s.memoizedState;
              if (stateVal) {
                if (looksLikeChart(stateVal)) return stateVal;
                if (stateVal.current && looksLikeChart(stateVal.current)) return stateVal.current;
                if (stateVal.chart && looksLikeChart(stateVal.chart)) return stateVal.chart;
                if (stateVal.chartWidget && looksLikeChart(stateVal.chartWidget)) return stateVal.chartWidget;
                if (stateVal.model && looksLikeChart(stateVal.model)) return stateVal.model;
              }
              s = s.next;
            }
            fiber = fiber.return;
            depth++;
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  function* walkRoots() {
    // Known roots across TV builds. Keep this list small and read-only.
    const roots = [
      window.__chartWidgetCollection,
      window._chartWidgetCollection,
      window.chartWidgetCollection,
      window.tvChart,
      window._tv_chart,
      window.TradingView,
      window.TradingViewApi,
      window.TradingViewApi?._activeChartWidgetWV?.value?.(),
      window.TradingViewApi?._activeChartWidgetWV?.value?.()?._chartWidget,
      window.TradingViewApi?._chartWidgetCollection,
      window.ChartApiInstance,
    ];
    for (const r of roots) if (r) yield r;
    const reactChart = probeReactFiber();
    if (reactChart) yield reactChart;
    // Last resort: scan a bounded number of window keys for chart-like objs.
    // Bounded (150 keys, depth 1) to avoid perf hits on this heavy page.
    try {
      const keys = Object.keys(window).slice(0, 150);
      for (const k of keys) {
        if (/^(webpack|__REACT|__NEXT|chrome|top|parent)$/i.test(k)) continue;
        try {
          const v = window[k];
          if (v && (typeof v === 'object' || typeof v === 'function')) yield v;
        } catch { /* cross-origin getter, skip */ }
      }
    } catch { /* ignore */ }
  }

  function looksLikeChart(obj) {
    try {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
      const u = unwrapChart(obj) || obj;
      if (typeof u.model === 'function' || u._model) return true;
      if (typeof u.mainSeries === 'function' || u._mainSeries) return true;
      if (typeof u.allStudies === 'function' || typeof u.studies === 'function') return true;
      if (typeof u.symbol === 'function' && typeof u.resolution === 'function') return true;
      if (typeof u.symbolInterval === 'function') return true;
      if (typeof u.activeChart === 'function' || typeof u.activeChartWidget === 'function') return true;
      if (u._chartWidget || u.chartWidget || u._chartWidgets) return true;
      if (typeof u.getSeries === 'function' || typeof u.series === 'function') return true;
      if (typeof u.panes === 'function' && typeof u.timeScale === 'function') return true;
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Given a chart-like object, try to pull symbol / resolution / last bars
   * using only read-only calls. Every call is guarded — minified internals
   * change frequently, so any single failure must not throw.
   */
  function readInternalChart(chartLike) {
    try {
      const chart = unwrapChart(chartLike) || chartLike;
      if (!chart) return null;

      const candidateModels = [
        chart,
        typeof chart.model === 'function' ? chart.model() : chart.model,
        chart._model,
      ];
      const m1 = candidateModels[1];
      const innerM = typeof m1?.model === 'function' ? m1.model() : m1?._model;
      if (innerM) candidateModels.push(innerM);
      const uniqueModels = [...new Set(candidateModels.filter(Boolean))];

      let symbol = null;
      let timeframe = null;
      let ms = null;
      try {
        if (typeof chart.symbol === 'function') symbol = chart.symbol();
        else if (typeof chart.symbolInterval === 'function') {
          const si = chart.symbolInterval();
          symbol = si?.symbol ?? si?.pair ?? null;
          timeframe = si?.interval ?? null;
        }
        if (!timeframe && typeof chart.resolution === 'function') {
          timeframe = chart.resolution();
        }

        for (const m of uniqueModels) {
          if (!ms) {
            try {
              const s = typeof m.mainSeries === 'function' ? m.mainSeries() : m.mainSeries;
              if (s) ms = s;
            } catch { /* next */ }
          }
          if (!symbol) {
            try {
              if (typeof m.symbol === 'function') symbol = m.symbol();
              else if (typeof m.symbolInterval === 'function') {
                const si = m.symbolInterval();
                symbol = si?.symbol ?? si?.pair ?? null;
                if (!timeframe) timeframe = si?.interval ?? null;
              }
            } catch { /* ignore */ }
          }
          if (!timeframe) {
            try {
              if (typeof m.resolution === 'function') timeframe = m.resolution();
              else if (typeof m.interval === 'function') timeframe = m.interval();
            } catch { /* ignore */ }
          }
        }

        if (ms) {
          if (!symbol) {
            symbol = (typeof ms.symbol === 'function' ? ms.symbol() : ms.symbol)
              ?? (typeof ms.symbolInterval === 'function' ? ms.symbolInterval()?.symbol : null)
              ?? ms._symbol ?? (typeof ms.title === 'function' ? ms.title() : null) ?? null;
          }
          if (!timeframe) {
            timeframe = (typeof ms.interval === 'function' ? ms.interval() : ms.interval)
              ?? (typeof ms.resolution === 'function' ? ms.resolution() : ms.resolution)
              ?? ms._interval ?? null;
          }
        }
      } catch { /* keep nulls */ }

      // Bars: try known read paths in order, newest-last so we can slice tail.
      let bars = null;
      const attempts = [
        () => ms?.bars?.(),
        () => ms?.bars?._items,
        () => ms?.bars?.items,
        () => ms?.data?.()?.bars?.(),
        () => ms?.data?.()?.all?.(),
        () => ms?.data?.(),
        () => ms?._data,
        () => ms?.data?._items,
        () => ms?.data?.items,
        () => innerM?.mainSeries?.()?.bars?.(),
        () => innerM?.mainSeries?.()?.data?.()?.bars?.(),
        () => chart?.model?.()?.model?.()?.mainSeries?.()?.bars?.(),
        () => chart?.model?.()?.mainSeries?.()?.bars?.(),
        () => chart?.model?.()?.mainSeries?.()?.data?.()?.bars?.(),
        () => chart?.getSeries?.()?.data?.(),
        () => chart?.series?.()?.bars?.(),
      ];
      for (const fn of attempts) {
        try {
          const raw = fn();
          if (!raw) continue;
          let arr = null;
          if (Array.isArray(raw)) {
            arr = raw;
          } else if (Array.isArray(raw._items)) {
            arr = raw._items;
          } else if (Array.isArray(raw.items)) {
            arr = raw.items;
          } else if (typeof raw.range === 'function') {
            const r = raw.range();
            arr = Array.isArray(r) ? r : r?._items ?? r?.items ?? null;
            if (!arr && typeof r?.[Symbol.iterator] === 'function' && typeof r !== 'string') {
              const a = Array.from(r);
              if (a.length) arr = a;
            }
          } else if (typeof raw.all === 'function') {
            const a = raw.all();
            arr = Array.isArray(a) ? a : a?._items ?? a?.items ?? null;
            if (!arr && typeof a?.[Symbol.iterator] === 'function' && typeof a !== 'string') {
              const itArr = Array.from(a);
              if (itArr.length) arr = itArr;
            }
          } else if (typeof raw[Symbol.iterator] === 'function' && typeof raw !== 'string') {
            const itArr = Array.from(raw);
            if (itArr.length) arr = itArr;
          }
          if (Array.isArray(arr) && arr.length) { bars = arr; break; }
        } catch { /* next attempt */ }
      }

      // ValueAt loop for PlotList objects with firstIndex / lastIndex
      if (!bars && ms) {
        try {
          const bObj = (typeof ms.bars === 'function' ? ms.bars() : ms.bars)
            ?? (typeof ms.data === 'function' ? ms.data()?.bars?.() : null)
            ?? (typeof ms.data === 'function' ? ms.data() : null)
            ?? ms._data;
          if (bObj && typeof bObj.valueAt === 'function' && typeof bObj.firstIndex === 'function' && typeof bObj.lastIndex === 'function') {
            const fi = bObj.firstIndex();
            const li = bObj.lastIndex();
            if (typeof fi === 'number' && typeof li === 'number' && Number.isFinite(fi) && Number.isFinite(li) && li >= fi) {
              const pts = [];
              for (let i = fi; i <= li; i++) {
                try {
                  const val = bObj.valueAt(i);
                  if (val != null) {
                    let t = val.time ?? val.timestamp ?? val.t ?? null;
                    if (t == null && Array.isArray(val) && val.length > 5 && typeof val[0] === 'number' && val[0] >= 1e8) {
                      t = val[0];
                    }
                    if (t == null && bObj) {
                      try { t = bObj.timeAt?.(i) ?? bObj.timeByIndex?.(i) ?? bObj.time?.(i) ?? bObj.times?.[i]; } catch {}
                    }
                    const item = (val && typeof val === 'object' && !Array.isArray(val))
                      ? { ...val, index: val.index ?? i, i, time: t ?? val.time }
                      : { index: i, value: val, time: t, i };
                    pts.push(item);
                  }
                } catch { /* next index */ }
              }
              if (pts.length) bars = pts;
            }
          }
        } catch { /* ignore */ }
      }

      if (!bars && !symbol && !timeframe) return null;

      const normalized = normalizeBars(bars);
      // Reconstruct timestamps if any are missing via timeScale
      const tsObj = (typeof chart.timeScale === 'function' ? chart.timeScale() : chart.timeScale)
        ?? (typeof chart.model === 'function' ? chart.model()?.timeScale?.() : null)
        ?? chart._timeScale;
      try {
        if (tsObj) {
          for (const nb of normalized) {
            if (nb.epochMs == null && nb.index != null) {
              try {
                const userT = tsObj.indexToUserTime?.(nb.index) ?? tsObj.userTime?.(nb.index) ?? tsObj.indexToTime?.(nb.index);
                if (typeof userT === 'number' && userT > 1e8) {
                  const s = timeToStamp(userT);
                  nb.epochMs = s.epochMs;
                  nb.iso = s.iso;
                }
              } catch (_) {}
            }
          }
        }
      } catch (_) {}

      // Timeframe step fill if any timestamps are missing
      try {
        const normTf = toTvResolution(timeframe) || timeframe || '5';
        const mMin = String(normTf).match(/^(\d+)m?$/i);
        const tfMinutes = mMin ? Number(mMin[1]) : (normTf === 'D' || normTf === '1D' ? 1440 : (normTf === 'W' ? 10080 : 5));
        const tfMs = (tfMinutes || 5) * 60 * 1000;

        let anchorBar = normalized.find((b) => b && b.epochMs != null);
        if (!anchorBar && normalized.length) {
          const liveT = Math.floor(Date.now() / tfMs) * tfMs;
          anchorBar = normalized[normalized.length - 1];
          anchorBar.epochMs = liveT;
          anchorBar.iso = new Date(liveT).toISOString();
        }
        if (anchorBar) {
          const aIdx = normalized.indexOf(anchorBar);
          for (let j = 0; j < normalized.length; j++) {
            if (normalized[j].epochMs == null) {
              const bTime = anchorBar.epochMs + (j - aIdx) * tfMs;
              normalized[j].epochMs = bTime;
              normalized[j].iso = new Date(bTime).toISOString();
            }
          }
        }
      } catch (_) {}

      const indexToMs = new Map();
      for (let i = 0; i < normalized.length; i++) {
        const nb = normalized[i];
        if (nb.epochMs != null) {
          indexToMs.set(i, nb.epochMs);
          if (nb.index != null) indexToMs.set(nb.index, nb.epochMs);
          if (nb.time != null) indexToMs.set(nb.time, nb.epochMs);
        }
      }

      if (Array.isArray(bars)) {
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i];
          const normBar = normalized[i] ?? normalized[normalized.length - bars.length + i];
          const msVal = normBar?.epochMs ?? (timeToStamp(b?.time ?? b?.timestamp ?? b?.[0] ?? b?.value?.[0]).epochMs);
          if (msVal != null) {
            indexToMs.set(i, msVal);
            if (b && typeof b === 'object' && b.index != null) {
              indexToMs.set(b.index, msVal);
            } else if (Array.isArray(b) && typeof b[0] === 'number' && b[0] < 1e9) {
              indexToMs.set(b[0], msVal);
            }
            const t = b?.time ?? b?.timestamp ?? (Array.isArray(b) ? b[0] : null);
            if (t != null && typeof t === 'number') {
              indexToMs.set(t, msVal);
            }
          }
        }
      }

      // Also map indices from mainSeries.bars() if firstIndex / lastIndex available
      try {
        const bObj = ms?.bars?.() ?? ms?.data?.()?.bars?.();
        if (bObj && typeof bObj.firstIndex === 'function' && typeof bObj.lastIndex === 'function' && typeof bObj.valueAt === 'function') {
          const fi = bObj.firstIndex();
          const li = bObj.lastIndex();
          for (let i = fi; i <= li; i++) {
            const b = bObj.valueAt(i);
            if (b) {
              const t = b.time ?? b.timestamp ?? (Array.isArray(b) ? b[0] : (Array.isArray(b.value) ? b.value[0] : null));
              const msVal = t != null ? timeToStamp(t).epochMs : null;
              if (msVal != null) {
                indexToMs.set(i, msVal);
                if (b.index != null) indexToMs.set(b.index, msVal);
              }
            }
          }
        }
      } catch { /* ignore */ }

      // Studies are best-effort: [] when this build hides them (caller warns).
      let studies = [];
      try { studies = probeStudies(chart, indexToMs, normalized); } catch { studies = []; }
      return { symbol, timeframe, bars: normalized, studies };
    } catch {
      return null;
    }
  }

  /** Normalize whatever bar shape TV internals give us into {index,time,epochMs,iso,open,high,low,close,volume}. */
  function normalizeBars(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    // Range export needs deep history: keep up to 10k bars (newest-last).
    // Snapshot callers that only need the live candle slice the tail themselves.
    const tail = raw.length > 10000 ? raw.slice(-10000) : raw;
    const out = [];
    for (let i = 0; i < tail.length; i++) {
      try {
        const b = tail[i];
        if (!b || typeof b !== 'object') continue;
        const v = b.value ?? b[4] ?? b;
        let t = b.time ?? b.timestamp ?? b.t ?? b.timeMs;
        let o = null, h = null, l = null, c = null, vol = null;

        // Check array v: [time, open, high, low, close, volume] vs [open, high, low, close, volume]
        if (Array.isArray(v) && v.length >= 4) {
          if (typeof v[0] === 'number' && v[0] >= 1e8) {
            if (t == null) t = v[0];
            o = toNum(v[1]); h = toNum(v[2]); l = toNum(v[3]); c = toNum(v[4]);
            if (v.length > 5) vol = toNum(v[5]);
          } else {
            o = toNum(v[0]); h = toNum(v[1]); l = toNum(v[2]); c = toNum(v[3]);
            if (v.length > 4) vol = toNum(v[4]);
          }
        }

        // Check array b: [index, time, open, high, low, close, volume]
        if (Array.isArray(b)) {
          if (t == null) {
            if (typeof b[0] === 'number' && b[0] >= 1e8) t = b[0];
            else if (typeof b[1] === 'number' && b[1] >= 1e8) t = b[1];
          }
          if (o == null && b.length >= 6 && typeof b[0] === 'number' && b[0] < 1e8 && typeof b[1] === 'number' && b[1] >= 1e8) {
            o = toNum(b[2]); h = toNum(b[3]); l = toNum(b[4]); c = toNum(b[5]);
            if (b.length > 6) vol = toNum(b[6]);
          }
        }

        if (o == null) o = toNum(b.open ?? b.o ?? v?.open);
        if (h == null) h = toNum(b.high ?? b.h ?? v?.high);
        if (l == null) l = toNum(b.low ?? b.l ?? v?.low);
        if (c == null) c = toNum(b.close ?? b.c ?? v?.close ?? b.value);
        if (vol == null) vol = toNum(b.volume ?? b.vol ?? v?.volume ?? v?.vol);

        if (o == null && h == null && l == null && c == null) continue;
        const { epochMs, iso } = timeToStamp(t ?? null);
        const barIndex = b.index ?? (typeof b.i === 'number' ? b.i : (Array.isArray(b) && b.length >= 6 && typeof b[0] === 'number' && b[0] < 1e8 && typeof b[1] === 'number' && b[1] >= 1e8 ? b[0] : i));
        out.push({ index: barIndex, time: t ?? null, epochMs, iso, open: o, high: h, low: l, close: c, volume: vol });
      } catch { /* skip malformed bar */ }
    }
    return out;
  }

  function probeInternalModel() {
    let fallback = null;
    for (const root of walkRoots()) {
      try {
        if (looksLikeChart(root)) {
          const snap = readInternalChart(root);
          if (snap) {
            if (snap.bars?.length) return snap;
            if (!fallback && snap.symbol) fallback = snap;
          }
        }
        // One level deep: collection objects holding chart widgets.
        if (root && typeof root === 'object') {
          const vals = Object.values(root).slice(0, 40);
          for (const v of vals) {
            try {
              if (looksLikeChart(v)) {
                const snap = readInternalChart(v);
                if (snap) {
                  if (snap.bars?.length) return snap;
                  if (!fallback && snap.symbol) fallback = snap;
                }
              }
            } catch { /* continue */ }
          }
        }
      } catch { /* continue */ }
    }
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // Studies (indicators) — per-bar history for range export
  //   Study internals vary wildly between TV builds, so everything here is
  //   duck-typed and defensive. Returns:
  //     [{ name, points: [{ epochMs, value }] }]
  //   where value is number | number[] (multi-plot) | null.
  //   [] means "not reachable in this build" — never an error.
  // ---------------------------------------------------------------------------

  /** Extract a numeric payload from one study point (skipping time keys). */
  function studyPointValue(raw) {
    try {
      const nVal = toNum(raw);
      if (nVal != null) return nVal;
      if (Array.isArray(raw)) {
        let items = raw;
        if (items.length > 1 && typeof items[0] === 'number' && items[0] >= 1e8) {
          items = items.slice(1);
        }
        const mapped = items.map((n) => toNum(n));
        return mapped.some((n) => n != null) ? mapped : null;
      }
      if (raw && typeof raw === 'object') {
        const directNum = toNum(raw.value);
        if (directNum != null) return directNum;
        if (Array.isArray(raw.value)) {
          let items = raw.value;
          if (items.length > 1 && typeof items[0] === 'number' && items[0] >= 1e8) {
            items = items.slice(1);
          }
          const mapped = items.map((n) => toNum(n));
          return mapped.some((n) => n != null) ? mapped : null;
        }
        const entries = Object.entries(raw).filter(([k]) => !/time|timestamp|date|index|^i$/i.test(k));
        if (entries.length === 1 && toNum(entries[0][1]) != null) {
          return toNum(entries[0][1]);
        }
        if (entries.length > 1) {
          const obj = {};
          let hasVal = false;
          for (const [k, v] of entries) {
            const num = toNum(v);
            if (num != null) hasVal = true;
            obj[k] = num;
          }
          return hasVal ? obj : null;
        }
      }
    } catch { /* fall through */ }
    return null;
  }

  /** Extract user-configured or default inputs for a study object. */
  function extractStudyInputs(s) {
    try {
      const props = typeof s.properties === 'function' ? s.properties() : s.properties;
      const inputs = props?.inputs ?? props?.childs?.()?.inputs ?? null;
      if (inputs && typeof inputs === 'object') {
        const vals = [];
        for (const [k, v] of Object.entries(inputs)) {
          if (k.startsWith('_') || k === 'id') continue;
          let val = v;
          if (typeof v === 'function') { try { val = v(); } catch { continue; } }
          else if (v && typeof v === 'object' && typeof v.value === 'function') { try { val = v.value(); } catch { continue; } }
          else if (v && typeof v === 'object' && 'value' in v) val = v.value;
          if (val !== undefined && val !== null && typeof val !== 'object' && typeof val !== 'function') {
            vals.push(String(val));
          }
        }
        if (vals.length) return vals.join(', ');
      }
      const metaInputs = s.metaInfo?.()?.inputs ?? s.metaInfo?.inputs;
      if (Array.isArray(metaInputs)) {
        const vals = metaInputs
          .filter((inp) => !inp.isHidden && inp.defval !== undefined && inp.id !== 'id')
          .map((inp) => String(inp.defval));
        if (vals.length) return vals.join(', ');
      }
    } catch { /* ignore */ }
    return null;
  }

  /** Extract plot names for multi-plot indicators (e.g. MACD, BB, Supertrend, MktBreadth). */
  function extractStudyPlots(s) {
    try {
      const meta = typeof s.metaInfo === 'function' ? s.metaInfo() : s.metaInfo;
      if (meta && Array.isArray(meta.plots)) {
        const plots = [];
        const styles = meta.styles || {};
        for (let i = 0; i < meta.plots.length; i++) {
          const p = meta.plots[i];
          if (!p) { plots.push(`Plot ${i}`); continue; }
          const plotTitle = styles[p.id]?.title ?? p.target ?? p.name ?? p.id ?? `Plot ${i}`;
          plots.push(String(plotTitle));
        }
        if (plots.length) return plots;
      }
    } catch { /* ignore */ }
    return [];
  }

  /** Best-effort display name for a study object, including parameters. */
  function studyName(s, fallback) {
    try {
      let title = null;
      if (typeof s.title === 'function') {
        try { title = s.title(true); } catch { /* ignore */ }
        if (!title) { try { title = s.title(); } catch { /* ignore */ } }
      }
      if (!title && typeof s.name === 'function') {
        try { title = s.name(true); } catch { /* ignore */ }
        if (!title) { try { title = s.name(); } catch { /* ignore */ } }
      }
      if (!title && typeof s.title === 'string' && s.title) title = s.title;
      if (!title && typeof s.name === 'string' && s.name) title = s.name;
      if (!title) {
        const desc = s.metaInfo?.()?.description ?? s.metaInfo?.description;
        if (desc) title = String(desc);
      }
      if (!title) title = fallback;

      // If title doesn't already have parenthesized parameters, append extracted inputs
      if (title && !title.includes('(')) {
        const inputs = extractStudyInputs(s);
        if (inputs) title = `${title} (${inputs})`;
      }
      return String(title).slice(0, 100);
    } catch { /* fall through */ }
    return fallback;
  }

  function probeStudies(chart, indexToMs, normalizedBars) {
    const out = [];
    try {
      // Candidate study lists across builds (first non-empty wins per source,
      // merged at the end, capped to avoid runaway on exotic builds).
      const pools = [];
      const collect = (arr) => {
        if (Array.isArray(arr) && arr.length) pools.push(arr.slice(0, 50));
      };

      const candidateModels = [
        chart,
        typeof chart.model === 'function' ? chart.model() : chart.model,
        chart._model,
      ];
      const m1 = candidateModels[1];
      const innerM = typeof m1?.model === 'function' ? m1.model() : m1?._model;
      if (innerM) candidateModels.push(innerM);
      const uniqueModels = [...new Set(candidateModels.filter(Boolean))];

      for (const mdl of uniqueModels) {
        try { collect(mdl.getStudies?.()); } catch { /* ignore */ }
        try { collect(mdl.studies?.()); } catch { /* ignore */ }
        try { collect(mdl.allStudies?.()); } catch { /* ignore */ }
        try { collect(mdl._studies); } catch { /* ignore */ }
        try {
          const ds = mdl.dataSources?.() ?? mdl._dataSources;
          if (Array.isArray(ds)) {
            collect(ds.filter((d) => {
              try {
                if (!d || (typeof d !== 'object' && typeof d !== 'function')) return false;
                const isSeries = typeof d.isSeries === 'function' ? d.isSeries() : !!d.isSeries;
                if (isSeries) return false;
                const isMainSeries = typeof d.isMainSeries === 'function' ? d.isMainSeries() : !!d.isMainSeries;
                if (isMainSeries) return false;
                return typeof d.isStudy === 'function' ? d.isStudy() : (d.isStudy || typeof d.studyId !== 'undefined' || d.metaInfo || d._metaInfo || d.properties || typeof d.data === 'function' || d.data);
              } catch { return false; }
            }));
          }
        } catch { /* ignore */ }
        try {
          const panes = mdl.panes?.() ?? (Array.isArray(mdl.panes) ? mdl.panes : []);
          for (const p of (panes || [])) {
            try {
              const pDs = p?.dataSources?.() ?? p?.sources?.() ?? p?.orderedSources?.() ?? p?._dataSources ?? p?._sources;
              if (Array.isArray(pDs)) {
                collect(pDs.filter((d) => {
                  try {
                    if (!d || (typeof d !== 'object' && typeof d !== 'function')) return false;
                    const isSeries = typeof d.isSeries === 'function' ? d.isSeries() : !!d.isSeries;
                    return !isSeries;
                  } catch { return false; }
                }));
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }

      const seen = new Set();
      for (const pool of pools) {
        for (const s of pool) {
          try {
            if (!s || (typeof s !== 'object' && typeof s !== 'function')) continue;
            if (seen.has(s)) continue;
            seen.add(s);
            // Candidate point lists for this study.
            let raw = null;
            const tries = [
              () => (typeof s.data === 'function' ? s.data()?.all?.() : null),
              () => (typeof s.data === 'function' ? s.data()?.bars?.() : null),
              () => (typeof s.data === 'function' ? s.data()?.plotRows?.() : null),
              () => (typeof s.data === 'function' ? s.data()?.range?.() : null),
              () => (typeof s.data === 'function' ? s.data()?._items : null),
              () => (typeof s.data === 'function' ? s.data()?.items : null),
              () => (typeof s.data === 'function' ? s.data() : null),
              () => (typeof s.plotRows === 'function' ? s.plotRows() : null),
              () => (typeof s.bars === 'function' ? s.bars() : null),
              () => (typeof s.points === 'function' ? s.points() : null),
              () => (typeof s.values === 'function' ? s.values() : null),
              () => s._data?._items,
              () => s._data?.items,
              () => s._data,
              () => s.data?._items,
              () => s.data?.items,
              () => s.data,
              () => s._plotRows,
            ];
            for (const fn of tries) {
              try {
                const r = fn();
                if (!r) continue;
                if (Array.isArray(r) && r.length) { raw = r; break; }
                const items = r?._items ?? r?.items;
                if (Array.isArray(items) && items.length) { raw = items; break; }
                if (typeof r?.all === 'function') {
                  const a = r.all();
                  if (Array.isArray(a) && a.length) { raw = a; break; }
                }
                if (typeof r?.[Symbol.iterator] === 'function' && typeof r !== 'string') {
                  const arr = Array.from(r);
                  if (arr.length) { raw = arr; break; }
                }
              } catch { /* next */ }
            }

            // ValueAt loop for PlotList objects with firstIndex / lastIndex
            if (!raw) {
              try {
                const dObj = (typeof s.data === 'function' ? s.data() : s.data) ?? s._data;
                if (dObj && typeof dObj.valueAt === 'function' && typeof dObj.firstIndex === 'function' && typeof dObj.lastIndex === 'function') {
                  const fi = dObj.firstIndex();
                  const li = dObj.lastIndex();
                  if (typeof fi === 'number' && typeof li === 'number' && Number.isFinite(fi) && Number.isFinite(li) && li >= fi) {
                    const pts = [];
                    for (let i = fi; i <= li; i++) {
                      try {
                        const val = dObj.valueAt(i);
                        if (val != null) {
                          pts.push(val.index !== undefined ? val : { index: i, value: val });
                        }
                      } catch { /* next index */ }
                    }
                    if (pts.length) raw = pts;
                  }
                }
              } catch { /* ignore */ }
            }

            if (!raw) continue;
            const name = studyName(s, `Study ${out.length + 1}`);
            const plots = extractStudyPlots(s);
            const pts = [];
            const slice = raw.length > 10000 ? raw.slice(-10000) : raw;
            for (let ptIdx = 0; ptIdx < slice.length; ptIdx++) {
              try {
                const p = slice[ptIdx];
                if (p == null) continue;
                let epochMs = null;
                const t = p.time ?? p.timestamp ?? p.t ?? (Array.isArray(p) && p.length > 1 && typeof p[1] === 'number' && p[1] >= 1e9 ? p[1] : null);
                if (t != null) {
                  const stamp = timeToStamp(t);
                  if (stamp.epochMs != null && stamp.epochMs > 1e11) epochMs = stamp.epochMs;
                }
                const idx = p.index ?? (typeof p.i === 'number' ? p.i : null) ?? (Array.isArray(p) && typeof p[0] === 'number' && p[0] < 1e9 ? p[0] : null);
                if (epochMs == null && idx != null && indexToMs) {
                  epochMs = indexToMs.get(idx);
                }
                if (epochMs == null && Array.isArray(p) && typeof p[0] === 'number' && p[0] >= 1e9) {
                  epochMs = timeToStamp(p[0]).epochMs;
                }
                if (epochMs == null && normalizedBars && slice.length === normalizedBars.length && normalizedBars[ptIdx]) {
                  epochMs = normalizedBars[ptIdx].epochMs;
                }
                // Tail-alignment match: handles warmups and offset series
                if (epochMs == null && normalizedBars && normalizedBars.length) {
                  const offset = normalizedBars.length - slice.length;
                  if (offset >= 0 && normalizedBars[offset + ptIdx]) {
                  } else if (offset < 0) {
                    const barIdx = ptIdx + offset;
                    if (barIdx >= 0 && normalizedBars[barIdx]) {
                      epochMs = normalizedBars[barIdx].epochMs;
                    }
                  }
                }
                if (epochMs == null && idx != null && normalizedBars) {
                  const matchingBar = normalizedBars.find((b) => b && b.index === idx);
                  if (matchingBar && matchingBar.epochMs != null) {
                    epochMs = matchingBar.epochMs;
                  }
                }
                if (epochMs == null && idx == null && ptIdx == null) continue;

                let valRaw = p.value ?? p.v ?? p.values;
                if (valRaw === undefined && Array.isArray(p)) {
                  if (p.length === 1) {
                    valRaw = p[0];
                  } else if (typeof p[0] === 'number' && p[0] < 1e9) {
                    // p[0] is bar index
                    if (typeof p[1] === 'number' && p[1] >= 1e9) {
                      // p[1] is timestamp
                      valRaw = p.length === 3 ? p[2] : p.slice(2);
                    } else {
                      valRaw = p.length === 2 ? p[1] : p.slice(1);
                    }
                  } else if (typeof p[0] === 'number' && p[0] >= 1e9) {
                    // p[0] is timestamp
                    valRaw = p.length === 2 ? p[1] : p.slice(1);
                  } else {
                    valRaw = p;
                  }
                } else if (valRaw === undefined) {
                  valRaw = p;
                }
                const v = studyPointValue(valRaw);
                pts.push({ index: idx ?? ptIdx, epochMs, value: v });
              } catch { /* skip bad point */ }
            }
            if (pts.length) out.push({ name: String(name).slice(0, 100), plots, points: pts });
            if (out.length >= 25) return out;
          } catch { /* one bad study must not kill the rest */ }
        }
      }
    } catch { /* return whatever we gathered */ }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Programmatic scroll (auto-pan to load older history)
  //   Tries the internal timeScale API first (no visible jump), then falls back
  //   to synthetic wheel events on the chart canvas. Returns { ok, methods }.
  // ---------------------------------------------------------------------------

  /** Nudge one chart-like object's timeScale. Returns method names used. */
  function tryScrollChart(chart, direction, steps) {
    const used = [];
    try {
      const ts = (typeof chart.timeScale === 'function' ? chart.timeScale() : chart.timeScale)
        ?? (typeof chart.model === 'function' ? chart.model()?.timeScale?.() : null)
        ?? chart._timeScale
        ?? null;
      if (ts) {
        if (typeof ts.scrollToPosition === 'function') {
          // Position nudge in time-scale coords; positive reveals older bars
          // in the common TV orientation — content.js verifies via earliestMs
          // and keeps panning only while progress is made.
          ts.scrollToPosition((direction === 'older' ? 1 : -1) * 200 * steps, false);
          used.push('scrollToPosition');
        } else if (typeof ts.setRightOffset === 'function' && typeof ts.rightOffset === 'function') {
          ts.setRightOffset(ts.rightOffset() + (direction === 'older' ? 5 * steps : -5 * steps));
          used.push('setRightOffset');
        } else if (direction === 'newer' && typeof ts.scrollToRealTime === 'function') {
          ts.scrollToRealTime();
          used.push('scrollToRealTime');
        }
      }
    } catch { /* fall through to wheel */ }
    if (!used.length) {
      try {
        const cv = document.querySelector('.chart-container canvas')
          || document.querySelector('[data-name="chart-container"] canvas')
          || document.querySelector('canvas');
        if (cv) {
          const dx = direction === 'older' ? 320 : -320;
          for (let i = 0; i < steps; i++) {
            cv.dispatchEvent(new WheelEvent('wheel', {
              deltaX: dx, deltaY: 0, bubbles: true, cancelable: true,
            }));
          }
          used.push('wheel-event');
        }
      } catch { /* ignore */ }
    }
    return used;
  }

  function scrollChart(direction = 'older', steps = 3) {
    try {
      for (const root of walkRoots()) {
        try {
          const charts = [];
          if (looksLikeChart(root)) charts.push(root);
          else if (root && typeof root === 'object') {
            for (const v of Object.values(root).slice(0, 40)) {
              try { if (looksLikeChart(v)) charts.push(v); } catch { /* skip */ }
            }
          }
          for (const like of charts) {
            const chart = typeof like.activeChart === 'function'
              ? like.activeChart()
              : like._chartWidget || like.chartWidget || like;
            if (!chart) continue;
            const used = tryScrollChart(chart, direction, Math.min(Math.max(steps, 1), 5));
            if (used.length) return { ok: true, methods: used };
          }
        } catch { /* next root */ }
      }
    } catch { /* fall through */ }
    return { ok: false, error: 'SCROLL_API_NOT_FOUND' };
  }

  // ---------------------------------------------------------------------------
  // Range read: bars (+ study points) filtered to [startMs, endMs], with
  // coverage bounds so the caller knows whether to auto-pan for more history.
  // ---------------------------------------------------------------------------
  function getRange(startMs, endMs) {
    try {
      const internal = probeInternalModel();
      if (!internal) {
        return {
          ok: false, error: 'CHART_MODEL_NOT_REACHABLE',
          hint: 'Chart widget internals not reachable (still loading or renamed build).',
          at: new Date().toISOString(),
        };
      }
      const all = Array.isArray(internal.bars) ? internal.bars : [];
      const inRange = (p) => p && p.epochMs != null && p.epochMs >= startMs && p.epochMs <= endMs;
      const bars = all.filter(inRange);
      const studies = (internal.studies ?? []).map((s) => ({
        name: s.name,
        plots: s.plots,
        points: (s.points ?? []).filter(inRange),
      }));
      const allStudies = (internal.studies ?? []).map((s) => ({
        name: s.name,
        plots: s.plots,
        points: s.points ?? [],
      }));
      const timed = all.filter((b) => b && b.epochMs != null);
      return {
        ok: true,
        source: 'page-internal-model',
        symbol: internal.symbol ?? null,
        timeframe: internal.timeframe ?? null,
        bars,
        allBars: all,
        studies,
        allStudies,
        totalLoaded: all.length,
        earliestMs: timed.length ? timed[0].epochMs : null,
        latestMs: timed.length ? timed[timed.length - 1].epochMs : null,
        at: new Date().toISOString(),
      };
    } catch (err) {
      return { ok: false, error: 'RANGE_READ_FAILED', message: String(err?.message ?? err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Public snapshot API
  // ---------------------------------------------------------------------------
  function getSnapshot() {
    // 1) Try official widget path.
    try {
      const found = probeOfficialWidget();
      if (found) {
        lastSnapshot = {
          source: 'page-widget',
          symbol: null, // resolved by content.js legend fallback
          timeframe: null,
          bars: [],
          note: 'official widget handle found; bar history via content-script legend path',
          at: new Date().toISOString(),
        };
        return lastSnapshot;
      }
    } catch { /* fall through */ }

    // 2) Try internal model path.
    try {
      const internal = probeInternalModel();
      if (internal && (internal.bars?.length || internal.symbol)) {
        lastSnapshot = {
          source: 'page-internal-model',
          symbol: internal.symbol ?? lastSnapshot?.symbol ?? null,
          timeframe: internal.timeframe ?? lastSnapshot?.timeframe ?? null,
          bars: internal.bars ?? [],
          studies: internal.studies ?? lastSnapshot?.studies ?? [],
          at: new Date().toISOString(),
        };
        return lastSnapshot;
      }
    } catch { /* fall through */ }

    // 3) Graceful "not yet" — content.js will merge the legend-DOM fallback.
    return {
      source: 'page-unavailable',
      symbol: null,
      timeframe: null,
      bars: [],
      error: 'CHART_MODEL_NOT_REACHABLE',
      hint: 'Chart widget internals not reachable from page context (chart may still be loading, or this build renames internals). Legend-DOM fallback in content.js remains authoritative.',
      stale: lastSnapshot,
      at: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Method C: Network interception (Datafeed capture)
  //   Capture incoming chart data JSON payloads by hooking XHR and fetch.
  // ---------------------------------------------------------------------------
  const capturedDatafeed = [];

  function extractBarsFromSeriesObj(seriesObj) {
    if (!seriesObj || typeof seriesObj !== 'object') return [];
    const bars = [];
    if (Array.isArray(seriesObj.s)) {
      for (const item of seriesObj.s) {
        if (item && Array.isArray(item.v) && item.v.length >= 5) bars.push(item.v);
        else if (Array.isArray(item) && item.length >= 5) bars.push(item);
      }
    }
    for (const key of Object.keys(seriesObj)) {
      const sub = seriesObj[key];
      if (sub && typeof sub === 'object') {
        if (Array.isArray(sub.s)) {
          for (const item of sub.s) {
            if (item && Array.isArray(item.v) && item.v.length >= 5) bars.push(item.v);
            else if (Array.isArray(item) && item.length >= 5) bars.push(item);
          }
        } else if (Array.isArray(sub.bars)) {
          for (const item of sub.bars) {
            if (item && Array.isArray(item.v) && item.v.length >= 5) bars.push(item.v);
            else if (Array.isArray(item) && item.length >= 5) bars.push(item);
          }
        }
      }
    }
    return bars;
  }

  function tryParseOHLC(response) {
    if (!response || typeof response !== 'string') return;
    try {
      if (!response.includes('"s":"ok"') && !response.includes('[') && !response.includes('time') && !response.includes('~m~')) return;

      let found = false;

      // Handle WebSocket payloads (~m~length~m~JSON)
      const packets = response.split(/~m~\d+~m~/).filter(p => p.trim());
      for (const p of packets) {
        try {
          const payload = JSON.parse(p);
          
          // Handle raw arrays of bars [[time, open, high, low, close, volume], ...]
          if (Array.isArray(payload) && payload.length > 0) {
            for (const item of payload) {
               if (Array.isArray(item) && item.length >= 5) {
                 const [t, o, h, l, c] = item;
                 if (typeof t === 'number' && typeof c === 'number') {
                    const { epochMs, iso } = timeToStamp(t);
                    capturedDatafeed.push({ time: t, epochMs, iso, open: toNum(o), high: toNum(h), low: toNum(l), close: toNum(c) });
                    found = true;
                 }
               } else if (item && typeof item === 'object') {
                 const v = item.value ?? item[4] ?? item;
                 const t = item.time ?? item.timestamp ?? item.t ?? item[0];
                 const o = toNum(item.open ?? item.o ?? v?.[1] ?? v?.open);
                 const h = toNum(item.high ?? item.h ?? v?.[2] ?? v?.high);
                 const l = toNum(item.low ?? item.l ?? v?.[3] ?? v?.low);
                 const c = toNum(item.close ?? item.c ?? v?.[4] ?? v?.close ?? item.value);
                 if (t != null && c != null) {
                   const { epochMs, iso } = timeToStamp(t);
                   capturedDatafeed.push({ time: t, epochMs, iso, open: o, high: h, low: l, close: c });
                   found = true;
                 }
               }
            }
          } 
          // Handle TradingView UDF format: {"s":"ok","t":[...],"c":[...],"o":[...],"h":[...],"l":[...]}
          else if (payload && payload.s === 'ok' && Array.isArray(payload.t) && Array.isArray(payload.c)) {
            for (let i = 0; i < payload.t.length; i++) {
              const t = payload.t[i];
              const o = payload.o ? payload.o[i] : null;
              const h = payload.h ? payload.h[i] : null;
              const l = payload.l ? payload.l[i] : null;
              const c = payload.c[i];
              const { epochMs, iso } = timeToStamp(t);
              capturedDatafeed.push({ time: t, epochMs, iso, open: toNum(o), high: toNum(h), low: toNum(l), close: toNum(c) });
              found = true;
            }
          }
          // Handle TradingView WebSocket timescale/series updates
          else if (payload && payload.m) {
             if (Array.isArray(payload.p)) {
               for (const pItem of payload.p) {
                 if (pItem && typeof pItem === 'object') {
                   const barsList = extractBarsFromSeriesObj(pItem);
                   for (const bar of barsList) {
                     const [t, o, h, l, c] = bar;
                     if (typeof t === 'number' && typeof c === 'number') {
                       const { epochMs, iso } = timeToStamp(t);
                       capturedDatafeed.push({ time: t, epochMs, iso, open: toNum(o), high: toNum(h), low: toNum(l), close: toNum(c) });
                       found = true;
                     }
                   }
                 }
               }
             }
          }
        } catch { /* skip non-JSON packet */ }
      }

      // Deduplicate and sort if we added things
      if (found) {
        capturedDatafeed.sort((a, b) => a.epochMs - b.epochMs);
        for (let i = 1; i < capturedDatafeed.length; i++) {
          if (capturedDatafeed[i].epochMs === capturedDatafeed[i-1].epochMs) {
            capturedDatafeed.splice(i, 1);
            i--;
          }
        }
        if (capturedDatafeed.length > 20000) {
          capturedDatafeed.splice(0, capturedDatafeed.length - 20000);
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // Hook fetch
  try {
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const clone = res.clone();
        clone.text().then(tryParseOHLC).catch(() => {});
      } catch { /* ignore clone errors */ }
      return res;
    };
  } catch { /* ignore */ }

  // Hook XHR
  try {
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', function() {
        try {
          if (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') {
            const text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
            if (text) tryParseOHLC(text);
          }
        } catch { /* ignore */ }
      });
      origSend.apply(this, args);
    };
  } catch { /* ignore */ }

  // Hook WebSocket
  try {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = function(...args) {
      const ws = new OrigWebSocket(...args);
      ws.addEventListener('message', function(event) {
        try {
          if (typeof event.data === 'string') {
            tryParseOHLC(event.data);
          }
        } catch { /* ignore */ }
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;
    window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    window.WebSocket.OPEN = OrigWebSocket.OPEN;
    window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
    window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  } catch { /* ignore */ }

  // ---------------------------------------------------------------------------
  // Programmatic resolution / timeframe switching
  // ---------------------------------------------------------------------------
  function toTvResolution(tf) {
    if (!tf) return null;
    const s = String(tf).trim();
    if (s.toLowerCase() === 'auto') return null;
    const mSec = s.match(/^(\d+)\s*s$/i);
    if (mSec) return `${mSec[1]}S`;
    const mMin = s.match(/^(\d+)\s*m$/i);
    if (mMin) return mMin[1];
    const mHour = s.match(/^(\d+)\s*h$/i);
    if (mHour) return String(Number(mHour[1]) * 60);
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return mDay[1] === '1' ? 'D' : `${mDay[1]}D`;
    const mWeek = s.match(/^(\d+)\s*w$/i);
    if (mWeek) return mWeek[1] === '1' ? 'W' : `${mWeek[1]}W`;
    if (/^1?M$/i.test(s)) return 'M';
    if (/^\d+$/.test(s)) return s;
    return s;
  }

  function setChartResolution(targetTf) {
    const res = toTvResolution(targetTf);
    if (!res) return { ok: false, error: 'INVALID_RESOLUTION' };
    let applied = false;
    try {
      for (const root of walkRoots()) {
        try {
          const charts = [];
          if (looksLikeChart(root)) charts.push(root);
          else if (root && typeof root === 'object') {
            for (const v of Object.values(root).slice(0, 40)) {
              try { if (looksLikeChart(v)) charts.push(v); } catch { /* ignore */ }
            }
          }
          for (const like of charts) {
            const chart = typeof like.activeChart === 'function'
              ? like.activeChart()
              : like._chartWidget || like.chartWidget || like;
            if (!chart) continue;
            if (typeof chart.setResolution === 'function') {
              chart.setResolution(res);
              applied = true;
            } else if (typeof chart.model === 'function' && typeof chart.model()?.setResolution === 'function') {
              chart.model().setResolution(res);
              applied = true;
            } else if (typeof chart.model === 'function' && typeof chart.model()?.mainSeries?.()?.setResolution === 'function') {
              chart.model().mainSeries().setResolution(res);
              applied = true;
            }
          }
        } catch { /* next root */ }
      }
    } catch { /* ignore */ }
    if (applied) {
      // Clear datafeed buffer so bars from prior resolution don't pollute the new timeframe
      capturedDatafeed.length = 0;
      return { ok: true, resolution: res };
    }
    return { ok: false, resolution: res };
  }

  // ---------------------------------------------------------------------------
  // Isolated-world communication bridge (Synchronous via shared DOM element)
  // ---------------------------------------------------------------------------
  document.addEventListener('__TV_EXT_CALL__', () => {
    try {
      const bridge = document.getElementById('__tv_ext_bridge__');
      if (!bridge) return;
      const reqRaw = bridge.getAttribute('data-req');
      if (!reqRaw) return;
      const { method, args } = JSON.parse(reqRaw);
      let result = null;
      if (method === 'getSnapshot') result = getSnapshot();
      else if (method === 'getRange') result = getRange(...(args || []));
      else if (method === 'scrollChart') result = scrollChart(...(args || []));
      else if (method === 'setResolution') result = setChartResolution(...(args || []));
      else if (method === 'getCapturedDatafeed') result = capturedDatafeed;
      bridge.setAttribute('data-res', JSON.stringify(result));
    } catch { /* ignore */ }
  });

  // Expose minimal read-only (+ scroll and resolution helper) API. `__ready` + `version`
  // let content.js detect us and upgrade across re-injections.
  Object.defineProperty(window, '__TV_EXTRACTOR__', {
    value: { getSnapshot, getRange, scrollChart, setResolution: setChartResolution, capturedDatafeed, __ready: true, version: '2.0.0' },
    writable: false,
    configurable: true, // allow re-injection after SPA navigation
  });
})();
