'use strict';

// Contract tests for mermaid diagram rendering.
//
// These lock the load-bearing safety decisions (see .sisyphus/memo.md
// 2026-06-01 mermaid entry): never render/scan on a streaming hot path,
// silent fallback to the code block, assistant-scope only, no JS interactivity
// from model output, and the host-version-resilient pieces (install whitelist,
// hljs bypass, oversize pre-check).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const installSrc = read('src/install.js');
const typo = read('data/enhance_typography.js');
const render = read('data/mermaid_render.js');
const css = read('data/theme.css');
const warmWhiteCss = read('data/warm-white-override.css');

function sliceFn(src, header) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, 'expected function: ' + header);
  const rest = src.slice(start + header.length);
  const next = rest.indexOf('\nfunction ');
  return rest.slice(0, next === -1 ? rest.length : next);
}

// ---- vendored library + install wiring -------------------------------------

(function vendoredLibraryShips() {
  const lib = path.join(ROOT, 'data', 'mermaid', 'mermaid.min.js');
  assert.ok(fs.existsSync(lib), 'data/mermaid/mermaid.min.js must be vendored');
  assert.ok(fs.statSync(lib).size > 1_000_000, 'mermaid bundle looks truncated');
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'mermaid', 'LICENSE')),
    'mermaid LICENSE must ship for redistribution');

  // Without the whitelist entry the vendored file never reaches the webview.
  const m = installSrc.match(/const LOCAL_ASSET_TREES = \[([^\]]*)\]/);
  assert.ok(m, 'LOCAL_ASSET_TREES not found');
  assert.ok(/['"]mermaid['"]/.test(m[1]), "LOCAL_ASSET_TREES must include 'mermaid'");

  // The runtime scanner is a root-level ES module imported by
  // enhance_typography.js. Shipping only the vendored mermaid/ asset subtree
  // leaves the module graph broken in the real webview.
  assert.ok(/path\.join\('data',\s*'mermaid_render\.js'\),\s*'mermaid_render\.js'/.test(installSrc),
    'ROOT_WEBVIEW_FILES must copy mermaid_render.js beside enhance_typography.js');
})();

// ---- loader: strict security, no error diagram, normalized global ----------

