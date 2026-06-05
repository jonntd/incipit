'use strict';

// Regression coverage for GitHub issues #5 and #6.
//
// #5 (functional layer): the editor-selection overlay must recognize BOTH
//     official Microsoft VS Code desktop channels — Stable and Insiders —
//     since they share a byte-identical Workbench layout. Third-party forks
//     (Cursor / Windsurf) must still be rejected.
//
// #5 (user layer): when the overlay is requested but the editor cannot be
//     uniquely + safely confirmed, preflight must DEGRADE (return a marked
//     result), never throw. A throw here used to abort the user's entire
//     apply over one opt-in experimental extra.
//
// #6: the Windows folder picker must not assign FolderBrowserDialog
//     .UseDescriptionForTitle unconditionally — that property only exists
//     on .NET Framework 4.8.1+ / .NET Core 3.0+, and Windows PowerShell
//     5.1 on a 4.8 box throws PropertyAssignmentException, killing the
//     whole dialog. The assignment must be property-guarded.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wb = require('../src/workbench-overlay');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

function mkExtTarget(root, dotDir) {
  const extDir = path.join(root, dotDir, 'extensions', 'anthropic.claude-code-2.1.143-win32-x64');
  fs.mkdirSync(extDir, { recursive: true });
  return { extensionDir: extDir, settingsPath: path.join(root, dotDir, 'User', 'settings.json') };
}

function mkAppRoot(parent, product) {
  const ar = fs.mkdtempSync(path.join(parent, 'app-'));
  fs.mkdirSync(path.join(ar, 'out', 'vs', 'workbench'), { recursive: true });
  fs.writeFileSync(path.join(ar, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'), '/* official */');
  fs.writeFileSync(path.join(ar, 'product.json'), JSON.stringify(product));
  fs.writeFileSync(path.join(ar, 'package.json'), JSON.stringify({
    name: product.applicationName || 'code', version: product.version || '1.0.0',
  }));
  return ar;
}

// ---- #5 functional: isOfficialVSCodeTarget recognizes both channels ----

(function officialChannelRecognition() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-ov-'));
  assert.strictEqual(wb.isOfficialVSCodeTarget(mkExtTarget(dir, '.vscode')), true,
    'VS Code Stable (.vscode/extensions) must be recognized');
  assert.strictEqual(wb.isOfficialVSCodeTarget(mkExtTarget(dir, '.vscode-insiders')), true,
    'VS Code Insiders (.vscode-insiders/extensions) must be recognized');
  assert.strictEqual(wb.isOfficialVSCodeTarget(mkExtTarget(dir, '.vscode-oss')), true,
    'VSCodium / Code - OSS (.vscode-oss/extensions) must be recognized');
  assert.strictEqual(wb.isOfficialVSCodeTarget(mkExtTarget(dir, '.cursor')), false,
    'Cursor fork must NOT be recognized');
  assert.strictEqual(wb.isOfficialVSCodeTarget(mkExtTarget(dir, '.windsurf')), false,
    'Windsurf fork must NOT be recognized');
  ok('isOfficialVSCodeTarget: Stable + Insiders accepted; forks rejected (#5)');
})();

// ---- #5 functional: appRootLooksSupported accepts code-insiders ----

(function productIdentityRecognition() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-ar-'));
  assert.strictEqual(
    wb.appRootLooksSupported(mkAppRoot(dir, { applicationName: 'code', nameLong: 'Visual Studio Code' })),
    true, 'Stable product (applicationName=code) must be supported');
  assert.strictEqual(
    wb.appRootLooksSupported(mkAppRoot(dir, { applicationName: 'code-insiders', nameLong: 'Visual Studio Code - Insiders' })),
    true, 'Insiders product (applicationName=code-insiders) must be supported');
  assert.strictEqual(
    wb.appRootLooksSupported(mkAppRoot(dir, { applicationName: 'codium', nameLong: 'VSCodium' })),
    true, 'VSCodium product (applicationName=codium) must be supported');
  assert.strictEqual(
    wb.appRootLooksSupported(mkAppRoot(dir, { applicationName: 'code-oss', nameLong: 'Code - OSS' })),
    true, 'Code - OSS product (applicationName=code-oss) must be supported');
  assert.strictEqual(
    wb.appRootLooksSupported(mkAppRoot(dir, { applicationName: 'cursor', nameLong: 'Cursor' })),
    false, 'reshaped fork product must NOT be supported');
  ok('appRootLooksSupported: code + code-insiders accepted; fork product rejected (#5)');
})();

