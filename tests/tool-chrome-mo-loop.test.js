'use strict';

/**
 * Regression contracts for the tool-use MutationObserver feedback loop that
 * froze Antigravity when opening a prior session full of Edit/Write tools.
 *
 * Failure mode (pre-fix):
 *   decorateToolUse → insert [data-incipit-write-diff] island rows / hljs spans
 *   → body childList MO sees inserts under toolUse_
 *   → enqueue same toolUse → decorateToolUse again → main-thread freeze on loading
 *
 * Guards that must stay in place:
 *   · write-diff / diff-island listed as owned chrome (+ closest subtree)
 *   · mutation target under owned chrome short-circuits the whole record
 *   · decorateToolUse is frame-budgeted (cannot process hundreds of islands
 *     in a single rAF while the loading spinner is up)
 *   · payload-sig equal path must not re-run highlightDiffIsland
 *   · typography settle ignore covers the same owned set
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const legacy = fs.readFileSync(path.join(root, 'data', 'enhance_legacy.js'), 'utf8');
const typography = fs.readFileSync(path.join(root, 'data', 'enhance_typography.js'), 'utf8');

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

function sliceBetween(src, startNeedle, endNeedle) {
  const a = src.indexOf(startNeedle);
  assert.ok(a >= 0, 'missing start: ' + startNeedle);
  const b = endNeedle ? src.indexOf(endNeedle, a + startNeedle.length) : src.length;
  assert.ok(b > a, 'missing end after ' + startNeedle);
  return src.slice(a, b);
}

(function ownedChromeCoversWriteDiff() {
  const block = sliceBetween(
    legacy,
    'const INCIPIT_TOOL_OWNED_SELECTOR',
    '// Local body observer is the primary path again',
  );
  for (const sel of [
    '[data-incipit-write-diff]',
    '[data-incipit-diff-island]',
    '[data-incipit-diff-header]',
    '[data-incipit-tool-icon]',
    '[data-incipit-tool-stats]',
    '[data-incipit-tool-grep-expansion]',
  ]) {
    assert.ok(block.includes(sel), 'owned selector missing ' + sel);
  }
  assert.ok(block.includes('INCIPIT_TOOL_OWNED_CLOSEST_SELECTOR'));
  assert.ok(
    block.includes('[data-incipit-write-diff]') &&
      block.includes('[data-incipit-diff-island]'),
    'closest set must cover write-diff / diff-island so hljs token spans are ignored',
  );
  ok('owned chrome lists write-diff + diff-island (+ closest)');
})();

(function mutationTargetShortCircuit() {
  assert.ok(
    legacy.includes('if (m.target && isIncipitOwnedToolChrome(m.target)) continue;'),
    'MO must skip records whose target is already under owned chrome',
  );
  // enqueue path must also refuse owned nodes (defense in depth for the
  // line-info redecorate caller and any future direct enqueue).
  const enqueue = sliceBetween(
    legacy,
    'function enqueueAffectedToolUses',
    'const INCIPIT_TOOL_OWNED_SELECTOR',
  );
  assert.ok(
    enqueue.includes('if (isIncipitOwnedToolChrome(node)) return false;'),
    'enqueueAffectedToolUses must refuse owned chrome nodes',
  );
  ok('MO target + enqueue refuse owned chrome');
})();

(function frameBudgetedDecorate() {
  const sched = sliceBetween(
    legacy,
    'function scheduleRescan()',
    'function enqueueAffectedToolUses',
  );
  assert.ok(legacy.includes('TOOL_DECORATE_FRAME_BUDGET_MS'));
  assert.ok(sched.includes('while (pendingToolUseRoots.size)'));
  assert.ok(
    !sched.includes('const tools = Array.from(pendingToolUseRoots)'),
    'must not drain the whole queue in one rAF (that froze long sessions)',
  );
  assert.ok(sched.includes('scheduleRescan()'), 'must re-arm when budget exhausted');
  ok('decorateToolUse is frame-budgeted');
})();

(function writeDiffSigSkipsHighlight() {
  const idx = legacy.indexOf('if (diff.__incipitWriteDiffSig === sig)');
  assert.ok(idx >= 0);
  const branch = legacy.slice(idx, idx + 500);
  assert.ok(branch.includes('return;'));
  assert.ok(
    !/\bhighlightDiffIsland\s*\(/.test(branch),
    'sig-equal path must not call highlightDiffIsland',
  );
  ok('write-diff sig-equal skips highlight');
})();

(function writeDiffDeferredUntilExpand() {
  // Click-to-draw only: collapsed (session open / scroll-in) must not
  // fill/highlight/LCS/IPC, and must NOT idle-warm islands on viewport entry
  // (that reopened host IN/OUT bodies while scrolling history).
  const body = sliceBetween(
    legacy,
    'function ensureWriteDiffBody',
    'function refreshToolStatsSpans',
  );
  assert.ok(body.includes("el.dataset.incipitToolCollapsed === 'false'"));
  assert.ok(body.includes('incipitWriteDiffDeferred'));
  assert.ok(body.includes('options.force === true') || body.includes('options.force'));
  const collapsedBranch = body.slice(
    body.indexOf('if (!isExpanded && !force)') >= 0
      ? body.indexOf('if (!isExpanded && !force)')
      : body.indexOf('if (!isExpanded)'),
    body.indexOf('let diff = body.querySelector'),
  );
  assert.ok(collapsedBranch.length > 20, 'collapsed branch present');
  assert.ok(
    !collapsedBranch.includes('fillWriteDiffBody'),
    'collapsed branch must not fill rows',
  );
  assert.ok(
    !collapsedBranch.includes('highlightDiffIsland'),
    'collapsed branch must not highlight',
  );
  assert.ok(
    !collapsedBranch.includes('ensureDiffLineInfo'),
    'collapsed branch must not postMessage line-info',
  );
  assert.ok(
    !collapsedBranch.includes('buildIncipitDiffRows'),
    'collapsed branch must not build LCS rows',
  );
  assert.ok(
    !collapsedBranch.includes('ensureWriteDiffPreviewControls'),
    'collapsed branch must not run preview controls (those used to LCS)',
  );
  assert.ok(legacy.includes('function materializeWriteDiffForTool'));
  assert.ok(legacy.includes('materializeWriteDiffForTool(el'));
  assert.ok(legacy.includes('function cheapToolStats'));
  assert.ok(legacy.includes('function estimateWriteDiffClipped'));
  assert.ok(
    legacy.includes('cheapToolStats(data.block)'),
    'decorateToolUse must use cheap stats while collapsed',
  );
  assert.ok(
    !/function ensureWriteDiffPreviewControls[\s\S]*?buildIncipitDiffRows\(payload\)\.length/.test(
      legacy,
    ),
    'preview controls must not LCS via buildIncipitDiffRows',
  );
  // No scroll-warm: idle materialise path must be disabled.
  assert.ok(
    legacy.includes('Intentionally no IntersectionObserver / idle materialise') ||
      legacy.includes('No-op: scroll must not build islands'),
    'write-diff must not warm on viewport entry',
  );
  assert.ok(
    !legacy.includes('keepCollapsed: true'),
    'must not keepCollapsed warm path on scroll/idle',
  );
  assert.ok(
    legacy.includes('keepCollapsed: false') ||
      legacy.includes('materializeWriteDiffForTool(el, { keepCollapsed: false })'),
    'click path expands immediately (keepCollapsed:false)',
  );
  // decorateToolUse: collapse first; skip IN/OUT truncation while collapsed.
  const deco = sliceBetween(
    legacy,
    'function decorateToolUse(el)',
    'function computeStatsCached',
  );
  assert.ok(
    deco.includes('snapInitialCollapse(el)'),
    'must collapse before body work on first decorate',
  );
  assert.ok(
    deco.includes('stayCollapsed') && deco.includes('applyToolBodyTruncation'),
    'IN/OUT truncation gated by stayCollapsed',
  );
  ok('write-diff progressive: collapsed zero-LCS; no scroll warm; click draws');
})();

(function writeDiffPreviewControlsIdempotent() {
  const body = sliceBetween(
    legacy,
    'function ensureWriteDiffPreviewControls',
    'function ensureWriteDiffBody',
  );
  assert.ok(
    body.includes("getPropertyValue('--incipit-write-diff-preview-max-height')"),
    'must not unconditional setProperty every redecorate',
  );
  assert.ok(
    body.includes("diff.dataset.incipitWriteDiffClipped !== '1'") ||
      body.includes('incipitWriteDiffClipped !== \'1\''),
    'clipped dataset only written when changing',
  );
  ok('write-diff preview controls are style/dataset idempotent');
})();

(function typographyIgnoreAligned() {
  const block = sliceBetween(
    typography,
    'const TRANSCRIPT_ACTION_MUTATION_IGNORED_SELECTOR',
    'function isDiffSurfaceNode',
  );
  for (const sel of [
    '[data-incipit-write-diff]',
    '[data-incipit-diff-island]',
    '[data-incipit-tool-icon]',
    '[data-incipit-tool-stats]',
    '[data-incipit-protocol-card]',
    '[data-incipit-change-review-turn]',
  ]) {
    assert.ok(block.includes(sel), 'typography ignore missing ' + sel);
  }
  ok('typography settle ignore aligned with tool owned chrome');
})();

(function hljsAlreadyTokenizedShortCircuit() {
  assert.ok(typography.includes('Already tokenized: only ensure char-range markup'));
  assert.ok(
    typography.includes("block.classList.add('hljs')"),
    'must stamp .hljs even if highlightElement throws',
  );
  ok('diff-island hljs short-circuits when already tokenized');
})();

(function viewportSeededToolDecorate() {
  assert.ok(legacy.includes('function toolUseNearViewport'));
  assert.ok(legacy.includes('function observeToolUseForLaterDecorate'));
  assert.ok(legacy.includes('function enqueueToolUseForDecorate'));
  assert.ok(legacy.includes('TOOL_SEED_TAIL_COUNT'));
  assert.ok(legacy.includes('ensureToolUseViewportObserver'));
  assert.ok(
    legacy.includes('TOOL_VIEWPORT_MARGIN_PX = 120') ||
      legacy.includes('const TOOL_VIEWPORT_MARGIN_PX = 120'),
    'tool viewport pre-decorate margin must stay tight (was 900px → scroll lag)',
  );
  assert.ok(
    legacy.includes('function stampToolCollapsedDefault') ||
      legacy.includes('stampToolCollapsedDefault(el)'),
    'undecoated tools must be CSS-collapsed before decorate',
  );
  // Pre-layout 0×0 must NOT count as near (that re-opened full decorate).
  const nearFn = sliceBetween(
    legacy,
    'function toolUseNearViewport',
    'function ensureToolUseViewportObserver',
  );
  assert.ok(
    nearFn.includes('return false') &&
      (nearFn.includes('width <= 0') || nearFn.includes('height <= 0')),
    'empty layout must not force-decorate every tool',
  );
  // Seed path must not blindly add every toolUse_ on session open.
  const seed = sliceBetween(
    legacy,
    'const initialRoot = document.querySelector(SEL.messagesContainer)',
    'function flushDeferredCodeHighlightsIfReady',
  );
  assert.ok(seed.includes('observeToolUseForLaterDecorate'));
  assert.ok(seed.includes('toolUseNearViewport') || seed.includes('tailStart'));
  assert.ok(legacy.includes('function setupTranscriptPinToBottom'));
  assert.ok(legacy.includes('scheduleTranscriptPinToBottom'));
  assert.ok(legacy.includes('setupTranscriptPinToBottom()'));
  assert.ok(legacy.includes('observeUserBubbleForLaterDecorate'));
  assert.ok(legacy.includes('function observeUserBubbleForLaterDecorate'));
  ok('session open: pin-to-bottom + viewport/tail tool decorate seed');
})();

console.log('\ntool-chrome-mo-loop: ' + passed + ' checks PASSED');
