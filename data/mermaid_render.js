import { SEL } from './host_probe.js';
import { warn } from './enhance_shared.js';

/**
 * Mermaid diagram rendering for assistant markdown.
 *
 * Design constraints (see .sisyphus/memo.md, 2026-06-01 mermaid entry):
 *  - NEVER render or scan during streaming. mermaid is heavier than hljs;
 *    the only safe signal is assistant-turn-finalized / busy=false quiet.
 *    The closure signal is `<pre><code class="language-mermaid">` becoming a
 *    settled DOM node — we never parse the growing markdown text to detect a
 *    closing fence (that would re-introduce the streaming DOM hot path this
 *    project spent 2026-04~05 removing).
 *  - Render failure is SILENT: the original `<pre>` code block stays visible
 *    as the fallback. We never let mermaid draw its built-in error diagram
 *    (`suppressErrorRendering` + our own oversize pre-check guard that).
 *  - Assistant body only. User bubbles, tool output, thinking, contenteditable
 *    are out of scope.
 *  - mermaid.render() gets a dedicated offscreen container so it does not park
 *    its measurement node on document.body and cause a visible reflow.
 *  - Markers carry a source hash so a React remount / virtualization sweep /
 *    edited source re-renders idempotently instead of sticking forever.
 */

const PROCESSED_ATTR = 'data-incipit-mermaid';
const FIGURE_CLASS = 'claude-mermaid';
const FIGURE_ATTR = 'data-incipit-mermaid-figure';
const SOURCE_HIDDEN_CLASS = 'incipit-mermaid-source';
const SANDBOX_ATTR = 'data-incipit-mermaid-sandbox';

// Pre-check bounds. Above these we fall back to the code block instead of
// calling mermaid. mermaid's own `maxTextSize` does NOT throw cleanly — it
// swaps the source for a built-in "Maximum text size exceeded" diagram, which
// would violate our silent-code-fallback contract.
const MAX_SOURCE_CHARS = 20000;
const MAX_SOURCE_LINES = 600;

// Literary group palette. Seeded by the three hues the user chose
// (#498273 teal / #b05545 terracotta / #c9a657 gold) and extended in the same
// muted, mid-tone register so a diagram with many groups still reads. Shared
// with enhance_typography.js: the same palette drives pie/timeline/cScale
// categorical diagrams, so the whole diagram system is one colour language.
export const MERMAID_GROUP_PALETTE = [
  '#498273', '#b05545', '#c9a657', '#5f7488', '#8d6f83', '#6f8b65',
  '#a5654e', '#7d668f', '#5d8278', '#9a6a45', '#6d7f91', '#80825a',
];

const GROUP_TEXT_IVORY = '#f8f8f6';
const GROUP_TEXT_INK = '#1f1f1e';

let idCounter = 0;
let sandbox = null;

// WCAG relative luminance, then pick ivory or ink for the best contrast on a
// given fill — so an auto-assigned group colour always carries legible text
// regardless of palette brightness (gold needs ink, teal needs ivory).
function bestTextOn(hex) {
  const c = String(hex || '').replace('#', '');
  if (c.length < 6) return GROUP_TEXT_IVORY;
  const lin = i => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  const cIvory = (0.93 + 0.05) / (L + 0.05);
  const cInk = (L + 0.05) / (0.012 + 0.05);
  return cIvory >= cInk ? GROUP_TEXT_IVORY : GROUP_TEXT_INK;
}

// Parse `classDef <names> <styles>` and return the class names that declared
// NO colour (no fill/color/background). Those are groups the model defined but
// left uncoloured — we colour them from the literary palette. Classes that DID
// set a colour are absent here, so the model's own palette is respected
// verbatim (we never touch a node the model explicitly coloured).
function uncoloredGroupClasses(source) {
  const out = [];
  const seen = new Set();
  if (!source) return out;
  const re = /(?:^|\n)\s*classDef\s+([A-Za-z0-9_,\s-]+?)\s+([^\n]+)/g;
  let m;
  while ((m = re.exec(source))) {
    if (/\b(?:fill|color|background)\s*:/i.test(m[2] || '')) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
  }
  return out;
}

