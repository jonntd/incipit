import { reactFiberForElement } from '../capability/fingerprints/fiber.js';
import { runLegacyInit } from './registry.js';

// Dormant prototype (2026-06-02): keep the implementation, but do not import
// it from enhance_legacy.js or ship matching CSS until this feature enters plan.
const LIST_SELECTOR = '[class*="sessionsList"]';
const ITEM_SELECTOR = 'button[class*="sessionItem"]';
const META_SELECTOR = '[class*="sessionMeta"]';
const TIME_SELECTOR = '[class*="sessionTime"]';
const STATE_ATTR = 'data-incipit-session-state';
const SPINNER_ATTR = 'data-incipit-session-spinner';
const REFRESH_MS = 450;

const STATE_LABELS = Object.freeze({
  running: 'Running',
  waiting: 'Waiting',
  loading: 'Loading',
});

export function initLegacySessionStatus(ctx) {
  runLegacyInit('session_status', ctx, () => {
    setupSessionStatusIndicators();
  });
}

function setupSessionStatusIndicators() {
  let refreshTimer = 0;
  let refreshScheduled = false;

  function signalValue(signal) {
    try {
      return signal && typeof signal === 'object' && 'value' in signal ? signal.value : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function isSignalLike(value) {
    return !!value && typeof value === 'object' && 'value' in value;
  }

  function isSessionState(value) {
    return !!value && typeof value === 'object' &&
      isSignalLike(value.busy) &&
      isSignalLike(value.pendingInput) &&
      isSignalLike(value.isLoading) &&
      isSignalLike(value.sessionId);
  }

  function elementIsVisible(el) {
    return !!el && !!el.isConnected && el.getClientRects().length > 0;
  }

  function shouldSkipScanValue(value) {
    return !value ||
      typeof value !== 'object' ||
      value === window ||
      value === document ||
      value.nodeType === 1 ||
      value.nodeType === 9;
  }

  function findSessionInValue(value, depth, seen) {
    if (isSessionState(value)) return value;
    if (depth <= 0 || shouldSkipScanValue(value)) return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const preferred = ['session', 'props', 'value', 'current', 'child', 'children'];
    for (const key of preferred) {
      let next;
      try {
        next = value[key];
      } catch (_) {
        continue;
      }
      const hit = findSessionInValue(next, depth - 1, seen);
      if (hit) return hit;
    }

    let keys;
    try {
      keys = Object.keys(value);
    } catch (_) {
      return null;
    }

    const limit = Math.min(keys.length, 24);
    for (let i = 0; i < limit; i += 1) {
      const key = keys[i];
      if (preferred.includes(key)) continue;
      let next;
      try {
        next = value[key];
      } catch (_) {
        continue;
      }
      const hit = findSessionInValue(next, depth - 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  function sessionForRow(row) {
    let fiber = reactFiberForElement(row);
    for (let hops = 0; fiber && hops < 24; hops += 1, fiber = fiber.return) {
      const seen = new WeakSet();
      const hit = findSessionInValue(fiber.memoizedProps, 4, seen) ||
        findSessionInValue(fiber.pendingProps, 4, seen) ||
        findSessionInValue(fiber.memoizedState, 3, seen);
      if (hit) return hit;
    }
    return null;
  }

  function stateForSession(session) {
    if (!session) return '';
    if (signalValue(session.pendingInput) === true) return 'waiting';
    if (signalValue(session.isLoading) === true) return 'loading';
    if (signalValue(session.busy) === true) return 'running';
    return '';
  }

  function removeSpinner(row) {
    row.removeAttribute(STATE_ATTR);
    row.querySelectorAll('[' + SPINNER_ATTR + ']').forEach(spinner => spinner.remove());
  }

  function applySpinner(row, state) {
    const meta = row.querySelector(META_SELECTOR);
    if (!meta) {
      removeSpinner(row);
      return;
    }

    let spinner = row.querySelector('[' + SPINNER_ATTR + ']');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.setAttribute(SPINNER_ATTR, '');
      spinner.setAttribute('role', 'img');
    }
    row.querySelectorAll('[' + SPINNER_ATTR + ']').forEach(extra => {
      if (extra !== spinner) extra.remove();
    });

    const label = STATE_LABELS[state] || 'Running';
    spinner.title = label;
    spinner.setAttribute('aria-label', label);
    row.setAttribute(STATE_ATTR, state);

    if (spinner.parentNode !== row || spinner.nextSibling !== meta) {
      row.insertBefore(spinner, meta);
    }
  }

  function refreshRow(row) {
    const session = sessionForRow(row);
    const state = stateForSession(session);
    if (!state) {
      removeSpinner(row);
      return;
    }
    applySpinner(row, state);
  }

  function visibleSessionRows() {
    return Array.from(document.querySelectorAll(LIST_SELECTOR + ' ' + ITEM_SELECTOR))
      .filter(row => elementIsVisible(row) && elementIsVisible(row.closest(LIST_SELECTOR)));
  }

  function stopRefreshLoop() {
    if (!refreshTimer) return;
    window.clearInterval(refreshTimer);
    refreshTimer = 0;
  }

  function refreshVisibleSessionRows() {
    refreshScheduled = false;
    const rows = visibleSessionRows();
    if (!rows.length) {
      stopRefreshLoop();
      return;
    }
    for (const row of rows) refreshRow(row);
    if (!refreshTimer) refreshTimer = window.setInterval(refreshVisibleSessionRows, REFRESH_MS);
  }

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    window.requestAnimationFrame(refreshVisibleSessionRows);
  }

  function scheduleBurstRefresh() {
    scheduleRefresh();
    window.setTimeout(scheduleRefresh, 60);
    window.setTimeout(scheduleRefresh, 180);
    window.setTimeout(scheduleRefresh, 420);
    window.setTimeout(scheduleRefresh, 900);
  }

  document.addEventListener('pointerdown', scheduleBurstRefresh, { capture: true, passive: true });
  document.addEventListener('focusin', scheduleBurstRefresh, { capture: true, passive: true });
  document.addEventListener('keydown', scheduleBurstRefresh, { capture: true, passive: true });
  document.addEventListener('visibilitychange', scheduleBurstRefresh, { passive: true });
  scheduleBurstRefresh();
  window.setTimeout(scheduleRefresh, 1500);
  window.setTimeout(scheduleRefresh, 2500);
}
