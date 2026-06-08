'use strict';

// Regression coverage for manual "add Claude Code target" detection.
//
// The reported gap: a user manually adding a target naturally picks the
// editor PROFILE ROOT (~/.vscode, ~/.cursor, ~/.vscode-insiders, ...)
// whose `extensions/` subfolder holds Claude Code. Before the fix none of
// identifyFolder's layers handled the profile-root pick (Layer 2 only
// scanned the picked dir itself; Layer 3 required a portable
// extensions/+user-data/ pair), so the most natural pick was rejected as
// "no known shape".
//
// Contract asserted here:
//   · profile root with extensions/anthropic.claude-code-* → extensions_dir,
//     extensionsDir resolved one level down (NOT the picked dir itself)
//   · profile-name-agnostic (.vscode / .cursor / .vscode-insiders / ...)
//   · profile shape but Claude Code absent → unknown + a SPECIFIC hint
//     (profile-no-claude-code), not the generic no-known-shape
//   · multi-version → latest is chosen deterministically (no silent
//     wrong-version pick)
//   · Layer 1 (version dir) and Layer 2 (extensions dir) still work
//   · a non-editor folder is still rejected (no false positive)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  deriveSettingsPathFromExtensionsDir,
  identifyFolder,
} = require('../src/host-detect');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-hd-')); }