(function loaderIsHardened() {
  assert.ok(/mermaid\(\)\s*{/.test(typo), 'assets.mermaid() loader missing');
  assert.ok(/securityLevel:\s*'strict'/.test(typo), "mermaid must init securityLevel:'strict'");
  assert.ok(/suppressErrorRendering:\s*true/.test(typo),
    'suppressErrorRendering must be true so mermaid never draws its own error diagram');
  assert.ok(/startOnLoad:\s*false/.test(typo), 'startOnLoad must be false (no auto-scan)');
  assert.ok(/theme:\s*'base'/.test(typo), 'mermaid must use the explicit base theme');
  assert.ok(/themeVariables:\s*mermaidThemeVariables\(\)/.test(typo),
    'mermaid must receive incipit palette theme variables');
  assert.ok(/edgeLabelBackground/.test(typo) && /primaryTextColor/.test(typo),
    'mermaid theme variables must cover label backgrounds and text colour');
  assert.ok(/classText/.test(typo) && /stateLabelColor/.test(typo) && /branchLabelColor/.test(typo),
    'mermaid theme variables must cover class/state/git labels');
  assert.ok(/cScale0/.test(typo) && /cScale9/.test(typo) && /pie0/.test(typo) && /pie11/.test(typo),
    'mermaid theme variables must provide the muted incipit series palette');
  assert.ok(/__esbuild_esm_mermaid_nm/.test(typo), 'must normalize the esbuild namespace global');
})();

// ---- streaming safety: never on the mutation/render hot path ---------------

(function neverScansInStreamHotPath() {
  // handleMutations is the per-mutation streaming hot path. It must not touch
  // mermaid at all — scanning/rendering only happens in deferred idle tasks.
  const fn = sliceFn(typo, 'function handleMutations(');
  assert.ok(!/mermaid/i.test(fn),
    'handleMutations must not reference mermaid (would re-enter the stream hot path)');

  // The scan must bail while busy; the heavy work is behind scheduleIdleTask.
  const scan = sliceFn(typo, 'function runMermaidScan(');
  assert.ok(/if\s*\(conversationIsBusy\(\)\)\s*return/.test(scan),
    'runMermaidScan must bail while streaming (busy)');
  assert.ok(/scheduleIdleTask\(\s*'typography\.mermaidScan'/.test(typo),
    'mermaid scan must be an idle task, never inline');

  // Primary trigger is the quietest signal: assistant turn finalized.
  assert.ok(/subscribe\('assistantTurnFinalized',\s*\(\)\s*=>\s*scheduleMermaidScan/.test(typo),
    'mermaid must render on assistantTurnFinalized');
})();

(function hljsSkipsMermaid() {
  // hljs must never tokenize a mermaid source block. Mirrors the language-latex
  // bypass at all four highlight entry points.
  const count = (typo.match(/language-mermaid/g) || []).length;
  assert.ok(count >= 4, 'expected language-mermaid bypass at all hljs entry points, found ' + count);
})();

// ---- render module: scope, container, fallback, no interactivity -----------

(function scopeIsAssistantBodyOnly() {
  assert.ok(/SEL\.markdownRoot/.test(render), 'must require assistant markdown root');
  for (const k of ['userBubble', 'toolUse', 'toolBody', 'thinking']) {
    assert.ok(render.includes('SEL.' + k), 'scope guard must exclude SEL.' + k);
  }
  assert.ok(/isContentEditable/.test(render), 'scope guard must exclude contenteditable');
})();

(function rendersIntoOffscreenContainerNotBody() {
  assert.ok(/\.render\(\s*id\s*,\s*source\s*,\s*ensureSandbox\(\)\s*\)/.test(render),
    'mermaid.render must receive a dedicated offscreen container as 3rd arg');
  const sandbox = sliceFn(render, 'function ensureSandbox(');
  assert.ok(/visibility:hidden/.test(sandbox), 'sandbox must be visibility:hidden');
  assert.ok(!/display:\s*none/.test(sandbox),
    'sandbox must NOT be display:none (getBBox would return 0)');
  assert.ok(/min-height:1px/.test(sandbox) && /height:auto/.test(sandbox),
    'sandbox must stay measurable, not collapse to a zero-height box');
  assert.ok(/overflow:visible/.test(sandbox),
    'sandbox must not clip foreignObject label measurement');
  assert.ok(!/height:0/.test(sandbox) && !/overflow:hidden/.test(sandbox),
    'sandbox must never be height:0 + overflow:hidden (clips HTML labels)');
  assert.ok(!/contain:[^;]*paint/.test(sandbox),
    'sandbox must not use paint containment that can clip offscreen labels');
})();

(function noJsInteractivityFromModelOutput() {
  // bindFunctions wires click/JS handlers — never call it.
  assert.ok(!/bindFunctions\s*\(/.test(render),
    'must never call bindFunctions (no JS/click channel from model output)');
})();

(function oversizePreCheckFallsBackWithoutMermaid() {
  assert.ok(/MAX_SOURCE_CHARS/.test(render) && /MAX_SOURCE_LINES/.test(render),
    'must have explicit oversize bounds');
  // The oversize branch must fall back, not call render (mermaid would draw its
  // own "Maximum text size exceeded" diagram, violating silent fallback).
  assert.ok(/MAX_SOURCE_CHARS\)\s*{\s*fallbackBlock\(b\);\s*return/.test(render),
    'oversize source must fallback before calling mermaid');
})();

(function failureKeepsCodeBlockSuccessHidesIt() {
  const fb = sliceFn(render, 'function fallbackBlock(');
  assert.ok(/remove\(SOURCE_HIDDEN_CLASS\)/.test(fb), 'fallback must keep <pre> visible');
  assert.ok(/data-mermaid-error/.test(fb), 'fallback must mark the error');
  // success path hides the source pre
  assert.ok(/classList\.add\(SOURCE_HIDDEN_CLASS\)/.test(render),
    'success must hide the source <pre>');
})();

(function markersCarrySourceHashForReRender() {
  // done = hash, errored = 'e'+hash, in-flight = 'p'+hash — so an edited source
  // (new hash) or a React-wiped figure re-renders instead of sticking forever.
  assert.ok(/'e'\s*\+\s*b\.hash/.test(render), 'error marker must carry source hash');
  assert.ok(/'p'\s*\+\s*b\.hash/.test(render), 'in-flight marker must carry source hash');
})();

// ---- css -------------------------------------------------------------------

(function cssHidesSourceAndScrollsWideDiagrams() {
  assert.ok(/pre\.incipit-mermaid-source\s*{[^}]*display:\s*none/.test(css),
    'hidden source <pre> rule missing');
  assert.ok(/\.claude-mermaid\s*{[^}]*overflow-x:\s*auto/.test(css),
    'wide diagrams must scroll horizontally, not stretch the column');
  assert.ok(/\.claude-mermaid svg text,\s*\.claude-mermaid svg tspan\s*{[^}]*fill:\s*var\(--incipit-mermaid-text\)\s*!important/.test(css),
    'mermaid SVG text must be forced to the incipit palette text colour');
  assert.ok(/\.claude-mermaid svg \.edgeLabel \.labelBkg,[^}]*fill:\s*var\(--incipit-mermaid-label-bg\)\s*!important/s.test(css),
    'mermaid edge-label backgrounds must be restyled to the incipit palette');
  assert.ok(/\.claude-mermaid svg \.sequenceNumber,[^}]*fill:\s*var\(--incipit-mermaid-inverse-text\)\s*!important/s.test(css),
    'mermaid sequence number labels must keep inverse contrast');
  assert.ok(/\.claude-mermaid svg \.taskText/.test(css) &&
      /\.claude-mermaid svg \.pieTitleText/.test(css) &&
      /\.claude-mermaid svg \.classText/.test(css),
    'mermaid cross-diagram text classes must inherit the incipit palette');
  assert.ok(/--incipit-mermaid-surface:\s*#2d2a26/.test(css) &&
      /--incipit-mermaid-accent:\s*#d97757/.test(css) &&
      /--incipit-mermaid-line:\s*#b8aea2/.test(css),
    'warm-black mermaid diagram tokens must use the incipit surface/accent/line palette');
  assert.ok(/--incipit-mermaid-surface:\s*#fffaf0/.test(warmWhiteCss) &&
      /--incipit-mermaid-accent:\s*#bf5d3a/.test(warmWhiteCss) &&
      /--incipit-mermaid-line:\s*#746d64/.test(warmWhiteCss),
    'warm-white mermaid diagram tokens must mirror the incipit paper palette');
  // Borderless: node shapes drop their outline (no boxed UI), and the rule must
  // NOT force a blanket fill — that would crush a model's own classDef colours.
  // Default fill comes from themeVariables; uncoloured groups from colorizeGroups.
  const nodeRule = (css.match(/\.claude-mermaid svg \.node rect,[^}]*}/s) || [''])[0];
  assert.ok(/stroke:\s*none\s*!important/.test(nodeRule),
    'mermaid nodes must be borderless (stroke: none)');
  assert.ok(!/fill:/.test(nodeRule),
    'mermaid node rule must not force a fill (model colours must survive)');
  assert.ok(/\.claude-mermaid svg \.edgePath \.path,[^}]*stroke:\s*var\(--incipit-mermaid-line\)\s*!important/s.test(css),
    'mermaid edges must use the warm neutral line token');
  assert.ok(/\.claude-mermaid svg \.note,[^}]*fill:\s*var\(--incipit-mermaid-accent-soft\)\s*!important/s.test(css),
    'mermaid semantic notes/active states must get the restrained terra accent');
  assert.ok(/\.claude-mermaid svg foreignObject\s*{[^}]*overflow:\s*visible\s*!important/s.test(css),
    'mermaid foreignObject labels must not be clipped');
  const foreignParagraphBlocks = Array.from(
    css.matchAll(/\.claude-mermaid svg foreignObject p\s*{([^}]*)}/g),
    m => m[1]
  );
  assert.ok(foreignParagraphBlocks.length, 'mermaid foreignObject paragraph reset missing');
  assert.ok(foreignParagraphBlocks.some(block =>
      /margin:\s*0\s*!important/.test(block) &&
      /line-height:\s*1\.5\s*!important/.test(block) &&
      /white-space:\s*nowrap\s*!important/.test(block)),
    'mermaid foreignObject paragraphs must not inherit markdown paragraph layout');
})();

