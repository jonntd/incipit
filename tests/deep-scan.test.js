'use strict';

// Regression coverage for the deep-scan engine (src/deep-scan.js).
//
// Contract asserted (the design we agreed on):
//   · finds <...>/extensions/anthropic.claude-code-* at any sane depth,
//     labeled by host, streamed via onResult
//   · DISCOVERY only — pure data out; nothing applied (UI not exercised)
//   · knownKeys suppresses already-known installs (scan shows only NEW)
//   · prune set + depth cap actually bound the walk (node_modules etc.
//     and too-deep installs are NOT found)
//   · always terminates: cancel returns promptly with cancelled=true and
//     a partial/no result — never hangs
//   · dedup: the same install reached twice yields one result
//   · a non-editor tree yields nothing and never throws

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deepScan, defaultDeepScanRoots, canonicalKey } = require('../src/deep-scan');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-ds-')); }

// Create <root>/<...segments>/extensions/anthropic.claude-code-<v> .
function plantInstall(root, segments, version = '2.1.143') {
  const ext = path.join(root, ...segments, 'extensions', `anthropic.claude-code-${version}-win32-x64`);
  fs.mkdirSync(ext, { recursive: true });
  return path.join(root, ...segments, 'extensions');
}

(async function run() {
  // ---- finds a nested profile install; streams; correct shape ----
  await (async () => {
    const root = tmp();
    const extDir = plantInstall(root, ['work', 'editors', '.vscode']);
    const streamed = [];
    const r = await deepScan({
      roots: [{ dir: root, maxDepth: 8 }],
      onResult: x => streamed.push(x),
    });
    assert.strictEqual(r.results.length, 1, 'exactly one install found');
    const hit = r.results[0];
    assert.strictEqual(path.resolve(hit.extensionsDir), path.resolve(extDir));
    assert.strictEqual(hit.label, 'VS Code', '.vscode parent → VS Code label');
    assert.ok(/2\.1\.143-/.test(hit.latestExtName), 'reports the extension');
    assert.strictEqual(streamed.length, 1, 'onResult streamed the hit');
    assert.strictEqual(r.cancelled, false);
    assert.strictEqual(r.timedOut, false);
    ok('finds nested profile install, streamed, labeled, shaped');
  })();

  // ---- knownKeys suppresses an already-known install ----
  await (async () => {
    const root = tmp();
    const extDir = plantInstall(root, ['.cursor']);
    const known = new Set([canonicalKey(extDir)]);
    const r = await deepScan({ roots: [{ dir: root, maxDepth: 6 }], knownKeys: known });
    assert.strictEqual(r.results.length, 0, 'known install must be suppressed');
    ok('knownKeys suppresses already-known install');
  })();

  // ---- prune: install under node_modules is NOT found ----
  await (async () => {
    const root = tmp();
    plantInstall(root, ['proj', 'node_modules', 'pkg', '.vscode']);
    const r = await deepScan({ roots: [{ dir: root, maxDepth: 12 }] });
    assert.strictEqual(r.results.length, 0, 'node_modules subtree must be pruned');
    ok('prune set bounds the walk (node_modules skipped)');
  })();

  // ---- depth cap: too-deep install is NOT found, shallow IS ----
  await (async () => {
    const root = tmp();
    plantInstall(root, ['a', 'b', 'c', 'd', '.vscode']); // .vscode at depth 5
    const shallow = await deepScan({ roots: [{ dir: root, maxDepth: 12 }] });
    assert.strictEqual(shallow.results.length, 1, 'reachable within a generous cap');
    const capped = await deepScan({ roots: [{ dir: root, maxDepth: 2 }] });
    assert.strictEqual(capped.results.length, 0, 'depth cap must stop the descent');
    ok('depth cap bounds the walk');
  })();

  // ---- cancel: returns promptly, cancelled=true, never hangs ----
  await (async () => {
    const root = tmp();
    plantInstall(root, ['x', 'y', '.vscode']);
    const t0 = Date.now();
    const r = await deepScan({
      roots: [{ dir: root, maxDepth: 10 }],
      isCancelled: () => true,
    });
    assert.strictEqual(r.cancelled, true, 'cancelled flag set');
    assert.ok(Date.now() - t0 < 2000, 'cancel returns promptly (no hang)');
    ok('cancel signal terminates promptly with cancelled=true');
  })();

  // ---- multiple distinct hosts in one scan ----
  await (async () => {
    const root = tmp();
    plantInstall(root, ['.vscode']);
    plantInstall(root, ['nested', '.kiro']);
    const r = await deepScan({ roots: [{ dir: root, maxDepth: 6 }] });
    const labels = r.results.map(x => x.label).sort();
    assert.strictEqual(r.results.length, 2, 'both installs found');
    assert.deepStrictEqual(labels, ['Kiro', 'VS Code'], 'each labeled by host');
    ok('multiple distinct hosts surface together, each labeled');
  })();

  // ---- dedup: same root via two seeds → one result ----
  await (async () => {
    const root = tmp();
    plantInstall(root, ['.vscode']);
    const r = await deepScan({
      roots: [{ dir: root, maxDepth: 6 }, { dir: root, maxDepth: 6 }],
    });
    assert.strictEqual(r.results.length, 1, 'overlapping seeds must dedup to one');
    ok('dedup: an install reached twice yields one result');
  })();

  // ---- non-editor tree → nothing, no throw ----
  await (async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.js'), '//');
    const r = await deepScan({ roots: [{ dir: root, maxDepth: 8 }] });
    assert.strictEqual(r.results.length, 0);
    assert.strictEqual(r.timedOut, false);
    ok('non-editor tree → no results, no throw');
  })();

  // ---- defaultDeepScanRoots smoke ----
  await (async () => {
    const roots = defaultDeepScanRoots();
    assert.ok(Array.isArray(roots) && roots.length >= 1, 'returns a non-empty seed list');
    for (const s of roots) {
      assert.ok(typeof s.dir === 'string' && s.dir, 'seed has a dir');
      assert.ok(Number.isInteger(s.maxDepth) && s.maxDepth > 0, 'seed has a positive maxDepth');
      assert.ok(fs.existsSync(s.dir), 'seed dir exists (non-existing roots are dropped)');
    }
    const home = process.platform === 'win32'
      ? (process.env.USERPROFILE || os.homedir())
      : os.homedir();
    assert.ok(
      roots.some(s => canonicalKey(s.dir) === canonicalKey(home)),
      'home is among the seed roots',
    );
    ok('defaultDeepScanRoots: valid existing seeds incl. home');
  })();

  console.log('\ndeep-scan: ' + passed + ' checks PASSED');
})().catch(err => { console.error(err); process.exit(1); });
