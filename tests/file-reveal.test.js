// Regression tests for the right-click "Open in File Explorer" path gate.
// Absolute paths can come from historical assistant/tool output while the
// current SessionState cwd has already moved to another workspace.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostBadge = require('../data/host-badge.cjs');

const {
  normalizeFileRevealPath,
  resolveFileRevealPathForCwd,
  assertFileRevealWorkspace,
} = hostBadge.__test;

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x');
  return filePath;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

(function absolutePathSurvivesStaleCwd() {
  const staleCwd = makeDir('incipit-reveal-cwd-');
  const otherRoot = makeDir('incipit-reveal-other-');
  try {
    const target = writeFile(path.join(otherRoot, 'dev-notes', 'task.md'));
    let raw = target.replace(/\\/g, '/');
    if (process.platform === 'win32') raw = raw.replace(/^[A-Z]:/, m => m.toLowerCase());
    const { rawIsAbsolute, resolved } = resolveFileRevealPathForCwd(raw, staleCwd);
    assert.strictEqual(rawIsAbsolute, true);
    assert.ok(samePath(resolved, target));
    assert.doesNotThrow(() => assertFileRevealWorkspace(staleCwd, resolved, rawIsAbsolute));
  } finally {
    cleanup(staleCwd);
    cleanup(otherRoot);
  }
})();

(function relativePathStillRequiresCwdAndWorkspaceContainment() {
  const cwd = makeDir('incipit-reveal-rel-cwd-');
  const otherRoot = makeDir('incipit-reveal-rel-other-');
  try {
    const target = writeFile(path.join(otherRoot, 'outside.md'));
    assert.throws(
      () => resolveFileRevealPathForCwd('outside.md', ''),
      /Relative file path has no Claude project cwd/,
    );
    const rel = path.relative(cwd, target);
    const { rawIsAbsolute, resolved } = resolveFileRevealPathForCwd(rel, cwd);
    assert.strictEqual(rawIsAbsolute, false);
    assert.throws(
      () => assertFileRevealWorkspace(cwd, resolved, rawIsAbsolute),
      /File path is outside the active workspace/,
    );
  } finally {
    cleanup(cwd);
    cleanup(otherRoot);
  }
})();

(function relativePathInsideCwdStillWorks() {
  const cwd = makeDir('incipit-reveal-inside-');
  try {
    const target = writeFile(path.join(cwd, 'dev-notes', 'task.md'));
    const { rawIsAbsolute, resolved } = resolveFileRevealPathForCwd('dev-notes/task.md', cwd);
    assert.strictEqual(rawIsAbsolute, false);
    assert.ok(samePath(resolved, target));
    assert.doesNotThrow(() => assertFileRevealWorkspace(cwd, resolved, rawIsAbsolute));
  } finally {
    cleanup(cwd);
  }
})();

(function fileUriDecodeKeepsWindowsDrivePathsAbsolute() {
  if (process.platform !== 'win32') return;
  const normalized = normalizeFileRevealPath('file:///v:/carpool/dev-notes/task.md');
  assert.strictEqual(normalized, 'v:\\carpool\\dev-notes\\task.md');
  assert.strictEqual(path.isAbsolute(normalized), true);
})();

console.log('file reveal path tests passed');
