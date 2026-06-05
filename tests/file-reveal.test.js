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
  resolveFileCopyPathsForCwd,
  relativePathFromWorkspaceRoot,
  containingWorkspaceRoot,
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

(function copyAbsoluteRelativeInputUsesWorkspaceRootAndMayNotExist() {
  const workspace = makeDir('incipit-copy-workspace-');
  try {
    const raw = 'src/missing-file.md';
    const result = resolveFileCopyPathsForCwd(raw, '', [workspace]);
    assert.strictEqual(result.rawIsAbsolute, false);
    assert.strictEqual(result.relativePath, path.join('src', 'missing-file.md'));
    assert.ok(path.isAbsolute(result.absolutePath));
    assert.ok(samePath(result.absolutePath, path.join(workspace, raw)));
    assert.strictEqual(result.workspaceRoot, workspace);
  } finally {
    cleanup(workspace);
  }
})();

(function copyAbsoluteNeverFallsBackToRelativeWhenBaseIsMissing() {
  assert.throws(
    () => resolveFileCopyPathsForCwd('src/missing-file.md', '', []),
    /Relative file path has no VS Code workspace folder or Claude project cwd/,
  );
})();

(function copyRelativeAbsoluteInputUsesContainingWorkspace() {
  const workspaceA = makeDir('incipit-copy-workspace-a-');
  const workspaceB = makeDir('incipit-copy-workspace-b-');
  try {
    const target = path.join(workspaceB, 'nested', 'file.md');
    const result = resolveFileCopyPathsForCwd(target, workspaceA, [workspaceA, workspaceB]);
    assert.strictEqual(result.rawIsAbsolute, true);
    assert.ok(samePath(result.absolutePath, target));
    assert.strictEqual(result.relativePath, path.join('nested', 'file.md'));
    assert.strictEqual(containingWorkspaceRoot([workspaceA, workspaceB], target), workspaceB);
  } finally {
    cleanup(workspaceA);
    cleanup(workspaceB);
  }
})();

(function copyRelativeCanExpressOutsideSameRoot() {
  const workspace = makeDir('incipit-copy-workspace-');
  const sibling = makeDir('incipit-copy-sibling-');
  try {
    const target = path.join(sibling, 'outside.md');
    const result = resolveFileCopyPathsForCwd(target, workspace, [workspace]);
    assert.strictEqual(result.rawIsAbsolute, true);
    assert.ok(!path.isAbsolute(result.relativePath), 'relative copy must not return an absolute path');
    assert.ok(result.relativePath.startsWith('..' + path.sep) || result.relativePath === '..');
  } finally {
    cleanup(workspace);
    cleanup(sibling);
  }
})();

(function copyTildeExpandsToHomeAbsolutePath() {
  const result = resolveFileCopyPathsForCwd('~/incipit-copy-test.md', '', []);
  assert.strictEqual(result.rawIsAbsolute, true);
  assert.ok(samePath(result.absolutePath, path.join(os.homedir(), 'incipit-copy-test.md')));
})();

(function relativePathHelperNeverReturnsAbsoluteAcrossRoots() {
  const workspace = makeDir('incipit-copy-root-');
  try {
    const target = path.join(workspace, 'a', 'b.md');
    assert.strictEqual(relativePathFromWorkspaceRoot(workspace, target), path.join('a', 'b.md'));
  } finally {
    cleanup(workspace);
  }
})();

(function fileUriDecodeKeepsWindowsDrivePathsAbsolute() {
  if (process.platform !== 'win32') return;
  const normalized = normalizeFileRevealPath('file:///v:/carpool/dev-notes/task.md');
  assert.strictEqual(normalized, 'v:\\carpool\\dev-notes\\task.md');
  assert.strictEqual(path.isAbsolute(normalized), true);
})();

console.log('file reveal path tests passed');