// A Claude Code extension version dir. `full` makes it pass Layer 1's
// stricter shape (extension.js + webview/); name-only is enough for the
// scanClaudeCodeExtensions name match used by Layers 2 and 5.
function mkExtVersion(extensionsDir, version, { full = false } = {}) {
  const name = `anthropic.claude-code-${version}-win32-x64`;
  const dir = path.join(extensionsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (full) {
    fs.writeFileSync(path.join(dir, 'extension.js'), '/* x */');
    fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  }
  return { name, dir };
}

// ---- profile root is recognized one level down (the reported gap) ----

(function profileRootRecognized() {
  for (const profile of ['.vscode', '.cursor', '.vscode-insiders', '.windsurf', '.antigravity-ide']) {
    const root = tmp();
    const picked = path.join(root, profile);
    const extDir = path.join(picked, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    const ext = mkExtVersion(extDir, '2.1.143');

    const id = identifyFolder(picked);
    assert.strictEqual(id.kind, 'extensions_dir',
      `${profile}: profile root must resolve to an extensions_dir`);
    assert.strictEqual(path.resolve(id.extensionsDir), path.resolve(extDir),
      `${profile}: extensionsDir must be <picked>/extensions, not the picked dir`);
    assert.strictEqual(id.latestExtName, ext.name,
      `${profile}: must report the discovered extension`);
  }
  ok('profile root (.vscode/.cursor/.vscode-insiders/.windsurf/.antigravity-ide) → extensions_dir one level down');
})();

// ---- Antigravity IDE 2.0 renamed both the profile and app-data roots ----

(function antigravityIde20NamesAreRecognized() {
  const root = tmp();
  const picked = path.join(root, '.antigravity-ide');
  const extDir = path.join(picked, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  mkExtVersion(extDir, '2.1.163');

  const oldAppData = process.env.APPDATA;
  const oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const appData = path.join(root, 'Roaming');
  let expectedRoot;
  if (process.platform === 'win32') {
    process.env.APPDATA = appData;
    expectedRoot = path.join(appData, 'Antigravity IDE');
  } else if (process.platform === 'darwin') {
    expectedRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE');
  } else {
    process.env.XDG_CONFIG_HOME = appData;
    expectedRoot = path.join(appData, 'Antigravity IDE');
  }
  fs.mkdirSync(path.join(expectedRoot, 'User'), { recursive: true });
  try {
    const id = identifyFolder(picked);
    assert.strictEqual(id.kind, 'extensions_dir');
    assert.strictEqual(path.resolve(id.extensionsDir), path.resolve(extDir));
    assert.strictEqual(
      path.resolve(id.settingsPath),
      path.resolve(path.join(expectedRoot, 'User', 'settings.json')),
      'Antigravity IDE 2.0 settings must map to the renamed app-data root',
    );
    assert.strictEqual(
      path.resolve(deriveSettingsPathFromExtensionsDir(extDir)),
      path.resolve(path.join(expectedRoot, 'User', 'settings.json')),
      'derived settings path must also prefer Antigravity IDE over the legacy Antigravity root',
    );
  } finally {
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdgConfigHome;
  }
  ok('Antigravity IDE 2.0 profile/app-data names are recognized');
})();

// ---- Antigravity IDE 2.0 install root has a spaced executable name ----

(function antigravityIde20InstallRootIsRecognizedAsStandardHost() {
  const root = tmp();
  const picked = path.join(root, 'Antigravity IDE');
  fs.mkdirSync(picked, { recursive: true });
  fs.writeFileSync(path.join(picked, 'Antigravity IDE.exe'), '');
  const id = identifyFolder(picked);
  assert.strictEqual(id.kind, 'standard_install_root');
  assert.strictEqual(id.hint, 'standard-install-no-data');
  assert.strictEqual(id.recoverable, true);
  ok('Antigravity IDE 2.0 install root executable is recognized');
})();

// ---- profile shape but no Claude Code → specific actionable hint ----

(function profileShapeNoClaude() {
  const root = tmp();
  const picked = path.join(root, '.vscode');
  fs.mkdirSync(path.join(picked, 'extensions'), { recursive: true }); // empty
  const id = identifyFolder(picked);
  assert.strictEqual(id.kind, 'unknown', 'no Claude Code → unknown');
  assert.strictEqual(id.hint, 'profile-no-claude-code',
    'profile-shaped pick with empty extensions/ must give the specific hint, not no-known-shape');
  ok('profile root with empty extensions/ → unknown + profile-no-claude-code hint');
})();

// ---- multi-version under a profile root: latest, deterministically ----

(function profileRootPicksLatest() {
  const root = tmp();
  const picked = path.join(root, '.vscode');
  const extDir = path.join(picked, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  mkExtVersion(extDir, '2.1.121');
  mkExtVersion(extDir, '2.1.143');
  mkExtVersion(extDir, '2.1.138');
  const id = identifyFolder(picked);
  assert.strictEqual(id.kind, 'extensions_dir');
  assert.ok(/2\.1\.143-/.test(id.latestExtName),
    `latest version must win deterministically, got ${id.latestExtName}`);
  ok('profile root with multiple versions → latest chosen (no silent wrong pick)');
})();

// ---- regression: Layer 2 (directly-picked extensions dir) still works ----

(function extensionsDirStillWorks() {
  const root = tmp();
  const extDir = path.join(root, '.vscode', 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const ext = mkExtVersion(extDir, '2.1.143');
  const id = identifyFolder(extDir);
  assert.strictEqual(id.kind, 'extensions_dir');
  assert.strictEqual(path.resolve(id.extensionsDir), path.resolve(extDir),
    'directly-picked extensions dir stays the extensionsDir');
  assert.strictEqual(id.latestExtName, ext.name);
  ok('regression: directly-picked extensions dir → extensions_dir (Layer 2 intact)');
})();

// ---- regression: Layer 1 (directly-picked version dir) still works ----

(function versionDirStillWorks() {
  const root = tmp();
  const extDir = path.join(root, '.vscode', 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const ext = mkExtVersion(extDir, '2.1.143', { full: true });
  const id = identifyFolder(ext.dir);
  assert.strictEqual(id.kind, 'extension_version',
    'directly-picked version dir → extension_version (Layer 1 intact)');
  assert.strictEqual(path.resolve(id.extensionsDir), path.resolve(extDir),
    'version dir resolves extensionsDir to its parent');
  ok('regression: directly-picked anthropic.claude-code-* version dir → extension_version');
})();

// ---- no false positive on a non-editor folder ----

(function nonEditorRejected() {
  const root = tmp();
  const picked = path.join(root, 'some-random-project');
  fs.mkdirSync(path.join(picked, 'src'), { recursive: true });
  const id = identifyFolder(picked);
  assert.strictEqual(id.kind, 'unknown', 'a random folder must not be accepted');
  assert.notStrictEqual(id.hint, 'profile-no-claude-code',
    'a folder without an extensions/ subdir must NOT claim the profile hint');
  ok('non-editor folder → unknown, no false positive / no misleading hint');
})();

console.log('\nhost-detect-manual-add: ' + passed + ' checks PASSED');
