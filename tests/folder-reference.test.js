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
  const cmds = pkg.contributes.commands.map((c) => c.command);
  assert.ok(cmds.includes('incipitClaudeFolderReference.add'));
  assert.ok(cmds.includes('incipitClaudeFolderReference.addFromPicker'));
  assert.ok(!cmds.includes('incipitClaudeFolderReference.addFile'));
  assert.ok(!cmds.includes('incipitClaudeFolderReference.addFolder'));

  const explorer = pkg.contributes.menus['explorer/context'];
  assert.strictEqual(explorer.length, 1, 'one unified explorer/context entry');
  const entry = explorer[0];
  assert.strictEqual(entry.command, 'incipitClaudeFolderReference.add');
  assert.strictEqual(
    entry.when,
    'explorerResourceIsFolder || explorerResourceIsFile',
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
      path.join(tmp, 'incipit.claude-folder-reference-0.0.3', 'extension.js'),
    ),
    'folder companion copied',
  );
  const ej1 = JSON.parse(fs.readFileSync(ejPath, 'utf8'));
  assert.ok(
    ej1.some((e) => e.identifier && e.identifier.id === 'incipit.claude-folder-reference'),
    'folder companion registered in extensions.json',
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

console.log(`\n${passed} checks passed`);
if (passed === 0) process.exit(1);
