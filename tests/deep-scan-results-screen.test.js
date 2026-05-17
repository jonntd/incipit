'use strict';

// Regression coverage for the deep-scan RESULTS screen contract
// (src/frontispiece.js renderDeepScanResults), born from a real-machine
// report: with 19 results the down-arrow walked off the list into the
// "Add selected" button and not every result was reachable — list-scroll
// and action-pick were fighting for one shared cursor axis.
//
// The fix: the actions are a FIXED keyboard legend, never cursor rows.
// Invariant asserted here (turns red if anyone re-merges them):
//   · the screen emits EXACTLY ONE cursor glyph '›', and it is on the
//     focused RESULT row — never on the action legend
//   · every action-legend line is cursor-free
//   · only the windowed slice it is handed is rendered (paging reaches
//     any result); the range text is shown
//   · the empty branch still renders without a cursor or legend

const assert = require('assert');
const {
  renderDeepScanResults, captureScreenRender, color, Ansi,
} = require('../src/frontispiece');
const { t, setLocale } = require('../src/i18n');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const CURSOR = '›'; // '›' — emitted only by cursorIndent()

// Build the exact options menu.js feeds renderDeepScanResults: a windowed
// slice of result rows (one focused) + the action legend string.
function screen({ count = 19, pageStart = 8, page = 4, focusOffset = 1, locale = 'en' } = {}) {
  setLocale(locale);
  const end = Math.min(pageStart + page, count);
  const visibleRows = [];
  for (let i = pageStart; i < end; i++) {
    visibleRows.push({
      label: 'VS Code',
      path: `/home/u/p${i}/.vscode/extensions`,
      version: '2.1.143',
      checked: true,
      focused: i === pageStart + focusOffset,
    });
  }
  return captureScreenRender(() => renderDeepScanResults({
    version: '0.1.15',
    heading: t('target.scan.results_heading'),
    rangeText: t('target.scan.results_summary', { count, from: pageStart + 1, to: end }),
    visibleRows,
    actionLegend: t('target.scan.results_actions', { n: count }),
    hint: t('target.scan.results_hint'),
    emptyText: t('target.scan.none_found'),
  }));
}

(function run() {
  // ---- exactly one cursor, on the focused result row ----
  for (const locale of ['en', 'zh']) {
    const text = strip(screen({ locale }).text);
    const cursorCount = (text.match(new RegExp(CURSOR, 'g')) || []).length;
    assert.strictEqual(cursorCount, 1, `[${locale}] exactly one cursor on the screen`);
    const cursorLine = text.split('\n').find(l => l.includes(CURSOR));
    assert.ok(cursorLine && cursorLine.includes('VS Code'),
      `[${locale}] the cursor sits on a result row`);
    ok(`[${locale}] single cursor, and it is on a result row`);
  }

  // ---- the action legend is entirely cursor-free ----
  for (const locale of ['en', 'zh']) {
    const lines = strip(screen({ locale }).text).split('\n');
    // Legend tokens identical across locales.
    for (const token of ['[↵]', '[a]', '[n]', '[Esc]']) {
      const legendLine = lines.find(l => l.includes(token));
      assert.ok(legendLine, `[${locale}] legend shows ${token}`);
      assert.ok(!legendLine.includes(CURSOR),
        `[${locale}] legend line for ${token} must never carry the cursor`);
    }
    ok(`[${locale}] action legend present and cursor-free`);
  }

  // ---- only the handed window is rendered (every result reachable) ----
  (() => {
    const text = strip(screen({ count: 19, pageStart: 8, page: 4 }).text);
    assert.ok(text.includes('/p8/') && text.includes('/p11/'),
      'in-window rows are shown');
    assert.ok(!text.includes('/p0/') && !text.includes('/p18/'),
      'out-of-window rows are NOT shown (windowed paging)');
    assert.ok(text.includes('9') && text.includes('19'),
      'range text reflects the window (9–12 of 19)');
    ok('renders only the windowed slice; range text shown');
  })();

  // ---- no redundant '─' divider (user: the first decorative line is
  // unnecessary; the single '━' footer rule is the only one kept) ----
  (() => {
    const text = strip(screen().text);
    assert.ok(!text.includes('─'),
      "no indented '─' divider between results and the legend");
    assert.ok(text.includes('━'), 'the canonical bottom rule is still drawn');
    ok('single footer rule — the duplicate divider is gone');
  })();

  // ---- multi-line legend: both lines present, both cursor-free ----
  (() => {
    const legend = t('target.scan.results_actions', { n: 7 });
    assert.ok(legend.includes('\n'), 'legend is a two-line string');
    const lines = strip(screen().text).split('\n');
    for (const part of legend.split('\n')) {
      const hit = lines.find(l => l.includes(part.trim().split('  ')[0]));
      assert.ok(hit && !hit.includes(CURSOR), 'each legend line rendered, cursor-free');
    }
    assert.ok(legend.includes('(7)') || legend.includes('（7）'),
      'legend interpolates the checked count');
    ok('two-line legend rendered intact and cursor-free');
  })();

  // ---- empty branch: no cursor, no legend, just the empty notice ----
  (() => {
    setLocale('en');
    const out = captureScreenRender(() => renderDeepScanResults({
      version: '0.1.15',
      heading: t('target.scan.results_heading'),
      rangeText: t('target.scan.results_summary', { count: 0, from: 0, to: 0 }),
      visibleRows: [],
      actionLegend: t('target.scan.results_actions', { n: 0 }),
      hint: t('target.scan.results_hint'),
      emptyText: t('target.scan.none_found'),
    }));
    const text = strip(out.text);
    assert.ok(!text.includes(CURSOR), 'empty screen has no cursor');
    assert.ok(!text.includes('[↵]'), 'empty screen does not draw the legend');
    assert.ok(text.includes(t('target.scan.none_found')), 'empty notice shown');
    ok('empty branch: no cursor, no legend, shows the notice');
  })();

  // ---- checked = colored affordance; unchecked = grey blank ----
  // (user requirement: a pick must visibly light up, not start as a
  // wall of terra — turns red if the colour stops tracking check state)
  (() => {
    setLocale('en');
    const mk = checked => captureScreenRender(() => renderDeepScanResults({
      version: '0.1.15',
      heading: t('target.scan.results_heading'),
      rangeText: t('target.scan.results_summary', { count: 1, from: 1, to: 1 }),
      visibleRows: [{
        label: 'VS Code', path: '/h/.vscode/extensions',
        version: '2.1.143', checked, focused: false,
      }],
      actionLegend: t('target.scan.results_actions', { n: checked ? 1 : 0 }),
      hint: t('target.scan.results_hint'),
      emptyText: t('target.scan.none_found'),
    })).text;
    const on = mk(true), off = mk(false);
    assert.notStrictEqual(on, off, 'checked vs unchecked must not render identically');
    assert.ok(on.includes(color('[✓]', Ansi.TERRA)), 'checked box is terra ✓');
    assert.ok(off.includes(color('[ ]', Ansi.GREY)), 'unchecked box is grey blank');
    assert.ok(on.includes(color('VS Code', Ansi.IVORY)), 'checked label brightens to ivory');
    assert.ok(off.includes(color('VS Code', Ansi.GREY)), 'unchecked label recedes to grey');
    ok('checked is a colored affordance; unchecked is a grey blank');
  })();

  console.log('\ndeep-scan-results-screen: ' + passed + ' checks PASSED');
})();
