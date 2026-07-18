'use strict';

// Offline tests for the selection-reference companion.
// Locks the `@file#start-end` mention shape and the new
// editor/context menu contributions. Does not require the VS Code API.

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Mirror `companion/claude-selection-reference/extension.js :: buildMention`
// + `selectedLineRange` (1-based, collapses empty end line).
function buildMention(relativePath, selection) {
  if (!relativePath) return null;
  if (!selection) return `@${relativePath}`;
  const start = selection.start.line + 1;
  let end = selection.end.line + 1;
  if (selection.end.character === 0 && end > start) end -= 1;
  if (start === end) return `@${relativePath}#${start}`;
  return `@${relativePath}#${start}-${end}`;
}

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

{
  assert.strictEqual(buildMention('src/a.js', null), '@src/a.js');
  assert.strictEqual(
    buildMention('src/a.js', { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } }),
    '@src/a.js#5',
  );
  assert.strictEqual(
    buildMention('src/a.js', { start: { line: 4, character: 2 }, end: { line: 9, character: 0 } }),
    '@src/a.js#5-9',
  );
  assert.strictEqual(
    buildMention('src/a.js', { start: { line: 4, character: 2 }, end: { line: 9, character: 3 } }),
    '@src/a.js#5-10',
  );
  assert.strictEqual(buildMention(null, { start: { line: 0 }, end: { line: 1 } }), null);
  ok('buildMention: whole-file, single-line, and line-range shapes');
}

// Package now contributes an editor/context menu for the active selection.
{
  const pkg = require(path.join(
    ROOT,
    'companion',
    'claude-selection-reference',
    'package.json',
  ));
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(cmds.includes('incipitClaudeReference.referenceActiveSelection'));
  assert.ok(cmds.includes('incipitClaudeReference.referenceActiveFile'));
  const ec = pkg.contributes.menus['editor/context'];
  assert.ok(ec, 'has editor/context menu');
  const selMenu = ec.find(
    (m) => m.command === 'incipitClaudeReference.referenceActiveSelection',
  );
  const fileMenu = ec.find(
    (m) => m.command === 'incipitClaudeReference.referenceActiveFile',
  );
  assert.ok(selMenu, 'editor/context has referenceActiveSelection entry');
  assert.ok(fileMenu, 'editor/context has referenceActiveFile entry');
  assert.strictEqual(selMenu.when, 'editorTextFocus && editorHasSelection');
  assert.strictEqual(fileMenu.when, 'editorTextFocus');
  ok('editor/context contributes selection + file reference entries');
}

console.log(`\n${passed} checks passed`);
if (passed === 0) process.exit(1);