// Post-render: colour grouped-but-uncoloured nodes from the literary palette.
// Fail-safe — any structural surprise in the rendered SVG just leaves the
// borderless default treatment, never throws into the render path.
function colorizeGroups(fig, source) {
  let groups;
  try { groups = uncoloredGroupClasses(source); } catch (_) { return; }
  if (!groups.length) return;
  const colorFor = new Map();
  groups.forEach((name, i) =>
    colorFor.set(name, MERMAID_GROUP_PALETTE[i % MERMAID_GROUP_PALETTE.length]));
  let nodes;
  try { nodes = fig.querySelectorAll('.node'); } catch (_) { return; }
  for (const node of nodes) {
    if (!node.classList) continue;
    let fill = null;
    for (const name of groups) {
      if (node.classList.contains(name)) { fill = colorFor.get(name); break; }
    }
    if (!fill) continue;
    const text = bestTextOn(fill);
    try {
      node.querySelectorAll('rect,circle,ellipse,polygon,path').forEach(s =>
        s.style.setProperty('fill', fill, 'important'));
      node.querySelectorAll('.nodeLabel, text, tspan, foreignObject div, foreignObject span, foreignObject p')
        .forEach(l => {
          l.style.setProperty('color', text, 'important');
          l.style.setProperty('fill', text, 'important');
        });
    } catch (_) {}
  }
}

// 32-bit FNV-1a — identifies a block's exact source so we can detect edits and
// distinguish done/errored/in-flight per source revision.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function ensureSandbox() {
  if (sandbox && sandbox.isConnected) return sandbox;
  const el = document.createElement('div');
  el.setAttribute(SANDBOX_ATTR, '');
  // Offscreen but laid out: mermaid measures text with getBBox/
  // getComputedTextLength, which collapse to 0 for an unrendered element.
  // Keep it rendered but parked far offscreen and inert. It must not be a
  // zero-height clipped box: flowchart HTML labels use getBoundingClientRect()
  // inside foreignObject, and clipping the measurement parent can produce
  // vertically sliced labels in the final SVG.
  el.style.cssText =
    'position:fixed;left:-10000px;top:0;width:900px;min-height:1px;height:auto;' +
    'overflow:visible;visibility:hidden;pointer-events:none;contain:layout style;';
  (document.body || document.documentElement).appendChild(el);
  sandbox = el;
  return el;
}

export function mermaidBlockEligible(code) {
  if (!code || !code.classList || !code.closest) return false;
  if (!code.classList.contains('language-mermaid')) return false;
  if (code.isContentEditable) return false;
  // Assistant markdown body only.
  if (!code.closest(SEL.markdownRoot)) return false;
  if (code.closest(
        `${SEL.userBubble}, ${SEL.userMessageContainer}, ${SEL.userContent}, ` +
        `${SEL.toolUse}, ${SEL.toolBody}, ${SEL.thinking}`)) {
    return false;
  }
  return true;
}

function figureAfter(pre) {
  const next = pre && pre.nextElementSibling;
  if (next && next.classList && next.classList.contains(FIGURE_CLASS)) return next;
  return null;
}

// Pure read: returns the blocks that need (re)rendering. No DOM mutation here
// so the streaming-gate scan that runs before the heavy library loads stays
// side-effect free.
export function collectMermaidBlocks(root) {
  if (!root || !root.querySelectorAll) return [];
  const out = [];
  let candidates;
  try { candidates = root.querySelectorAll('code.language-mermaid'); }
  catch (_) { return out; }
  for (const code of candidates) {
    if (!mermaidBlockEligible(code)) continue;
    const pre = code.closest('pre');
    if (!pre) continue;
    const source = code.textContent || '';
    const hash = fnv1a(source);
    const marked = code.getAttribute(PROCESSED_ATTR) || '';
    if (marked === 'p' + hash) continue;             // in flight for this source
    if (marked === 'e' + hash) continue;             // failed for this source — do not retry
    const fig = figureAfter(pre);
    if (marked === hash && fig && fig.isConnected) continue;  // done and figure intact
    out.push({ code, pre, source, hash, staleFig: fig || null });
  }
  return out;
}

