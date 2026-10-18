/**
 * chrome-shim.js — Polyfill bridge for running the popup UI in a browser preview environment.
 * In a real Chrome extension, `chrome.runtime.id` is present and this file does nothing.
 */
(function() {
  'use strict';

  if (typeof window.chrome !== 'undefined' && window.chrome.runtime && window.chrome.runtime.id && !window.__FORCE_TV_SHIM__) {
    // Real Chrome extension environment — do nothing.
    return;
  }

  const runtimeListeners = [];
  const memoryStorage = {
    tvLastSnapshot: null,
  };

  // Mock active TradingView tab
  const mockTab = {
    id: 1,
    url: 'https://www.tradingview.com/chart/BZy5qAiq/',
    title: 'SENSEX 72,472.33 — TradingView',
    active: true,
  };

  window.chrome = {
    runtime: {
      id: 'tradingview-ohlc-extractor-preview',
      getURL: (path) => '/' + (path ? path.replace(/^\//, '') : ''),
      sendMessage: (message, callback) => {
        // Broadcast to runtime listeners (e.g. background/popup listeners)
        setTimeout(() => {
          for (const fn of runtimeListeners) {
            try {
              fn(message, { tab: mockTab, frameId: 0 }, callback || (() => {}));
            } catch (e) {
              console.warn('[chrome.runtime.sendMessage error]', e);
            }
          }
        }, 0);
        return Promise.resolve();
      },
      onMessage: {
        addListener: (fn) => {
          if (typeof fn === 'function') {
            runtimeListeners.push(fn);
            // If this is content script registering, expose dispatch hook
            window.__TV_CONTENT_DISPATCH__ = (msg, cb) => {
              try {
                return fn(msg, { tab: mockTab, frameId: 0 }, cb);
              } catch (e) {
                console.warn('[TV_CONTENT_DISPATCH error]', e);
                if (typeof cb === 'function') cb({ ok: false, error: 'DISPATCH_ERROR', message: String(e) });
              }
            };
          }
        },
        removeListener: (fn) => {
          const idx = runtimeListeners.indexOf(fn);
          if (idx !== -1) runtimeListeners.splice(idx, 1);
        },
      },
    },
    tabs: {
      query: async (queryInfo) => {
        return [mockTab];
      },
      sendMessage: async (tabId, message, options) => {
        return new Promise((resolve) => {
          let resolved = false;
          const handler = (response) => {
            if (!resolved) {
              resolved = true;
              resolve(response);
            }
          };

          // Try window's content script dispatcher
          if (typeof window.__TV_CONTENT_DISPATCH__ === 'function') {
            const willRespond = window.__TV_CONTENT_DISPATCH__(message, handler);
            if (!willRespond && !resolved) {
              // Synchronous or no return
              setTimeout(() => { if (!resolved) resolve(null); }, 50);
            }
            return;
          }

          // Try parent or iframe dispatcher
          if (window.parent && window.parent !== window && typeof window.parent.__TV_CONTENT_DISPATCH__ === 'function') {
            window.parent.__TV_CONTENT_DISPATCH__(message, handler);
            return;
          }

          // Search frames
          for (let i = 0; i < window.frames.length; i++) {
            try {
              if (typeof window.frames[i].__TV_CONTENT_DISPATCH__ === 'function') {
                window.frames[i].__TV_CONTENT_DISPATCH__(message, handler);
                return;
              }
            } catch (_) {}
          }

          setTimeout(() => {
            if (!resolved) {
              resolve({
                ok: false,
                error: 'NO_CHART_IN_FRAME',
                message: 'Chart is initializing or no chart in current view.'
              });
            }
          }, 350);
        });
      },
    },
    scripting: {
      executeScript: async (options) => {
        if (typeof options?.func === 'function') {
          try {
            const res = options.func();
            return [{ frameId: 0, result: res }];
          } catch (e) {
            return [{ frameId: 0, result: { score: 50, legendHits: 4, canvases: 1, bigCanvas: 1, ohlcText: 1 } }];
          }
        }
        return [{ frameId: 0, result: null }];
      },
    },
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') {
            try {
              const val = localStorage.getItem('tv_' + keys);
              return { [keys]: val ? JSON.parse(val) : memoryStorage[keys] };
            } catch (_) {
              return { [keys]: memoryStorage[keys] };
            }
          }
          if (Array.isArray(keys)) {
            const res = {};
            for (const k of keys) {
              try {
                const val = localStorage.getItem('tv_' + k);
                res[k] = val ? JSON.parse(val) : memoryStorage[k];
              } catch (_) {
                res[k] = memoryStorage[k];
              }
            }
            return res;
          }
          return { ...memoryStorage };
        },
        set: async (items) => {
          if (items && typeof items === 'object') {
            for (const [k, v] of Object.entries(items)) {
              memoryStorage[k] = v;
              try {
                localStorage.setItem('tv_' + k, JSON.stringify(v));
              } catch (_) {}
            }
          }
          return Promise.resolve();
        },
      },
    },
    notifications: {
      create: (id, options, cb) => {
        console.log('[Shim Notification]', id, options?.title, options?.message);
        if (typeof cb === 'function') cb(id || 'shim_notif_' + Date.now());
        return Promise.resolve(id || 'shim_notif_' + Date.now());
      },
      clear: (id, cb) => {
        if (typeof cb === 'function') cb(true);
        return Promise.resolve(true);
      },
    },
    action: {
      setBadgeText: async (details) => {},
      setBadgeBackgroundColor: async (details) => {},
    },
    offscreen: {
      createDocument: async (details) => {},
      hasDocument: async () => false,
      closeDocument: async () => {},
      Reason: { AUDIO: 'AUDIO' },
    },
  };

  window.chrome.tabs.onUpdated = {
    addListener: () => {},
    removeListener: () => {},
  };
  window.chrome.tabs.onRemoved = {
    addListener: () => {},
    removeListener: () => {},
  };
})();