// ---- #5 functional: env-resolved Insiders app root resolves OK ----

(function insidersResolvesViaEnv() {
  const saved = process.env.INCIPIT_WORKBENCH_APP_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-env-'));
  const appRoot = mkAppRoot(dir, { applicationName: 'code-insiders', nameLong: 'Visual Studio Code - Insiders', version: '1.99.0' });
  process.env.INCIPIT_WORKBENCH_APP_ROOT = appRoot;
  try {
    const resolved = wb.resolveWorkbenchTarget(mkExtTarget(dir, '.vscode-insiders'));
    assert.strictEqual(resolved.ok, true, 'env-pinned Insiders app root must resolve ok');
    assert.ok(resolved.workbenchPath.endsWith(path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js')),
      'resolved workbenchPath must point at the Insiders Workbench bundle');
  } finally {
    if (saved === undefined) delete process.env.INCIPIT_WORKBENCH_APP_ROOT;
    else process.env.INCIPIT_WORKBENCH_APP_ROOT = saved;
  }
  ok('resolveWorkbenchTarget: env-pinned Insiders app root resolves (#5)');
})();

// ---- #5 user layer: preflight degrades, never throws ----

(function preflightDegradesNeverThrows() {
  const saved = process.env.INCIPIT_WORKBENCH_APP_ROOT;
  delete process.env.INCIPIT_WORKBENCH_APP_ROOT;
  try {
    const off = wb.preflightWorkbenchOverlayForTarget({}, false);
    assert.strictEqual(off.status, 'off', 'disabled overlay → status off');

    // Enabled + an unconfirmable (fork) target with no env / host-identity
    // pin. This is deterministic regardless of machine state: the
    // isOfficialVSCodeTarget gate rejects the fork before any platform or
    // restore-point scan, so it always returns reason only-official-vscode.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-pf-'));
    const target = mkExtTarget(dir, '.cursor');
    let res, threw = false;
    try { res = wb.preflightWorkbenchOverlayForTarget(target, true); }
    catch (_) { threw = true; }
    assert.strictEqual(threw, false, 'preflight MUST NOT throw for an unconfirmable target (#5 user layer)');
    assert.strictEqual(res.status, 'degraded', 'unconfirmable + enabled → degraded');
    assert.strictEqual(res.enabled, false, 'degraded result must report enabled=false');
    assert.strictEqual(res.requested, true, 'degraded result must remember the user opted in');
    assert.strictEqual(res.reason, 'only-official-vscode', 'fork target → only-official-vscode reason');
    assert.ok(typeof res.message === 'string' && res.message.length > 0, 'degraded result carries a message');
  } finally {
    if (saved === undefined) delete process.env.INCIPIT_WORKBENCH_APP_ROOT;
    else process.env.INCIPIT_WORKBENCH_APP_ROOT = saved;
  }
  ok('preflight: enabled+unconfirmable → degraded (no throw); disabled → off (#5 user layer)');
})();

// ---- #6: Windows folder picker guards UseDescriptionForTitle ----

(function folderDialogPropertyGuarded() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'file-dialog.js'), 'utf8');
  assert.ok(
    src.includes("PSObject.Properties['UseDescriptionForTitle']"),
    'file-dialog.js must property-guard UseDescriptionForTitle (#6)',
  );
  assert.ok(
    !/\n\s*\$dlg\.UseDescriptionForTitle\s*=\s*\$true/.test(src),
    'file-dialog.js must NOT assign UseDescriptionForTitle on its own statement line (#6)',
  );
  ok('file-dialog: UseDescriptionForTitle assignment is property-guarded (#6)');
})();

// ---- Workbench overlay: body observer stays childList-only ----

(function overlayObserverIsChildListOnly() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'workbench-overlay.js'), 'utf8');
  assert.ok(
    src.includes('observer.observe(document.body, { childList: true, subtree: true });'),
    'editor overlay body observer must stay childList-only',
  );
  assert.ok(
    !src.includes("observer.observe(document.body, { childList: true, subtree: true, attributes: true"),
    'editor overlay must not observe Workbench-wide class/style attributes',
  );
  ok('workbench overlay: body observer is childList-only');
})();

console.log('\neditor-overlay-insiders: ' + passed + ' checks PASSED');