function fallbackBlock(b) {
  // Leave the <pre> visible: that IS the code-block fallback. Mark errored for
  // this exact source so we never retry it; an edited source changes the hash
  // and becomes eligible again.
  if (b.pre && b.pre.classList) b.pre.classList.remove(SOURCE_HIDDEN_CLASS);
  if (b.pre && b.pre.setAttribute) b.pre.setAttribute('data-mermaid-error', '1');
  try { b.code.setAttribute(PROCESSED_ATTR, 'e' + b.hash); } catch (_) {}
}

async function renderOne(mermaid, b) {
  const { code, pre, source, hash } = b;
  // Oversize pre-check — fall back before touching mermaid (see MAX_* above).
  if (source.length > MAX_SOURCE_CHARS) { fallbackBlock(b); return false; }
  let lines = 0;
  for (let i = 0; i < source.length; i++) { if (source.charCodeAt(i) === 10) lines++; }
  if (lines > MAX_SOURCE_LINES) { fallbackBlock(b); return false; }

  const id = 'incipit-mermaid-' + (++idCounter) + '-' + hash;
  let svg = null;
  try {
    const res = await mermaid.render(id, source, ensureSandbox());
    svg = res && res.svg;
    // Deliberately ignore res.bindFunctions: incipit renders diagrams as static
    // reading content and never wires `click`/JS interactivity from model output.
  } catch (_) {
    fallbackBlock(b);
    return false;
  }
  if (!svg) { fallbackBlock(b); return false; }

  // Re-validate after the async hop: the node may have been detached, or its
  // source edited, while we were rendering.
  if (!code.isConnected || !pre.isConnected) {
    try { code.removeAttribute(PROCESSED_ATTR); } catch (_) {}
    return false;
  }
  if (fnv1a(code.textContent || '') !== hash) {
    try { code.removeAttribute(PROCESSED_ATTR); } catch (_) {}
    return false;
  }

  const fig = document.createElement('div');
  fig.className = FIGURE_CLASS;
  fig.setAttribute(FIGURE_ATTR, '');
  fig.innerHTML = svg;  // strict-sanitized SVG from mermaid (securityLevel:'strict')
  // Respect the model's own colours; auto-colour only the groups it left bare.
  colorizeGroups(fig, source);
  if (pre.parentNode) pre.parentNode.insertBefore(fig, pre.nextSibling);
  pre.classList.add(SOURCE_HIDDEN_CLASS);
  pre.removeAttribute('data-mermaid-error');
  code.setAttribute(PROCESSED_ATTR, hash);
  return true;
}

/**
 * Render every eligible mermaid block under `root`. Caller guarantees we are
 * not streaming (busy=false). `opts.isBusy` lets us bail mid-batch if a new
 * turn starts, so a fresh stream never races with our DOM commits.
 */
export async function renderMermaidIn(mermaid, root, opts = {}) {
  const isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : () => false;
  const blocks = collectMermaidBlocks(root);
  if (!blocks.length) return 0;

  // Claim synchronously so a concurrent flush pass won't re-collect these.
  for (const b of blocks) {
    if (b.staleFig) { try { b.staleFig.remove(); } catch (_) {} }
    if (b.pre.classList) b.pre.classList.remove(SOURCE_HIDDEN_CLASS);
    try { b.code.setAttribute(PROCESSED_ATTR, 'p' + b.hash); } catch (_) {}
  }

  let done = 0;
  for (const b of blocks) {
    if (isBusy()) {
      // A new turn started: release the claim so a later settle re-renders it,
      // and stop committing into a now-live transcript.
      try { b.code.removeAttribute(PROCESSED_ATTR); } catch (_) {}
      continue;
    }
    try { if (await renderOne(mermaid, b)) done++; }
    catch (e) { warn('mermaid render failed:', e && e.message); fallbackBlock(b); }
  }
  return done;
}

export function hasUnrenderedMermaid(root) {
  return collectMermaidBlocks(root).length > 0;
}
