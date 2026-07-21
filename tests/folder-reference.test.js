'use strict';

// Offline tests for the folder-reference companion + the companion
// installer. Exercises mention-string building, package contributes, and
// installCompanions copy/register/idempotency. Does not require the
// VS Code API or network.

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const install = require(path.join(ROOT, 'src', 'install.js'));

// Real VS Code strips the scheme; an absolute path's fsPath has no
// leading slash. Mirror that so the `file://` branch matches reality.
const vscode = {
  Uri: {
    parse: (s) => ({ fsPath: s.replace(/^file:\/\//, '') }),
  },
};

// Lock the `@<path>` / `@<path>/` contract the webview expects.
// Keep in sync with `companion/claude-folder-reference/extension.js :: mentionFor`.
function mentionFor(resource, isFolder) {
  let fsPath = null;
  if (resource && typeof resource.fsPath === 'string') fsPath = resource.fsPath;
  else if (typeof resource === 'string') {
    fsPath = resource.startsWith('file://')
      ? vscode.Uri.parse(resource).fsPath
      : resource;
  }
  if (!fsPath) return null;
  if (isFolder && !fsPath.endsWith('/') && !fsPath.endsWith('\\')) {
    return `@${fsPath}/`;
  }
  return `@${fsPath}`;
}

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

{
  // Folders get a trailing slash; files do not.
  assert.strictEqual(
    mentionFor({ fsPath: '/Users/me/proj/src' }, true),
    '@/Users/me/proj/src/',
  );
  assert.strictEqual(
    mentionFor({ fsPath: '/Users/me/proj/src/file.js' }, false),
    '@/Users/me/proj/src/file.js',
  );
  assert.strictEqual(
    mentionFor('/Users/me/proj/src', true),
    '@/Users/me/proj/src/',
  );
  assert.strictEqual(
    mentionFor('file:///Users/me/proj/src', true),
    '@/Users/me/proj/src/',
  );
  // Already-slashed folders keep the slash (no double slash).
  assert.strictEqual(
    mentionFor({ fsPath: '/Users/me/proj/src/' }, true),
    '@/Users/me/proj/src/',
  );
  assert.strictEqual(mentionFor(null, true), null);
  assert.strictEqual(mentionFor({}, true), null);
  ok('mentionFor: folder slash, file no-slash, null safety');
}

// Package contributes one unified explorer/context command for both.
{
  const pkg = require(path.join(
    ROOT,
    'companion',
    'claude-folder-reference',
    'package.json',
  ));
  assert.strictEqual(pkg.name, 'claude-folder-reference', 'short package name');
  assert.strictEqual(pkg.publisher, 'incipit');
  assert.strictEqual(
    install.companionFullId(pkg),
    'incipit.claude-folder-reference',
    'full id = publisher.name',
  );
  assert.strictEqual(
    install.companionFullId({ publisher: 'incipit', name: 'incipit.claude-folder-reference' }),
    'incipit.claude-folder-reference',
    'already-prefixed name is not double-prefixed',
  );
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(cmds.includes('incipitClaudeFolderReference.add'));
  assert.ok(cmds.includes('incipitClaudeFolderReference.addFromPicker'));
  assert.ok(!cmds.includes('incipitClaudeFolderReference.addFile'));
  assert.ok(!cmds.includes('incipitClaudeFolderReference.addFolder'));

  const explorer = pkg.contributes.menus['explorer/context'];
  assert.strictEqual(explorer.length, 1, 'one unified explorer/context entry');
  const entry = explorer[0];
  assert.strictEqual(entry.command, 'incipitClaudeFolderReference.add');
  // explorerResourceIsFile is NOT a VS Code context key — using it hides the
  // item on files. resourceScheme covers both files and folders.
  assert.strictEqual(
    entry.when,
    'resourceScheme == file || resourceScheme == vscode-remote || resourceScheme == vscode-vfs',
  );
  assert.ok(
    !entry.when.includes('explorerResourceIsFile'),
    'must not rely on non-existent explorerResourceIsFile key',
  );
  assert.ok(
    entry.group && entry.group.startsWith('navigation'),
    'sits in navigation group near other Add-to-chat actions',
  );
  const addCmd = pkg.contributes.commands.find(
    (c) => c.command === 'incipitClaudeFolderReference.add',
  );
  assert.strictEqual(addCmd.title, 'Incipit: Add to Claude Code');
  assert.ok(
    pkg.activationEvents.includes('onStartupFinished'),
    'keeps onStartupFinished',
  );
  ok('package.json contributes unified Add to Claude Code menu');
}

// installCompanions copies each companion into a fake host extension
// dir and registers it in extensions.json (idempotent on re-run).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-cmp-'));
  const extDir = path.join(tmp, 'anthropic.claude-code-9.9.999-darwin-arm64');
  fs.mkdirSync(path.join(extDir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'extension.js'), '//x');
  fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), '//x');
  const ejPath = path.join(tmp, 'extensions.json');
  fs.writeFileSync(
    ejPath,
    JSON.stringify([{ identifier: { id: 'anthropic.claude-code' }, version: '9.9.999' }]),
  );

  const lines1 = install.installCompanions(ROOT, extDir);
  assert.ok(lines1.length >= 1, 'produces status lines');
  assert.ok(
    fs.existsSync(
      path.join(tmp, 'incipit.claude-folder-reference-0.0.4', 'extension.js'),
    ),
    'folder companion copied',
  );
  assert.ok(
    fs.existsSync(
      path.join(tmp, 'incipit.claude-selection-reference-0.0.3', 'extension.js'),
    ),
    'selection companion copied under publisher-prefixed id',
  );
  const ej1 = JSON.parse(fs.readFileSync(ejPath, 'utf8'));
  assert.ok(
    ej1.some((e) => e.identifier && e.identifier.id === 'incipit.claude-folder-reference'),
    'folder companion registered in extensions.json',
  );
  assert.ok(
    ej1.some((e) => e.identifier && e.identifier.id === 'incipit.claude-selection-reference'),
    'selection companion registered under publisher-prefixed id',
  );
  assert.ok(
    ej1.some((e) => e.identifier && e.identifier.id === 'anthropic.claude-code'),
    'pre-existing extensions.json entries are preserved',
  );

  // Re-run: must NOT re-register (idempotent).
  install.installCompanions(ROOT, extDir);
  const ej2 = JSON.parse(fs.readFileSync(ejPath, 'utf8'));
  assert.strictEqual(
    ej2.filter((e) => e.identifier && e.identifier.id === 'incipit.claude-folder-reference').length,
    1,
    'registered exactly once',
  );
  ok('installCompanions copies + registers + is idempotent');
}

