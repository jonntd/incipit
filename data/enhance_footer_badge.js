import { CFG, getActiveClaudeSessionId } from './enhance_shared.js';
import { SEL } from './host_probe.js';

// ============================================================
// Footer button label abbreviation.
// ============================================================
// Host renders the permission-mode button label in full ("Bypass
// permissions", "Ask before edits", ...). At our 13px footer width those
// wrap or get clipped by the host's own truncation. Strip them down to
// the first word ("Bypass", "Ask", ...) — the parent button keeps the
// full sentence in its `title` attribute, so hover still discloses the
// mode description.
//
// Why scope to the footer instead of `document.body`: a `characterData`
// observer on body subtree disables Chromium's IME paint optimization
// and re-introduces the phantom-glyph bug (see "IME paint 残留 bug" in
// memo). The footer is a sibling of `inputContainer`, never an ancestor
// of the editor, so its observer cannot reach the contenteditable node.
function setupFooterAbbreviation() {
  let footerObs = null;
  let attachedFooter = null;

  function firstWord(text) {
    const m = (text || '').trim().match(/^\S+/);
    return m ? m[0] : '';
  }

  // Idempotent: stores the original full text on the span itself, so a
  // repeat scan against an already-abbreviated label is a no-op. When
  // React swaps in a different mode label, current text no longer
  // matches `firstWord(stored)` and we re-derive.
  function abbreviate(span) {
    if (!span || span.nodeType !== 1) return;
    const cur = span.textContent;
    if (!cur) return;
    const stored = span.dataset.incipitFooterFull;
    if (stored && cur === firstWord(stored)) return;
    const first = firstWord(cur);
    if (!first) return;
    span.dataset.incipitFooterFull = cur;
    if (cur !== first) span.textContent = first;
  }

  function scanAll(root) {
    if (!root || !root.querySelectorAll) return;
    const SEL = '[data-incipit-footer-button-label]';
    if (root.matches?.(SEL)) abbreviate(root);
    root.querySelectorAll(SEL).forEach(abbreviate);
  }

  function attach(footer) {
    if (!footer || footer === attachedFooter) return;
    if (footerObs) footerObs.disconnect();
    attachedFooter = footer;
    scanAll(footer);
    footerObs = new MutationObserver(() => scanAll(footer));
    footerObs.observe(footer, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  const initial = document.querySelector('[data-incipit-input-footer]');
  if (initial) attach(initial);

  // Body-level finder is childList-only (no characterData) and so safe
  // against the IME paint bug. Its only job is to spot footer remounts.
  const finder = new MutationObserver(() => {
    const f = document.querySelector('[data-incipit-input-footer]');
    if (f && f !== attachedFooter) attach(f);
  });
  finder.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Inline keyboard symbols → SVG.
// ============================================================
// The host renders shortcut hints like `⇧ + tab to switch` using
// `<kbd>` chips that contain Unicode modifier glyphs (U+21E7, etc.).
// Cross-platform font fallback for these glyphs is unreliable: Segoe
// UI Symbol on Windows draws a thin stroke arrow that visually
// disagrees with the next-door letter `tab` (Rec Mono Linear, solid
// glyph weight). Replace the character with an inline SVG drawn at
// the same visual weight as a Latin uppercase letter so left and
// right chips read as siblings on every OS.
//
// The map is character-keyed and trivially extensible — add a new
// entry to cover ⌘ ⌥ ⌃ ⏎ ⌫ ⎋ if the host starts shipping them.
function setupKbdSymbols() {
  const SVG_MAP = {
    // ⇧ Shift (U+21E7). viewBox 12×12 matches uppercase letter
    // cap-height proportions; solid fill on currentColor so the
    // chip foreground tints both letter and arrow uniformly.
    '⇧':
      '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"' +
      ' style="display:inline-block;width:0.85em;height:0.85em;' +
      'vertical-align:-0.13em;fill:currentColor">' +
      '<path d="M6 1 L10.5 6 L8 6 L8 11 L4 11 L4 6 L1.5 6 Z"/>' +
      '</svg>',
  };

  const SEL = '[class*="menuHeaderHint"] kbd, [class*="keys_"] kbd';

  function decorate(kbd) {
    if (!kbd || kbd.nodeType !== 1) return;
    if (kbd.dataset.incipitKbdSvg === '1') return;
    const txt = (kbd.textContent || '').trim();
    if (txt.length !== 1) return;
    const svg = SVG_MAP[txt];
    if (!svg) return;
    kbd.dataset.incipitKbdSvg = '1';
    kbd.innerHTML = svg;
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches?.(SEL)) decorate(root);
    root.querySelectorAll(SEL).forEach(decorate);
  }

  scan(document.body);

  // Body-level childList observer (no characterData → IME-paint safe).
  // Modes/history popups mount on demand, so we cannot just attach
  // once at init.
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) scan(n);
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ============================================================
// Cache badge.
// ============================================================
// Data arrives from the extension host through `webview.postMessage`.
// The badge is inserted into the input footer before the bypass control.
function setupCacheBadge() {
  if (!CFG.sessionUsage) return;
  var BADGE_CLASS = 'cceBadge';
  var TEXT_CLASS = 'cceBadgeText';
  var POPUP_CLASS = 'cceStatPopup';
  // Outline icon with descending bars for a lightweight stats metaphor.
  var ICON_SVG = '<svg class="cceBadgeIcon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="4" y1="6" x2="16" y2="6"/>' +
    '<line x1="4" y1="10" x2="13" y2="10"/>' +
    '<line x1="4" y1="14" x2="9" y2="14"/>' +
    '</svg>';
  var latest = null;       // Latest payload: ctx/hit plus recent and totals.
  var popupEl = null;
  var popupAnchor = null;  // Badge button currently anchoring the popup.
  var lastIdentityKey = null;
  var identityPublishScheduled = false;
  var identityPublishForce = false;
  var identityPublishNeedsHistory = false;
  var historyRequestScheduled = false;
  var hitRangeStart = 0;
  var hitRangeEnd = 1;
  var hitRangeRenderScheduled = false;
  var selectedHitRows = null;

  function getIncipitVsCodeApi() {
    try {
      if (typeof globalThis.__incipitGetVsCodeApi === 'function') {
        return globalThis.__incipitGetVsCodeApi();
      }
      if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
    } catch (_) {}
    return null;
  }

  function publishBadgeIdentity(force, includeHistory) {
    identityPublishScheduled = false;
    var api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') return;
    var sessionId = getActiveClaudeSessionId();
    var key = sessionId || '';
    if (!force && !includeHistory && key === lastIdentityKey) return;
    var identityChanged = key !== lastIdentityKey;
    lastIdentityKey = key;
    if (identityChanged) {
      latest = null;
      hitRangeStart = 0;
      hitRangeEnd = 1;
      selectedHitRows = null;
      ensureBadge();
      if (isOpen()) { renderPopup(); positionPopup(); }
    }
    try {
      api.postMessage({
        __incipit: true,
        type: 'badge_identity_update',
        sessionId: sessionId || null,
        includeHistory: !!includeHistory,
      });
    } catch (_) {}
  }

  function scheduleBadgeIdentityPublish(force, includeHistory) {
    identityPublishForce = identityPublishForce || !!force;
    identityPublishNeedsHistory = identityPublishNeedsHistory || !!includeHistory;
    if (identityPublishScheduled) return;
    identityPublishScheduled = true;
    requestAnimationFrame(function() {
      var forceNow = identityPublishForce;
      var needsHistoryNow = identityPublishNeedsHistory;
      identityPublishForce = false;
      identityPublishNeedsHistory = false;
      publishBadgeIdentity(forceNow, needsHistoryNow);
    });
  }

  function requestBadgeHistory() {
    if (historyRequestScheduled) return;
    historyRequestScheduled = true;
    requestAnimationFrame(function() {
      historyRequestScheduled = false;
      if (isOpen()) scheduleBadgeIdentityPublish(true, true);
    });
  }

  function setupBadgeIdentityBridge() {
    scheduleBadgeIdentityPublish(true);
    setTimeout(function() { scheduleBadgeIdentityPublish(true); }, 450);
    setTimeout(function() { scheduleBadgeIdentityPublish(true); }, 1800);
    setInterval(function() { scheduleBadgeIdentityPublish(false); }, 2200);
    window.addEventListener('focus', function() { scheduleBadgeIdentityPublish(true); });
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) scheduleBadgeIdentityPublish(true);
    });
    document.addEventListener('click', function() {
      setTimeout(function() { scheduleBadgeIdentityPublish(false); }, 0);
    }, true);
  }

  function fmtTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) {
      var k = n / 1000;
      return (k >= 100 ? k.toFixed(0) : k.toFixed(1)) + 'k';
    }
    return String(n);
  }
  function fmtPct(p) {
    if (!Number.isFinite(p) || p < 0) return '—';
    return (p * 100).toFixed(2) + '%';
  }
  function fmtRelTime(iso) {
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (isNaN(t)) return '—';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }
  function sameLocalDate(a, b) {
    return !!(a && b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate());
  }
  function fmtChartTime(iso, rangeStartIso, rangeEndIso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var start = rangeStartIso ? new Date(rangeStartIso) : null;
    var end = rangeEndIso ? new Date(rangeEndIso) : null;
    var time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (sameLocalDate(start, end)) return time;
    return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + time;
  }
  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' h ' + (mm ? mm + ' min' : '');
  }
  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }
  function axisPct(p) {
    if (!Number.isFinite(p)) return '—';
    return Math.round(p * 100) + '%';
  }
  function svgNumber(n) {
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '0';
  }
  function pctNumber(n) {
    if (!Number.isFinite(n) || n <= 0) return '0';
    return String(Math.round(n * 10) / 10);
  }
  function rowTimeMs(row, fallback) {
    if (row && row.ts) {
      var t = Date.parse(row.ts);
      if (!isNaN(t)) return t;
    }
    return fallback;
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function revealVal(el, target) {
    if (el.__cceRAF) { cancelAnimationFrame(el.__cceRAF); el.__cceRAF = null; }
    if (!target) { el.textContent = ''; return; }
    var len = target.length;
    var display = new Array(len + 1).join(' ');
    // Frame-counted instead of timestamp-based: STEP=40ms vs rAF's 16.67ms
    // gave a 2-2-3-2-3 cadence that read as jitter. N frames per step keeps
    // every advance landing on a vsync edge — clean rhythm at any refresh
    // rate, slightly faster on 120Hz panels (acceptable trade for stability).
    var FRAMES_PER_STEP = 16;
    var index = 0, frameSkip = 0;
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function frame() {
      if (frameSkip < FRAMES_PER_STEP - 1) {
        frameSkip++;
        el.__cceRAF = requestAnimationFrame(frame);
        return;
      }
      frameSkip = 0;
      if (index - 3 >= len) {
        el.textContent = target;
        el.__cceRAF = null;
        return;
      }
      var arr = display.split('');
      for (var w = 0; w <= 3; w++) {
        var F = index - w;
        if (F >= 0 && F < len) {
          var ch = target[F];
          if (ch === ' ') arr[F] = ' ';
          else if (w === 3) arr[F] = ch;
          else if (w === 0) arr[F] = '\u258C';
          else arr[F] = pick(['.', '_', ch]);
        }
      }
      display = arr.join('');
      el.textContent = display;
      index++;
      el.__cceRAF = requestAnimationFrame(frame);
    }
    el.__cceRAF = requestAnimationFrame(frame);
  }
  // Some backends expose no prompt-cache counters at all.
  // Show `—` instead of `0%` so the UI reads as unsupported, not as a miss.
  function sessionHasNoCache(payload) {
    if (!payload || !payload.totals) return false;
    var T = payload.totals;
    return (T.cr || 0) === 0 && (T.cw || 0) === 0;
  }
  function renderText(textEl) {
    if (!textEl) return;
    var ctxStr, hitStr;
    if (!latest) {
      ctxStr = '—'; hitStr = '—';
    } else {
      ctxStr = fmtTokens(latest.ctx);
      hitStr = sessionHasNoCache(latest) ? '—' : fmtPct(latest.hit);
    }
    if (!textEl.__cceBuilt) {
      textEl.innerHTML =
        '<span class="cceBadgeLabel">Ctx</span> ' +
        '<span class="cceBadgeVal" data-cce-val="ctx"></span>' +
        '    ' +
        '<span class="cceBadgeLabel">Cache</span> ' +
        '<span class="cceBadgeVal" data-cce-val="hit"></span>';
      textEl.__cceBuilt = true;
    }
    var ctxEl = textEl.querySelector('[data-cce-val="ctx"]');
    var hitEl = textEl.querySelector('[data-cce-val="hit"]');
    if (ctxEl && ctxEl.__cceLast !== ctxStr) {
      var firstCtx = ctxEl.__cceLast === undefined;
      ctxEl.__cceLast = ctxStr;
      if (firstCtx) ctxEl.textContent = ctxStr;
      else revealVal(ctxEl, ctxStr);
    }
    if (hitEl && hitEl.__cceLast !== hitStr) {
      var firstHit = hitEl.__cceLast === undefined;
      hitEl.__cceLast = hitStr;
      if (firstHit) hitEl.textContent = hitStr;
      else revealVal(hitEl, hitStr);
    }
  }

  function buildPopup() {
    var el = document.createElement('div');
    el.className = POPUP_CLASS;
    el.setAttribute('role', 'dialog');
    el.innerHTML =
      '<div class="cceStatOverview" data-overview></div>' +
      '<div class="cceStatSection">' +
        '<div class="cceStatHeading">Cache hit history</div>' +
        '<div class="cceHitChart" data-history></div>' +
      '</div>' +
      '<div class="cceStatDivider"></div>' +
      '<div class="cceStatSection">' +
        '<div class="cceStatHeading">Selected range</div>' +
        '<div class="cceStatTotals" data-totals></div>' +
      '</div>';
    el.addEventListener('click', function(ev) { ev.stopPropagation(); });
    return el;
  }
  function cacheHistoryRows() {
    var rows = latest && Array.isArray(latest.history) ? latest.history : null;
    if (!rows || !rows.length) rows = latest && Array.isArray(latest.recent) ? latest.recent : [];
    return rows
      .filter(function(r) {
        return r && Number.isFinite(r.hit) && r.hit >= 0;
      })
      .map(function(r) {
        return {
          ts: r.ts || '',
          ctx: Number.isFinite(r.ctx) ? r.ctx : 0,
          hit: clamp(r.hit, 0, 1),
          input: Number.isFinite(r.input) ? r.input : 0,
          write: Number.isFinite(r.cw) ? r.cw : (Number.isFinite(r.write) ? r.write : 0),
          read: Number.isFinite(r.cr) ? r.cr : (Number.isFinite(r.read) ? r.read : 0),
          output: Number.isFinite(r.output) ? r.output : 0,
        };
      });
  }
  function sameBadgePayloadIdentity(a, b) {
    if (!a || !b) return false;
    var aSession = a.sessionId || '';
    var bSession = b.sessionId || '';
    var aSrc = a.src || '';
    var bSrc = b.src || '';
    return (!aSession || !bSession || aSession === bSession) &&
           (!aSrc || !bSrc || aSrc === bSrc);
  }
  function mergeRetainedHistory(payload) {
    if (!payload || Array.isArray(payload.history)) return payload;
    if (!latest || !Array.isArray(latest.history) || !sameBadgePayloadIdentity(payload, latest)) {
      return payload;
    }
    var merged = {};
    for (var key in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) merged[key] = payload[key];
    }
    merged.history = latest.history;
    return merged;
  }
  function minHitRangeFraction(count) {
    if (!Number.isFinite(count) || count <= 2) return 1;
    return Math.min(0.25, Math.max(6 / Math.max(1, count - 1), 0.015));
  }
  function normalizeHitRange(count) {
    if (!Number.isFinite(count) || count <= 1) {
      hitRangeStart = 0;
      hitRangeEnd = 1;
      return { start: 0, end: 1, min: 1 };
    }
    var min = minHitRangeFraction(count);
    var start = clamp(hitRangeStart, 0, 1);
    var end = clamp(hitRangeEnd, 0, 1);
    if (end < start) {
      var tmp = start;
      start = end;
      end = tmp;
    }
    if (end - start < min) {
      var center = clamp((start + end) / 2, min / 2, 1 - min / 2);
      start = center - min / 2;
      end = center + min / 2;
    }
    hitRangeStart = clamp(start, 0, 1 - min);
    hitRangeEnd = clamp(end, hitRangeStart + min, 1);
    return { start: hitRangeStart, end: hitRangeEnd, min: min };
  }
  function visibleHistoryRows(rows) {
    if (!rows || !rows.length) return [];
    var range = normalizeHitRange(rows.length);
    if (range.start <= 0.0001 && range.end >= 0.9999) return rows.slice();
    var maxIndex = rows.length - 1;
    var startIndex = Math.floor(range.start * maxIndex);
    var endIndex = Math.ceil(range.end * maxIndex);
    startIndex = Math.max(0, Math.min(maxIndex, startIndex));
    endIndex = Math.max(startIndex, Math.min(maxIndex, endIndex));
    return rows.slice(startIndex, endIndex + 1);
  }
  function setHitRange(start, end) {
    var rows = cacheHistoryRows();
    var count = rows.length;
    var min = minHitRangeFraction(count);
    start = clamp(start, 0, 1);
    end = clamp(end, 0, 1);
    if (end < start) {
      var t = start;
      start = end;
      end = t;
    }
    if (end - start < min) {
      if (Math.abs(start - hitRangeStart) > Math.abs(end - hitRangeEnd)) end = start + min;
      else start = end - min;
    }
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > 1) {
      start -= end - 1;
      end = 1;
    }
    start = clamp(start, 0, Math.max(0, 1 - min));
    end = clamp(end, Math.min(1, start + min), 1);
    if (Math.abs(start - hitRangeStart) < 0.0005 && Math.abs(end - hitRangeEnd) < 0.0005) return;
    hitRangeStart = start;
    hitRangeEnd = end;
    scheduleHitRangeRender();
  }
  function scheduleHitRangeRender() {
    if (hitRangeRenderScheduled) return;
    hitRangeRenderScheduled = true;
    requestAnimationFrame(function() {
      hitRangeRenderScheduled = false;
      if (!isOpen()) return;
      renderPopup();
      positionPopup();
    });
  }
  function summarizeHistoryRows(rows) {
    rows = rows || [];
    var out = {
      requests: rows.length,
      fresh: 0,
      write: 0,
      read: 0,
      output: 0,
      totalContext: 0,
      latestHit: rows.length ? rows[rows.length - 1].hit : NaN,
      meanHit: NaN,
      minHit: NaN,
      durationMs: 0,
      firstTs: rows.length ? rows[0].ts : '',
      lastTs: rows.length ? rows[rows.length - 1].ts : '',
    };
    if (!rows.length) return out;
    var hitSum = 0;
    var minHit = 1;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.fresh += r.input || 0;
      out.write += r.write || 0;
      out.read += r.read || 0;
      out.output += r.output || 0;
      out.totalContext += r.ctx || 0;
      hitSum += r.hit || 0;
      minHit = Math.min(minHit, r.hit || 0);
    }
    out.meanHit = hitSum / rows.length;
    out.minHit = minHit;
    var first = Date.parse(out.firstTs);
    var last = Date.parse(out.lastTs);
    if (!isNaN(first) && !isNaN(last) && last >= first) out.durationMs = last - first;
    return out;
  }
  function rangeTimeLabel(rows) {
    if (!rows || !rows.length) return '—';
    var first = rows[0].ts;
    var last = rows[rows.length - 1].ts;
    if (rows.length === 1) return fmtChartTime(first, first, last);
    return fmtChartTime(first, first, last) + ' - ' + fmtChartTime(last, first, last);
  }
  function sampledLinePoints(points, maxBuckets) {
    if (!points || points.length <= maxBuckets * 2) return points || [];
    var buckets = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var b = Math.max(0, Math.min(maxBuckets - 1, Math.floor((p.xNorm || 0) * maxBuckets)));
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(p);
    }
    var out = [];
    var seen = new Set();
    function add(p) {
      if (!p || seen.has(p.index)) return;
      seen.add(p.index);
      out.push(p);
    }
    for (var j = 0; j < buckets.length; j++) {
      var group = buckets[j];
      if (!group || !group.length) continue;
      var minY = group[0];
      var maxY = group[0];
      for (var k = 1; k < group.length; k++) {
        if (group[k].y < minY.y) minY = group[k];
        if (group[k].y > maxY.y) maxY = group[k];
      }
      add(group[0]);
      add(minY);
      add(maxY);
      add(group[group.length - 1]);
    }
    out.sort(function(a, b) { return a.index - b.index; });
    return out;
  }
  function pathFromPoints(points) {
    return (points || []).map(function(p, i) {
      return (i ? 'L' : 'M') + svgNumber(p.x) + ' ' + svgNumber(p.y);
    }).join(' ');
  }
  function renderOverview(box) {
    if (!box) return;
    var hitStr = latest && !sessionHasNoCache(latest) ? fmtPct(latest.hit) : '—';
    var ctxStr = latest ? fmtTokens(latest.ctx) : '—';
    box.innerHTML =
      '<div class="cceStatMetric">' +
        '<div class="cceStatMetricLabel">Current cache</div>' +
        '<div class="cceStatMetricValue">' + hitStr + '</div>' +
      '</div>' +
      '<div class="cceStatMetric">' +
        '<div class="cceStatMetricLabel">Context</div>' +
        '<div class="cceStatMetricValue">' + ctxStr + '</div>' +
      '</div>';
  }
  function renderHistoryChart(box) {
    if (!box) return;
    if (!latest || sessionHasNoCache(latest)) {
      selectedHitRows = null;
      box.innerHTML = '<div class="cceStatEmpty">No cache hit history yet</div>';
      return;
    }

    var fullRows = cacheHistoryRows();
    if (!fullRows.length) {
      selectedHitRows = null;
      box.innerHTML = '<div class="cceStatEmpty">No cache hit history yet</div>';
      return;
    }

    var range = normalizeHitRange(fullRows.length);
    var rows = visibleHistoryRows(fullRows);
    selectedHitRows = rows;
    var hits = rows.map(function(r) { return r.hit; });
    var minHit = Math.min.apply(null, hits);
    var maxHit = Math.max.apply(null, hits);
    var sum = hits.reduce(function(a, b) { return a + b; }, 0);
    var mean = hits.length ? sum / hits.length : 0;
    var latestHit = hits[hits.length - 1];

    var spread = maxHit - minHit;
    var pad = Math.max(0.02, spread * 0.3);
    var domainMin = clamp(Math.floor((minHit - pad) * 100) / 100, 0, 1);
    var domainMax = clamp(Math.ceil((maxHit + pad) * 100) / 100, 0, 1);
    if (domainMax - domainMin < 0.06) {
      var center = (domainMax + domainMin) / 2;
      domainMin = clamp(center - 0.03, 0, 1);
      domainMax = clamp(center + 0.03, 0, 1);
      if (domainMax - domainMin < 0.06) {
        if (domainMin <= 0) domainMax = clamp(domainMin + 0.06, 0, 1);
        else domainMin = clamp(domainMax - 0.06, 0, 1);
      }
    }

    var W = 500, H = 184, padL = 36, padR = 12, padT = 30, padB = 26;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var denom = Math.max(1, rows.length - 1);
    function xAt(i) { return padL + (i / denom) * plotW; }
    function yAt(hit) {
      return padT + ((domainMax - hit) / Math.max(0.001, domainMax - domainMin)) * plotH;
    }
    var points = rows.map(function(r, i) {
      var xNorm = denom ? i / denom : 0;
      return { index: i, xNorm: xNorm, x: xAt(i), y: yAt(r.hit), hit: r.hit, ctx: r.ctx, ts: r.ts };
    });
    var path = pathFromPoints(sampledLinePoints(points, Math.max(120, Math.floor(plotW))));
    var minIndex = hits.indexOf(minHit);
    var lowPoint = points[minIndex];
    var latestPoint = points[points.length - 1];
    var mid = (domainMin + domainMax) / 2;
    var newestTs = rows[rows.length - 1] && rows[rows.length - 1].ts;
    var oldestTs = rows[0] && rows[0].ts;
    var markers = '';
    if (lowPoint) {
      markers += '<circle class="cceHitPoint cceHitPointLow" cx="' + svgNumber(lowPoint.x) + '" cy="' + svgNumber(lowPoint.y) + '" r="3.4">' +
        '<title>Lowest · ' + fmtPct(lowPoint.hit) + ' · ' + fmtTokens(lowPoint.ctx) + ' · ' + fmtChartTime(lowPoint.ts, oldestTs, newestTs) + '</title>' +
      '</circle>';
    }
    if (latestPoint && latestPoint !== lowPoint) {
      markers += '<circle class="cceHitPoint cceHitPointLatest" cx="' + svgNumber(latestPoint.x) + '" cy="' + svgNumber(latestPoint.y) + '" r="3">' +
        '<title>Latest · ' + fmtPct(latestPoint.hit) + ' · ' + fmtTokens(latestPoint.ctx) + ' · ' + fmtChartTime(latestPoint.ts, oldestTs, newestTs) + '</title>' +
      '</circle>';
    }
    var midIndex = Math.floor((rows.length - 1) / 2);
    var midPoint = points[midIndex] || points[0];
    var midTs = rows[midIndex] && rows[midIndex].ts;
    var topLabel = axisPct(domainMax);
    var midLabel = axisPct(mid);
    var bottomLabel = axisPct(domainMin);
    var axisY = H - padB;
    var midX = midPoint ? svgNumber(midPoint.x) : svgNumber(padL + plotW / 2);
    var oldestLabel = fmtChartTime(oldestTs, oldestTs, newestTs);
    var midTimeLabel = fmtChartTime(midTs, oldestTs, newestTs);
    var newestLabel = fmtChartTime(newestTs, oldestTs, newestTs);
    var fullHits = fullRows.map(function(r) { return r.hit; });
    var fullMinHit = Math.min.apply(null, fullHits);
    var fullMaxHit = Math.max.apply(null, fullHits);
    var overviewPad = Math.max(0.02, (fullMaxHit - fullMinHit) * 0.25);
    var overviewMin = clamp(fullMinHit - overviewPad, 0, 1);
    var overviewMax = clamp(fullMaxHit + overviewPad, 0, 1);
    if (overviewMax - overviewMin < 0.06) {
      var overviewCenter = (overviewMax + overviewMin) / 2;
      overviewMin = clamp(overviewCenter - 0.03, 0, 1);
      overviewMax = clamp(overviewCenter + 0.03, 0, 1);
      if (overviewMax - overviewMin < 0.06) {
        if (overviewMin <= 0) overviewMax = clamp(overviewMin + 0.06, 0, 1);
        else overviewMin = clamp(overviewMax - 0.06, 0, 1);
      }
    }
    var rangeH = 44, rangePadT = 8, rangePadB = 14;
    var rangePlotH = rangeH - rangePadT - rangePadB;
    var fullDenom = Math.max(1, fullRows.length - 1);
    function rangeYAt(hit) {
      return rangePadT + ((overviewMax - hit) / Math.max(0.001, overviewMax - overviewMin)) * rangePlotH;
    }
    var overviewPoints = fullRows.map(function(r, i) {
      var xNorm = i / fullDenom;
      return {
        index: i,
        xNorm: xNorm,
        x: padL + xNorm * plotW,
        y: rangeYAt(r.hit),
      };
    });
    var overviewPath = pathFromPoints(sampledLinePoints(overviewPoints, 180));
    var selX1 = padL + range.start * plotW;
    var selX2 = padL + range.end * plotW;
    var selWidth = Math.max(2, selX2 - selX1);

    box.innerHTML =
      '<div class="cceHitChartShell">' +
        '<svg class="cceHitSvg" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
          '<line class="cceHitGrid" x1="' + padL + '" y1="' + svgNumber(yAt(domainMax)) + '" x2="' + (W - padR) + '" y2="' + svgNumber(yAt(domainMax)) + '"></line>' +
          '<line class="cceHitGrid" x1="' + padL + '" y1="' + svgNumber(yAt(mid)) + '" x2="' + (W - padR) + '" y2="' + svgNumber(yAt(mid)) + '"></line>' +
          '<line class="cceHitGrid" x1="' + padL + '" y1="' + svgNumber(yAt(domainMin)) + '" x2="' + (W - padR) + '" y2="' + svgNumber(yAt(domainMin)) + '"></line>' +
          '<line class="cceHitXAxis" x1="' + padL + '" y1="' + axisY + '" x2="' + (W - padR) + '" y2="' + axisY + '"></line>' +
          '<line class="cceHitXTick" x1="' + padL + '" y1="' + axisY + '" x2="' + padL + '" y2="' + (axisY + 4) + '"></line>' +
          '<line class="cceHitXTick" x1="' + midX + '" y1="' + axisY + '" x2="' + midX + '" y2="' + (axisY + 4) + '"></line>' +
          '<line class="cceHitXTick" x1="' + (W - padR) + '" y1="' + axisY + '" x2="' + (W - padR) + '" y2="' + (axisY + 4) + '"></line>' +
          '<text class="cceHitAxisLabel" x="0" y="' + svgNumber(yAt(domainMax) + 3) + '">' + topLabel + '</text>' +
          '<text class="cceHitAxisLabel" x="0" y="' + svgNumber(yAt(mid) + 3) + '">' + midLabel + '</text>' +
          '<text class="cceHitAxisLabel" x="0" y="' + svgNumber(yAt(domainMin) + 3) + '">' + bottomLabel + '</text>' +
          '<path class="cceHitLine" d="' + path + '"></path>' +
          markers +
          '<g class="cceHitHover" aria-hidden="true">' +
            '<line class="cceHitHoverLine" x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '"></line>' +
            '<circle class="cceHitHoverPoint" cx="' + padL + '" cy="' + padT + '" r="3.2"></circle>' +
          '</g>' +
        '</svg>' +
        '<div class="cceHitHoverLabel" data-hit-hover-label></div>' +
        '<div class="cceHitChartMeta">' +
          '<span>' + oldestLabel + '</span>' +
          '<span>' + midTimeLabel + '</span>' +
          '<span>' + newestLabel + '</span>' +
        '</div>' +
        '<div class="cceHitRange" data-hit-range>' +
          '<svg class="cceRangeSvg" viewBox="0 0 ' + W + ' ' + rangeH + '" aria-hidden="true">' +
            '<path class="cceRangeLine" d="' + overviewPath + '"></path>' +
            '<line class="cceRangeTrack" x1="' + padL + '" y1="' + (rangeH - 8) + '" x2="' + (W - padR) + '" y2="' + (rangeH - 8) + '"></line>' +
            '<rect class="cceRangeHit cceRangeTrackHit" data-range-part="track" x="' + padL + '" y="0" width="' + plotW + '" height="' + rangeH + '"></rect>' +
            '<rect class="cceRangeWindow" data-range-part="move" x="' + svgNumber(selX1) + '" y="5" width="' + svgNumber(selWidth) + '" height="28" rx="4"></rect>' +
            '<line class="cceRangeHandle" x1="' + svgNumber(selX1) + '" y1="4" x2="' + svgNumber(selX1) + '" y2="34"></line>' +
            '<line class="cceRangeHandle" x1="' + svgNumber(selX2) + '" y1="4" x2="' + svgNumber(selX2) + '" y2="34"></line>' +
            '<rect class="cceRangeHit cceRangeMoveHit" data-range-part="move" x="' + svgNumber(selX1 + 8) + '" y="0" width="' + svgNumber(Math.max(0, selWidth - 16)) + '" height="36"></rect>' +
            '<rect class="cceRangeHit cceRangeHandleHit" data-range-part="start" x="' + svgNumber(selX1 - 8) + '" y="0" width="16" height="36"></rect>' +
            '<rect class="cceRangeHit cceRangeHandleHit" data-range-part="end" x="' + svgNumber(selX2 - 8) + '" y="0" width="16" height="36"></rect>' +
          '</svg>' +
        '</div>' +
      '</div>' +
      '<div class="cceHitStats">' +
        '<div class="cceHitStat"><span>Latest</span><strong>' + fmtPct(latestHit) + '</strong></div>' +
        '<div class="cceHitStat"><span>Mean</span><strong>' + fmtPct(mean) + '</strong></div>' +
        '<div class="cceHitStat"><span>Lowest</span><strong>' + fmtPct(minHit) + '</strong></div>' +
      '</div>';

    bindHitChartHover(box, points, {
      width: W,
      padLeft: padL,
      padRight: padR,
      padTop: padT,
      padBottom: padB,
      plotWidth: plotW,
      rangeStart: oldestTs,
      rangeEnd: newestTs,
    });
    bindHitRangeSlider(box, {
      width: W,
      padLeft: padL,
      padRight: padR,
      plotWidth: plotW,
      count: fullRows.length,
    });
  }
  function bindHitChartHover(box, points, dims) {
    if (!box || !points || !points.length) return;
    var svg = box.querySelector('.cceHitSvg');
    var shell = box.querySelector('.cceHitChartShell');
    var line = box.querySelector('.cceHitHoverLine');
    var dot = box.querySelector('.cceHitHoverPoint');
    var label = box.querySelector('[data-hit-hover-label]');
    if (!svg || !shell || !line || !dot || !label) return;
    if (!label.__cceHitHoverBuilt) {
      label.innerHTML =
        '<span class="cceHitHoverPct" data-hit-hover-pct></span>' +
        '<span class="cceHitHoverTime" data-hit-hover-time></span>';
      label.__cceHitHoverBuilt = true;
    }
    var pctEl = label.querySelector('[data-hit-hover-pct]');
    var timeEl = label.querySelector('[data-hit-hover-time]');

    var raf = 0;
    var lastEvent = null;

    function hideHover() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      lastEvent = null;
      svg.removeAttribute('data-hit-hovering');
      label.removeAttribute('data-active');
    }

    function applyHover(evt) {
      raf = 0;
      if (!evt) return;
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var xSvg = clamp(
        ((evt.clientX - rect.left) / rect.width) * dims.width,
        dims.padLeft,
        dims.width - dims.padRight,
      );
      var denom = Math.max(1, points.length - 1);
      var index = Math.round(((xSvg - dims.padLeft) / Math.max(1, dims.plotWidth)) * denom);
      index = Math.max(0, Math.min(points.length - 1, index));
      var p = points[index];
      if (!p) return;

      var x = svgNumber(p.x);
      var y = svgNumber(p.y);
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);

      if (pctEl) pctEl.textContent = fmtPct(p.hit);
      if (timeEl) timeEl.textContent = fmtChartTime(p.ts, dims.rangeStart, dims.rangeEnd);
      svg.setAttribute('data-hit-hovering', '1');
      label.setAttribute('data-active', '1');

      var shellRect = shell.getBoundingClientRect();
      var xPx = (p.x / dims.width) * rect.width + (rect.left - shellRect.left);
      var labelWidth = label.offsetWidth || 54;
      xPx = clamp(xPx, labelWidth / 2 + 6, shellRect.width - labelWidth / 2 - 6);
      label.style.left = Math.round(xPx) + 'px';
    }

    function scheduleHover(evt) {
      lastEvent = evt;
      if (raf) return;
      raf = requestAnimationFrame(function() { applyHover(lastEvent); });
    }

    svg.addEventListener('pointermove', scheduleHover);
    svg.addEventListener('pointerleave', hideHover);
    svg.addEventListener('pointercancel', hideHover);
  }
  function bindHitRangeSlider(box, dims) {
    if (!box || !dims || dims.count <= 1) return;
    var svg = box.querySelector('.cceRangeSvg');
    if (!svg) return;
    var drag = null;
    function eventFrac(evt) {
      var rect = drag && drag.rect ? drag.rect : svg.getBoundingClientRect();
      if (!rect.width) return hitRangeStart;
      var xSvg = ((evt.clientX - rect.left) / rect.width) * dims.width;
      return clamp((xSvg - dims.padLeft) / Math.max(1, dims.plotWidth), 0, 1);
    }
    function moveWindowTo(center, width) {
      var half = width / 2;
      var start = center - half;
      var end = center + half;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > 1) {
        start -= end - 1;
        end = 1;
      }
      setHitRange(start, end);
    }
    function onMove(evt) {
      if (!drag) return;
      evt.preventDefault();
      var frac = eventFrac(evt);
      if (drag.part === 'start') {
        setHitRange(frac, drag.end);
      } else if (drag.part === 'end') {
        setHitRange(drag.start, frac);
      } else {
        moveWindowTo(drag.center + (frac - drag.origin), drag.width);
      }
    }
    function onUp() {
      drag = null;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    }
    svg.addEventListener('pointerdown', function(evt) {
      var target = evt.target;
      var part = target && target.getAttribute ? target.getAttribute('data-range-part') : '';
      var frac = eventFrac(evt);
      var width = Math.max(minHitRangeFraction(dims.count), hitRangeEnd - hitRangeStart);
      if (!part || part === 'track') {
        moveWindowTo(frac, width);
        part = 'move';
      }
      var rect = svg.getBoundingClientRect();
      drag = {
        part: part,
        rect: { left: rect.left, width: rect.width },
        origin: frac,
        start: hitRangeStart,
        end: hitRangeEnd,
        center: (hitRangeStart + hitRangeEnd) / 2,
        width: hitRangeEnd - hitRangeStart,
      };
      evt.preventDefault();
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    });
  }
  function tokenBarWidth(value, max) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
    return Math.max(1.6, (value / max) * 100);
  }
  function renderSessionFlow(box) {
    if (!box) return;
    if (!latest || !latest.totals) {
      box.innerHTML = '<div class="cceStatEmpty">—</div>';
      return;
    }

    var rows = selectedHitRows && selectedHitRows.length ? selectedHitRows : cacheHistoryRows();
    var S = summarizeHistoryRows(rows);
    if (!S.requests) {
      box.innerHTML = '<div class="cceStatEmpty">—</div>';
      return;
    }
    var promptTotal = S.fresh + S.write + S.read;
    var freshPct = promptTotal > 0 ? (S.fresh / promptTotal) * 100 : 0;
    var writePct = promptTotal > 0 ? (S.write / promptTotal) * 100 : 0;
    var readPct = promptTotal > 0 ? (S.read / promptTotal) * 100 : 0;
    var requestLabel = String(S.requests) + (S.requests === 1 ? ' request' : ' requests');
    var durationLabel = S.durationMs > 0 ? ' · ' + fmtDuration(S.durationMs) : '';
    function metric(label, value, kind) {
      return '<div class="cceSelectedMetric cceSelectedMetric-' + kind + '">' +
        '<span>' + label + '</span>' +
        '<strong>' + value + '</strong>' +
      '</div>';
    }

    box.innerHTML =
      '<div class="cceFlowContext cceSelectedRange">' +
        '<div class="cceFlowHeader">' +
          '<span>Selected range</span>' +
          '<strong>' + requestLabel + durationLabel + '</strong>' +
        '</div>' +
        '<div class="cceFlowRangeTime">' + rangeTimeLabel(rows) + '</div>' +
        '<div class="cceContextStack" aria-hidden="true">' +
          '<span class="cceContextSeg cceContextSeg-fresh" style="width:' + pctNumber(freshPct) + '%"></span>' +
          '<span class="cceContextSeg cceContextSeg-write" style="width:' + pctNumber(writePct) + '%"></span>' +
          '<span class="cceContextSeg cceContextSeg-read" style="width:' + pctNumber(readPct) + '%"></span>' +
        '</div>' +
        '<div class="cceFlowLegend">' +
          '<span><i class="cceLegendFresh"></i>Fresh ' + fmtTokens(S.fresh) + '</span>' +
          '<span><i class="cceLegendWrite"></i>Write ' + fmtTokens(S.write) + '</span>' +
          '<span><i class="cceLegendRead"></i>Read ' + fmtTokens(S.read) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="cceSelectedGrid">' +
        metric('Cache read', fmtTokens(S.read), 'read') +
        metric('Cache write', fmtTokens(S.write), 'write') +
        metric('Output', fmtTokens(S.output), 'output') +
        metric('Fresh input', fmtTokens(S.fresh), 'fresh') +
      '</div>';
  }
  function renderPopup() {
    if (!popupEl) return;
    renderOverview(popupEl.querySelector('[data-overview]'));
    renderHistoryChart(popupEl.querySelector('[data-history]'));
    var totalsBox = popupEl.querySelector('[data-totals]');
    renderSessionFlow(totalsBox);
  }
  function positionPopup() {
    if (!popupEl || !popupAnchor) return;
    var r = popupAnchor.getBoundingClientRect();
    var vw = window.innerWidth;
    var margin = 8;
    // Clamp the rendered border-box, not just max-width. CSS uses
    // border-box too, so padding cannot push the popup outside the viewport.
    var safeWidth = Math.min(560, Math.max(220, vw - margin * 2));
    popupEl.style.width = safeWidth + 'px';
    popupEl.style.maxWidth = safeWidth + 'px';
    var w = popupEl.offsetWidth;
    var left = Math.round(r.left);
    if (left + w > vw - margin) left = vw - margin - w;
    if (left < margin) left = margin;
    popupEl.style.left = left + 'px';
    var vh = window.innerHeight;
    var h = popupEl.offsetHeight;
    var bottom = Math.round(vh - r.top + 6);
    var maxBottom = Math.max(margin, vh - h - margin);
    if (bottom > maxBottom) bottom = maxBottom;
    if (bottom < margin) bottom = margin;
    popupEl.style.bottom = bottom + 'px';
  }
  // Relative-time labels in the popup ("3s ago" / "2m ago") are the only
  // reason this UI ever needs sub-payload refresh. Keep the work local to
  // the popup lifecycle so the extension host does not re-broadcast on a
  // 1.5s tick just to nudge these spans. We update only `[data-ts]` text,
  // not the whole row, to avoid innerHTML churn.
  var popupTimer = null;
  function refreshRelTimes() {
    if (!popupEl) return;
    var nodes = popupEl.querySelectorAll('[data-ts]');
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute('data-ts');
      var next = fmtRelTime(iso);
      if (nodes[i].textContent !== next) nodes[i].textContent = next;
    }
  }
  function startPopupTimer() {
    if (popupTimer) return;
    popupTimer = setInterval(refreshRelTimes, 1000);
  }
  function stopPopupTimer() {
    if (!popupTimer) return;
    clearInterval(popupTimer);
    popupTimer = null;
  }
  function openPopup(anchor) {
    popupAnchor = anchor;
    if (!popupEl) {
      popupEl = buildPopup();
      document.body.appendChild(popupEl);
    }
    popupEl.classList.add('cceStatOpen');
    anchor.classList.add('cceBadgeActive');
    renderPopup();
    positionPopup();
    requestBadgeHistory();
    startPopupTimer();
  }
  function closePopup() {
    if (!popupEl) return;
    popupEl.classList.remove('cceStatOpen');
    if (popupAnchor) popupAnchor.classList.remove('cceBadgeActive');
    popupAnchor = null;
    stopPopupTimer();
  }
  function isOpen() {
    return !!(popupEl && popupEl.classList.contains('cceStatOpen'));
  }

  function ensureBadge() {
    var hosts = document.querySelectorAll(SEL.inputFooterHost);
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      if (!host) continue;
      var badge = host.querySelector(':scope > .' + BADGE_CLASS);
      if (!badge) {
        badge = document.createElement('button');
        badge.type = 'button';
        badge.className = BADGE_CLASS;
        badge.innerHTML = ICON_SVG + '<span class="' + TEXT_CLASS + '"></span>';
        badge.addEventListener('click', function(ev) {
          ev.stopPropagation();
          if (isOpen() && popupAnchor === ev.currentTarget) {
            closePopup();
          } else {
            openPopup(ev.currentTarget);
          }
        });
        host.insertBefore(badge, host.firstChild);
      }
      var textEl = badge.querySelector('.' + TEXT_CLASS);
      renderText(textEl);
    }
  }

  window.addEventListener('message', function(ev) {
    var d = ev && ev.data;
    if (!d || d.__cceBadge !== true || !d.payload) return;
    var hasFullHistory = Array.isArray(d.payload.history);
    latest = mergeRetainedHistory(d.payload);
    ensureBadge();
    if (isOpen()) {
      if (!hasFullHistory && !d.payload.empty && d.payload.totals) requestBadgeHistory();
      renderPopup();
      positionPopup();
    }
  });

  document.addEventListener('click', function(ev) {
    if (!isOpen()) return;
    var t = ev.target;
    if (popupEl && popupEl.contains(t)) return;
    if (popupAnchor && popupAnchor.contains(t)) return;
    closePopup();
  }, true);
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && isOpen()) closePopup();
  }, true);
  window.addEventListener('resize', function() { if (isOpen()) positionPopup(); });
  window.addEventListener('scroll', function() { if (isOpen()) positionPopup(); }, true);

  // `inputFooter` can remount under React, so keep a small observer to
  // reinsert the badge. The observer is coalesced to at most one
  // `ensureBadge` call per animation frame, and it ignores mutations that
  // cannot possibly touch the footer (no `inputFooter`-class node added).
  var ensureScheduled = false;
  function scheduleEnsureBadge() {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(function() { ensureScheduled = false; ensureBadge(); });
  }
  function mutationTouchesFooter(m) {
    for (var i = 0; i < m.addedNodes.length; i++) {
      var n = m.addedNodes[i];
      if (!n || n.nodeType !== 1) continue;
      var cls = typeof n.className === 'string' ? n.className : '';
      if (cls.indexOf('inputFooter') !== -1 || cls.indexOf('Footer') !== -1) return true;
      if (n.querySelector && n.querySelector('[class*="inputFooter"]')) return true;
    }
    return false;
  }

  var mo = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutationTouchesFooter(mutations[i])) { scheduleEnsureBadge(); return; }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  ensureBadge();
  setupBadgeIdentityBridge();
}


export function initFooterBadge() {
  setupCacheBadge();
  setupFooterAbbreviation();
  setupKbdSymbols();
}
