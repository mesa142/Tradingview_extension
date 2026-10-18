/**
 * offscreen.js — MV3 Offscreen Document for Reliable Audio Playback
 *
 * Uses the Web Audio API to synthesize clean, zero-latency trading alert chimes
 * without requiring external sound files or network round-trips.
 */

'use strict';

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Play a synthesized dual-tone chime or alert sound
 * @param {'chime'|'success'|'warning'|'urgent'} soundType
 */
function playTone(soundType = 'chime') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    if (soundType === 'warning') {
      // Descending warning tone
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(220, now + 0.3);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (soundType === 'urgent') {
      // Rapid double pulse
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1174.66, now + 0.1);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.setValueAtTime(0.02, now + 0.09);
      gain.gain.setValueAtTime(0.25, now + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else {
      // Standard pleasant trading chime: D5 (587.33 Hz) -> A5 (880 Hz)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880.0, now + 0.12);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc.start(now);
      osc.stop(now + 0.45);
    }
  } catch (err) {
    console.warn('[Offscreen Audio] Failed to play tone:', err);
  }
}

// Listen for playback requests from background service worker
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'PLAY_ALERT_AUDIO') {
      playTone(msg.sound || 'chime');
      sendResponse({ ok: true, played: true });
      return true;
    }
    return false;
  });
}

// Also expose on window for direct invocation/testing
window.playTone = playTone;