// ---- borderless + literary colour policy -----------------------------------

(function borderlessLiteraryColourPolicy() {
  // Shared literary palette, seeded by the user's three hues and extended so a
  // diagram with many groups still reads. Single source — enhance_typography
  // imports it to drive pie/cScale categorical diagrams from the same system.
  assert.ok(/export const MERMAID_GROUP_PALETTE = \[/.test(render),
    'mermaid_render must export the shared literary group palette');
  for (const seed of ['#498273', '#b05545', '#c9a657']) {
    assert.ok(render.includes(seed), 'group palette must include literary seed ' + seed);
  }
  const palette = (render.match(/MERMAID_GROUP_PALETTE = \[([\s\S]*?)\]/) || [])[1] || '';
  const count = (palette.match(/#[0-9a-fA-F]{6}/g) || []).length;
  assert.ok(count >= 10, 'group palette must carry enough colours for many groups, found ' + count);
  assert.ok(/MERMAID_GROUP_PALETTE/.test(typo),
    'enhance_typography must drive pie/cScale from the shared palette, not a private copy');

  // Respect the model's own colours: only classDef groups that set NO colour get
  // auto-painted; explicitly coloured classes are left untouched.
  assert.ok(/function uncoloredGroupClasses\(/.test(render) &&
      /function colorizeGroups\(/.test(render),
    'mermaid_render must have the source-driven group colouring pass');
  assert.ok(/classDef/.test(render) && /fill\|color\|background/.test(render),
    'colorize pass must skip classDef declarations that already set a colour');
  // Auto-assigned fills must carry a contrast-chosen text colour (ivory or ink).
  assert.ok(/function bestTextOn\(/.test(render),
    'auto-group fills must pick a contrasting text colour for legibility');

  // Smaller diagrams: theme variables shrink the base font below body copy.
  assert.ok(/fontSize:\s*'12px'/.test(typo),
    'mermaid theme variables must shrink the diagram font');
})();

console.log('mermaid render contract tests passed');
