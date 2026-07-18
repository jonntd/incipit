'use strict';

// Offline tests for explorer→composer drop path resolution.
// Locks the @file / @folder/ mention shape used when dragging into chat.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'data', 'host-badge.cjs')).__test;

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

{
  assert.strictEqual(T.buildDropMention(null), null);
  assert.strictEqual(T.buildDropMention(''), null);
  assert.strictEqual(T.buildDropMention('   '), null);

  // Plain file path → @path (no trailing slash)
  const filePath = path.join(os.tmpdir(), 'incipit-drop-file-' + process.pid + '.txt');
  fs.writeFileSync(filePath, 'x');
  assert.strictEqual(T.buildDropMention(filePath), '@' + filePath.replace(/\\/g, '/'));
  fs.unlinkSync(filePath);

  // Directory path → @path/
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-drop-dir-'));
  const mention = T.buildDropMention(dirPath);
  assert.ok(mention.startsWith('@'));
  assert.ok(mention.endsWith('/'), 'folder mention must end with /');
  assert.ok(!mention.endsWith('//'), 'no double slash');
  fs.rmdirSync(dirPath);

  // file:// URI for a directory
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-drop-uri-'));
  const uri = 'file://' + dir2;
  const m2 = T.buildDropMention(uri);
  assert.ok(m2.endsWith('/'), 'file:// folder becomes @path/');
  assert.ok(m2.indexOf('file:') < 0, 'scheme stripped');
  fs.rmdirSync(dir2);

  // Unreachable path still produces a mention (best-effort)
  const ghost = T.buildDropMention('/no/such/path/for/incipit-drop-test');
  assert.strictEqual(ghost, '@/no/such/path/for/incipit-drop-test');

  ok('buildDropMention resolves files, folders, and file:// URIs');
}

console.log(`\n${passed} checks passed`);
if (passed === 0) process.exit(1);
