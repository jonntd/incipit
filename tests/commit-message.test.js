'use strict';

// Offline tests for the SCM commit-message patch module.
// Does not call the network; exercises sanitize / prompt / package merge /
// activate injection anchors only.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const bundle = require(path.join(ROOT, 'data', 'commit_message_bundle.js'));
const T = bundle.__test;
const install = require(path.join(ROOT, 'src', 'install.js'));

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

// --- sanitizeCommitMessage -------------------------------------------------

{
  assert.strictEqual(T.sanitizeCommitMessage('feat: add x'), 'feat: add x');
  assert.strictEqual(
    T.sanitizeCommitMessage('```\nfix: y\n```'),
    'fix: y',
  );
  assert.strictEqual(
    T.sanitizeCommitMessage('```text\nchore: z\n```'),
    'chore: z',
  );
  assert.strictEqual(
    T.sanitizeCommitMessage('Commit message: feat: a'),
    'feat: a',
  );
  assert.strictEqual(
    T.sanitizeCommitMessage('"feat: quoted"'),
    'feat: quoted',
  );
  assert.strictEqual(T.sanitizeCommitMessage('   \n  '), '');
  assert.strictEqual(T.sanitizeCommitMessage(null), '');
  const long = 'a'.repeat(5000);
  assert.ok(T.sanitizeCommitMessage(long).length <= 2000);
  assert.strictEqual(
    T.sanitizeCommitMessage('feat: add ✨ sparkle 🚀 rocket'),
    'feat: add sparkle rocket',
  );
  assert.ok(!/\p{Extended_Pictographic}/u.test(T.sanitizeCommitMessage('fix: 🐛 bug')));
  ok('sanitizeCommitMessage strips wrappers, emoji, and caps length');
}

// --- SYSTEM_PROMPT contract -------------------------------------------------

{
  assert.ok(T.SYSTEM_PROMPT.includes('提交信息生成器'));
  assert.ok(T.SYSTEM_PROMPT.includes('约定式提交'));
  assert.ok(T.SYSTEM_PROMPT.includes('简体中文'));
  assert.ok(T.SYSTEM_PROMPT.includes('feat'));
  assert.ok(T.SYSTEM_PROMPT.includes('禁止 emoji') || T.SYSTEM_PROMPT.includes('emoji'));
  assert.ok(T.SYSTEM_PROMPT.includes('不臆造'));
  assert.ok(!T.SYSTEM_PROMPT.includes('⚠️'));
  ok('SYSTEM_PROMPT is Chinese conventional-commit style');
}

// --- buildCommitUserPrompt -------------------------------------------------

{
  const prompt = T.buildCommitUserPrompt({
    status: ' M src/a.js\n?? src/b.js',
    diff: 'diff --git a/src/a.js b/src/a.js\n+hello',
    examples: ['feat: prior one', 'fix: prior two'],
    stats: { added: 1, modified: 1, deleted: 0, renamed: 0, total: 2 },
  });
  assert.ok(prompt.includes('DIFF:'));
  assert.ok(prompt.includes('+hello'));
  assert.ok(prompt.includes('历史提交参考:'));
  assert.ok(prompt.includes('feat: prior one'));
  assert.ok(prompt.includes('STATUS:'));
  assert.ok(prompt.includes('改动文件共 2 个'));
  assert.ok(prompt.includes('简体中文'));
  ok('buildCommitUserPrompt is DIFF/历史/STATUS shaped');
}

{
  const stats = T.summarizeStatusStats(' M src/a.js\n?? src/b.js\nD  src/c.js\nR  old -> new');
  assert.strictEqual(stats.modified, 1);
  assert.strictEqual(stats.added, 1);
  assert.strictEqual(stats.deleted, 1);
  assert.strictEqual(stats.renamed, 1);
  assert.strictEqual(stats.total, 4);
  assert.ok(T.formatStatsLine(stats).includes('改动文件共 4 个'));
  assert.strictEqual(T.formatStatsLine({ total: 0 }), '');
  ok('summarizeStatusStats + formatStatsLine');
}

// --- truncateDiff ----------------------------------------------------------

