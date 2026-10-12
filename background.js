/**
 * background.js — MV3 service worker (module).
 *
 * Responsibilities (kept intentionally thin; the chart tab owns extraction):
 *  1. Lifecycle: seed default storage + log install/update for diagnostics.
 *  2. Relay: stream ticks arrive here too when the popup is closed; persist
 *     the latest so reopening the popup restores continuity.
 *  3. Housekeeping: stop per-tab streaming when a tab closes/navigates away
 *     (content scripts die with the page, but this keeps state truthful and
 *     avoids stale "streaming" badges).
 *  4. Action badge: subtle per-tab streaming indicator (no badge = idle).
 */

'use strict';

const BADGE_STREAMING = '●';
const BADGE_COLOR = '#2962ff';

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const { tvSettings } = await chrome.storage.local.get('tvSettings');
    if (!tvSettings) {
      await chrome.storage.local.set({
        tvSettings: { streamIntervalMs: 1000, version: 1 },
        tvLastSnapshot: null,
        tvLastError: null,
      });
    }
    console.info('[TV-Extractor] installed:', details.reason);
  } catch (err) {
    console.warn('[TV-Extractor] onInstalled failed:', err);
  }
});

chrome.runtime.onStartup?.addListener(() => {
  console.info('[TV-Extractor] browser startup.');
});

// ---------------------------------------------------------------------------
// Stream tick relay: popup may be closed, so persist ticks centrally.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'TV_STREAM_TICK') {
      const tabId = sender?.tab?.id;
      (async () => {
        try {
          if (msg.ok && msg.data) {
            await chrome.storage.local.set({
              tvLastSnapshot: msg.data,
              tvLastError: null,
              tvLastTickAt: Date.now(),
            });
            if (tabId != null) {
              await chrome.action.setBadgeText({ text: BADGE_STREAMING, tabId }).catch(() => {});
              await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId }).catch(() => {});
            }
          } else if (msg.error) {
            await chrome.storage.local.set({ tvLastError: msg.error }).catch(() => {});
          }
        } catch (err) {
          console.warn('[TV-Extractor] tick persist failed:', err);
        }
      })();
      // Don't hold the message channel open; content.js alreadyYN handles
      // popup delivery via its own sendMessage fan-out.
      return false;
    }

    if (msg.type === 'TV_STREAM_STOPPED') {
      const tabId = sender?.tab?.id ?? msg.tabId;
      if (tabId != null) {
        chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
      }
      return false;
    }
  } catch (err) {
    console.warn('[TV-Extractor] background handler failed:', err);
  }
  return false;
});

// ---------------------------------------------------------------------------
// Housekeeping: clear badge when streaming tabs go away.
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Navigation / reload kills the page's observer — clear any stale badge.
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  }
});