// Corrupt extensions.json must NOT be rewritten from [] (would wipe other
// extensions and look like a damaged IDE install on forks).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-cmp-bad-'));
  const extDir = path.join(tmp, 'anthropic.claude-code-9.9.999');
  fs.mkdirSync(extDir, { recursive: true });
  const ejPath = path.join(tmp, 'extensions.json');
  fs.writeFileSync(ejPath, '{not-json');
  const lines = install.installCompanions(ROOT, extDir);
  assert.ok(
    lines.some((l) => /降级/.test(l) || /companion/.test(l)),
    'reports degrade status for corrupt registry',
  );
  assert.strictEqual(
    fs.readFileSync(ejPath, 'utf8'),
    '{not-json',
    'corrupt extensions.json left untouched',
  );
  assert.ok(
    !fs.existsSync(path.join(tmp, 'incipit.claude-folder-reference-0.0.4')),
    'does not side-load companions when registry is corrupt',
  );
  ok('installCompanions refuses to wipe a corrupt extensions.json');
}

// Legacy bare-id selection companion is pruned on install.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-cmp-legacy-'));
  const extDir = path.join(tmp, 'anthropic.claude-code-9.9.999');
  fs.mkdirSync(extDir, { recursive: true });
  const legacyDir = path.join(tmp, 'claude-selection-reference-0.0.2');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'extension.js'), '//legacy');
  const ejPath = path.join(tmp, 'extensions.json');
  fs.writeFileSync(
    ejPath,
    JSON.stringify([
      { identifier: { id: 'anthropic.claude-code' }, version: '9.9.999' },
      { identifier: { id: 'claude-selection-reference' }, version: '0.0.2' },
    ]),
  );
  install.installCompanions(ROOT, extDir);
  assert.ok(!fs.existsSync(legacyDir), 'legacy selection companion dir removed');
  const ej = JSON.parse(fs.readFileSync(ejPath, 'utf8'));
  assert.ok(
    !ej.some((e) => e.identifier && e.identifier.id === 'claude-selection-reference'),
    'legacy selection id removed from registry',
  );
  assert.ok(
    ej.some((e) => e.identifier && e.identifier.id === 'incipit.claude-selection-reference'),
    'new selection id registered',
  );
  ok('installCompanions prunes legacy claude-selection-reference id');
}

// removeCompanions drops dirs + registry entries (used by restore).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-cmp-rm-'));
  const extDir = path.join(tmp, 'anthropic.claude-code-9.9.999');
  fs.mkdirSync(extDir, { recursive: true });
  const ejPath = path.join(tmp, 'extensions.json');
  fs.writeFileSync(
    ejPath,
    JSON.stringify([{ identifier: { id: 'anthropic.claude-code' }, version: '9.9.999' }]),
  );
  install.installCompanions(ROOT, extDir);
  assert.ok(fs.existsSync(path.join(tmp, 'incipit.claude-folder-reference-0.0.4')));
  const cleanup = install.removeCompanions(extDir);
  assert.ok(cleanup.removed >= 1, 'removed at least one companion dir');
  assert.ok(!fs.existsSync(path.join(tmp, 'incipit.claude-folder-reference-0.0.4')));
  assert.ok(!fs.existsSync(path.join(tmp, 'incipit.claude-selection-reference-0.0.3')));
  const ej = JSON.parse(fs.readFileSync(ejPath, 'utf8'));
  assert.ok(
    !ej.some((e) => e.identifier && String(e.identifier.id).startsWith('incipit.claude-')),
    'companion registry entries removed',
  );
  assert.ok(
    ej.some((e) => e.identifier && e.identifier.id === 'anthropic.claude-code'),
    'non-companion entries preserved on remove',
  );
  ok('removeCompanions cleans dirs + registry without wiping others');
}

console.log(`\n${passed} checks passed`);
if (passed === 0) process.exit(1);