{
  assert.strictEqual(T.truncateDiff('short', 100), 'short');
  const big = 'x'.repeat(100);
  const out = T.truncateDiff(big, 40);
  assert.ok(out.length < big.length);
  assert.ok(out.includes('truncated'));
  assert.ok(out.startsWith('xxxx'));
  ok('truncateDiff keeps head and marks truncation');
}

// --- package contribution shape --------------------------------------------

{
  const pkgPath = path.join(ROOT, 'data', 'commit_message_package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert.ok(pkg.contributes);
  assert.ok(Array.isArray(pkg.contributes.commands));
  const cmd = pkg.contributes.commands.find(c => c.command === T.COMMAND_ID);
  assert.ok(cmd, 'command contributed');
  assert.strictEqual(cmd.icon, 'resources/commit_message_icon.svg');
  assert.ok(pkg.contributes.menus['scm/title']);
  const scm = pkg.contributes.menus['scm/title'].find(m => m.command === T.COMMAND_ID);
  assert.ok(scm, 'scm/title menu entry');
  assert.strictEqual(scm.group, 'navigation@0');
  ok('commit_message_package.json contributes scm/title gold-sparkle command');
}

// --- ROOT_WEBVIEW_FILES includes bundle ------------------------------------

{
  const names = install.ROOT_WEBVIEW_FILES.map(([, name]) => name);
  assert.ok(names.includes('commit_message_bundle.js'));
  assert.ok(names.includes('host-badge.cjs'));
  ok('ROOT_WEBVIEW_FILES ships commit_message_bundle.js');
}

// --- activate injection (synthetic extension.js) ---------------------------

{
  // Shape A: exports.activate = someFn;  (classic) — commit-message wraps alone
  let updated = [
    'exports.activate = activateFn;',
    'function activateFn(ctx) { return 1; }',
  ].join('\n');
  updated = updated.replace(
    /exports\.activate\s*=\s*([A-Za-z_$][\w$]*);/,
    (match, funcName) =>
      `exports.activate = function(__incipitCommitCtx) { try { require('./webview/commit_message_bundle.js').activate(__incipitCommitCtx); } catch(e) { console.error('[incipit] CommitMsg init failed', e); } return ${funcName}(__incipitCommitCtx); };`,
  );
  assert.ok(!updated.includes('hunkwise_bundle'));
  assert.ok(updated.includes("require('./webview/commit_message_bundle.js').activate("));
  assert.ok(updated.includes('return activateFn(__incipitCommitCtx)'));
  ok('activate injection wraps commit-message only (exports.activate)');
}

{
  // Shape B: module.exports IIFE wrapper (Trae CN / modern Claude Code)
  let updated = 'module.exports = zve(kut);';
  updated = updated.replace(
    /module\.exports\s*=\s*([^;]+);/,
    (match, exportedVal) =>
      `module.exports = (function(__incipit_orig) { return Object.assign({}, __incipit_orig, { activate: function(__incipitCommitCtx) { try { require('./webview/commit_message_bundle.js').activate(__incipitCommitCtx); } catch(e) { console.error('[incipit] CommitMsg init failed', e); } return __incipit_orig.activate ? __incipit_orig.activate(__incipitCommitCtx) : undefined; } }); })(${exportedVal});`,
  );
  assert.ok(!updated.includes('hunkwise'));
  assert.ok(updated.includes("require('./webview/commit_message_bundle.js').activate(__incipitCommitCtx)"));
  assert.ok(updated.includes('__incipit_orig.activate(__incipitCommitCtx)'));
  ok('activate injection wraps commit-message on module.exports Trae shape');
}

{
  // Legacy strip: old hunkwise try/catch + thin wrapper are removed.
  // Mirrors the strip block in src/install.js patchExtensionJs.
  let dirty =
    "exports.activate = function(__hunkwiseCtx) { try { require('./webview/hunkwise_bundle.js').activate(__hunkwiseCtx); } catch(e) { console.error('[incipit] Hunkwise init failed', e); } return activateFn(__hunkwiseCtx); };";
  const HUNKWISE_TRY_LOOSE =
    /\s*try \{\s*require\(['"]\.\/webview\/hunkwise_bundle\.js['"]\)\.activate\(([A-Za-z_$][\w$]*)\);\s*\} catch\(e\) \{[^}]*Hunkwise[^}]*\}\s*/g;
  dirty = dirty.replace(HUNKWISE_TRY_LOOSE, ' ');
  const WRAP_EXPORTS =
    /exports\.activate\s*=\s*function\s*\(__hunkwiseCtx\)\s*\{\s*return\s+([A-Za-z_$][\w$]*)\(__hunkwiseCtx\);\s*\};/;
  assert.ok(!dirty.includes('hunkwise_bundle'), 'legacy hunkwise try/catch stripped');
  assert.ok(WRAP_EXPORTS.test(dirty), 'thin __hunkwiseCtx wrapper remains for unwrap');
  dirty = dirty.replace(WRAP_EXPORTS, 'exports.activate = $1;');
  assert.strictEqual(dirty.trim(), 'exports.activate = activateFn;');
  // After strip, commit-message reinjects on the bare assignment.
  dirty = dirty.replace(
    /exports\.activate\s*=\s*([A-Za-z_$][\w$]*);/,
    (match, funcName) =>
      `exports.activate = function(__incipitCommitCtx) { try { require('./webview/commit_message_bundle.js').activate(__incipitCommitCtx); } catch(e) { console.error('[incipit] CommitMsg init failed', e); } return ${funcName}(__incipitCommitCtx); };`,
  );
  assert.ok(dirty.includes("require('./webview/commit_message_bundle.js').activate("));
  ok('legacy hunkwise wrappers strip cleanly; commit-message reinjects');
}

// --- package.json merge is idempotent --------------------------------------

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-cm-'));
  const pkgPath = path.join(tmp, 'package.json');
  const base = {
    name: 'claude-code',
    contributes: {
      commands: [{ command: 'claude-vscode.focus', title: 'Focus' }],
      menus: {
        'editor/title': [{ command: 'claude-vscode.focus', group: 'navigation' }],
      },
    },
  };
  fs.writeFileSync(pkgPath, JSON.stringify(base, null, 2));

  function mergeOnce() {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const contrib = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'data', 'commit_message_package.json'), 'utf8'),
    );
    if (!pkg.contributes) pkg.contributes = {};
    for (const key of Object.keys(contrib.contributes)) {
      if (!pkg.contributes[key]) {
        pkg.contributes[key] = Array.isArray(contrib.contributes[key]) ? [] : {};
      }
      if (Array.isArray(contrib.contributes[key])) {
        const existing = pkg.contributes[key].map(i => i.command || i.id);
        for (const item of contrib.contributes[key]) {
          const id = item.command || item.id;
          if (!existing.includes(id)) pkg.contributes[key].push(Object.assign({}, item));
        }
      } else if (typeof contrib.contributes[key] === 'object') {
        for (const menuKey of Object.keys(contrib.contributes[key])) {
          if (!pkg.contributes[key][menuKey]) pkg.contributes[key][menuKey] = [];
          const existingMenu = pkg.contributes[key][menuKey].map(i => i.command);
          for (const item of contrib.contributes[key][menuKey]) {
            if (!existingMenu.includes(item.command)) {
              pkg.contributes[key][menuKey].push(Object.assign({}, item));
            }
          }
        }
      }
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    return pkg;
  }

  const once = mergeOnce();
  const twice = mergeOnce();
  const cmds = twice.contributes.commands.filter(c => c.command === T.COMMAND_ID);
  assert.strictEqual(cmds.length, 1, 'command not duplicated');
  const scm = twice.contributes.menus['scm/title'].filter(m => m.command === T.COMMAND_ID);
  assert.strictEqual(scm.length, 1, 'scm menu not duplicated');
  assert.ok(once.contributes.commands.some(c => c.command === 'claude-vscode.focus'));
  ok('package.json merge is idempotent and preserves stock commands');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { }
}

// --- host-badge exports completeClaudeText ---------------------------------

{
  const host = require(path.join(ROOT, 'data', 'host-badge.cjs'));
  assert.strictEqual(typeof host.attachComm, 'function');
  assert.strictEqual(typeof host.completeClaudeText, 'function');
  ok('host-badge exports completeClaudeText');
}

console.log('\n' + passed + ' passed');
