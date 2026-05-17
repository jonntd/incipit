'use strict';

// Bounded, time-boxed, cancelable filesystem scan for Claude Code
// installs (`<...>/extensions/anthropic.claude-code-*`).
//
// Design contract (agreed with the user):
//   - DISCOVERY is broad; SELECTION stays explicit. The engine only finds
//     and streams candidates — it never picks or applies. The caller
//     presents results for an explicit multi-select. This is what keeps a
//     broad scan inside the project's fail-closed / never-silently-pick
//     red line.
//   - High performance via aggressive pruning + a tight per-directory cost
//     (one readdir; one extra peek only when an `extensions/` child
//     exists) + a depth cap per seed + bounded async concurrency.
//   - Always terminates: a hard wall-clock deadline AND a cancel signal,
//     both checked in the walk loop. On either, return whatever was found
//     so far with a flag — never hang.
//   - Streams: `onResult` fires the moment a target is found and `onProgress`
//     ticks so the UI can show live, scrolling progress and let the user
//     stop early once they see what they want.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanClaudeCodeExtensions,
  describeExtensionsDir,
} = require('./host-detect');

// Directory names we never descend into: heavy, irrelevant, or
// cycle-prone. This prune set is THE performance lever — it removes the
// overwhelming majority of directories a broad walk would otherwise visit.
// `extensions` is deliberately NOT here: it is special-cased (harvested,
// then not descended into).
const PRUNE = new Set([
  'node_modules', '.git', '.hg', '.svn', '.cache', 'cache', 'caches',
  '$recycle.bin', 'system volume information', '$windows.~bs', '$windows.~ws',
  '$winreagent', '$sysreset', 'windows', 'winsxs', 'perflogs', 'recovery',
  'msocache', 'documents and settings', 'application data', 'appdata',
  'locallow', 'onedrivetemp', 'temp', 'tmp', '__pycache__', '.venv', 'venv',
  '.tox', 'site-packages', '.gradle', '.m2', '.nuget', '.cargo', '.rustup',
  '.pnpm-store', '.yarn', '.npm', 'dist', 'build', 'out', 'target', '.next',
  '.nuxt', 'coverage', '.terraform', 'vendor', '.idea', '.vs',
]);

const DEFAULT_DEADLINE_MS = 60_000;   // user accepts up to ~1 min
const CONCURRENCY = 32;

function canonicalKey(p) {
  let resolved = p;
  try { resolved = fs.realpathSync.native(p); } catch (_) {
    try { resolved = fs.realpathSync(p); } catch (_) { resolved = path.resolve(p); }
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function existingDir(p) {
  try { return fs.statSync(p).isDirectory() ? p : null; } catch (_) { return null; }
}

function pushRoot(out, seen, dir, maxDepth) {
  if (!dir) return;
  const real = existingDir(dir);
  if (!real) return;
  const key = canonicalKey(dir);
  const prev = seen.get(key);
  if (prev !== undefined) {
    // Keep the deepest budget if the same real root is reached two ways.
    if (maxDepth > out[prev].maxDepth) out[prev].maxDepth = maxDepth;
    return;
  }
  seen.set(key, out.length);
  out.push({ dir, maxDepth });
}

// Seed roots for the manage-screen "deep scan" action (no user-picked
// start). Home + the OS install/app-data roots + every OTHER fixed drive
// root. The system drive root is intentionally NOT walked whole (covered
// by the home + Program Files seeds at sane depth); a full C:\ walk is the
// one thing too slow even with pruning.
function defaultDeepScanRoots() {
  const out = [];
  const seen = new Map();
  const home = os.homedir();
  pushRoot(out, seen, home, 6);

  if (process.platform === 'win32') {
    const env = process.env;
    pushRoot(out, seen, env.APPDATA, 4);
    pushRoot(out, seen, env.LOCALAPPDATA, 4);
    if (env.LOCALAPPDATA) pushRoot(out, seen, path.join(env.LOCALAPPDATA, 'Programs'), 6);
    pushRoot(out, seen, env.ProgramFiles, 6);
    pushRoot(out, seen, env['ProgramFiles(x86)'], 6);
    pushRoot(out, seen, env.ProgramW6432, 6);

    const sysDrive = (env.SystemDrive || 'C:').toUpperCase().replace(/[^A-Z:]/g, '');
    for (let c = 67 /* C */; c <= 90 /* Z */; c++) {
      const letter = String.fromCharCode(c);
      const driveRoot = `${letter}:\\`;
      if (`${letter}:` === sysDrive) continue;            // skip whole system drive
      if (!existingDir(driveRoot)) continue;
      pushRoot(out, seen, driveRoot, 7);
    }
    return out;
  }

  // posix
  pushRoot(out, seen, path.join(home, 'Applications'), 4);
  for (const d of ['/Applications', '/usr/share', '/usr/lib', '/opt', '/snap']) {
    pushRoot(out, seen, d, 5);
  }
  return out;
}

// Walk one seed root. Bounded-concurrency BFS so shallow profile dirs
// (the common case) surface first — good for streaming + early cancel.
// The pool tracks in-flight work: a slot opening with an empty queue does
// NOT end the walk while other directories are still being read (they may
// still enqueue children) — only "queue empty AND nothing in flight" ends.
async function walkRoot(seed, ctx) {
  const queue = [{ dir: seed.dir, depth: 0 }];
  ctx.visited.add(canonicalKey(seed.dir));

  const processDir = async ({ dir, depth }) => {
    if (ctx.stop()) return;
    ctx.stats.scanned += 1;
    ctx.stats.current = dir;
    ctx.onTick();

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) { return; }

    const subdirs = [];
    let extensionsChild = null;
    for (const e of entries) {
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        isDir = Boolean(existingDir(path.join(dir, e.name)));
      }
      if (!isDir) continue;
      if (e.name.toLowerCase() === 'extensions') extensionsChild = path.join(dir, e.name);
      subdirs.push(e.name);
    }

    if (extensionsChild) {
      const exts = scanClaudeCodeExtensions(extensionsChild);
      if (exts.length) {
        const key = canonicalKey(extensionsChild);
        if (!ctx.knownKeys.has(key) && !ctx.foundKeys.has(key)) {
          ctx.foundKeys.add(key);
          const latest = exts[exts.length - 1];
          const desc = describeExtensionsDir(extensionsChild);
          ctx.stats.found += 1;
          ctx.onResult({
            key,
            extensionsDir: extensionsChild,
            settingsPath: desc.settingsPath || null,
            label: desc.label,
            latestVersion: latest.version.join('.') || 'unknown',
            latestExtName: latest.name,
            latestExtPath: latest.path,
          });
          ctx.onTick();
        }
      }
    }

    if (depth >= seed.maxDepth) return;
    for (const name of subdirs) {
      const lower = name.toLowerCase();
      if (lower === 'extensions') continue;       // harvested, never descend
      if (PRUNE.has(lower)) continue;
      const child = path.join(dir, name);
      const ckey = canonicalKey(child);
      if (ctx.visited.has(ckey)) continue;        // realpath cycle / cross-link guard
      ctx.visited.add(ckey);
      queue.push({ dir: child, depth: depth + 1 });
    }
  };

  await new Promise(resolve => {
    let active = 0;
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const pump = () => {
      if (settled) return;
      if (ctx.stop()) { if (active === 0) finish(); return; }
      while (active < CONCURRENCY && queue.length) {
        const item = queue.shift();
        active += 1;
        processDir(item).catch(() => {}).then(() => {
          active -= 1;
          pump();
        });
      }
      if (active === 0 && queue.length === 0) finish();
    };
    pump();
  });
}

// roots: [{dir, maxDepth}]. knownKeys: Set<canonicalKey> already-known
// targets to suppress (so the scan only surfaces NEW installs).
async function deepScan({
  roots,
  deadlineMs = DEFAULT_DEADLINE_MS,
  isCancelled = () => false,
  onProgress = () => {},
  onResult = () => {},
  knownKeys = new Set(),
} = {}) {
  const start = Date.now();
  const deadline = start + Math.max(1000, deadlineMs);
  const stats = { scanned: 0, found: 0, current: '', elapsedMs: 0 };
  const results = [];

  const ctx = {
    visited: new Set(),
    foundKeys: new Set(),
    knownKeys,
    stats,
    stop: () => Date.now() >= deadline || isCancelled(),
    onTick: () => { stats.elapsedMs = Date.now() - start; onProgress(stats); },
    onResult: r => { results.push(r); onResult(r); },
  };

  for (const seed of roots) {
    if (ctx.stop()) break;
    try { await walkRoot(seed, ctx); } catch (_) { /* a bad root never aborts the rest */ }
  }

  stats.elapsedMs = Date.now() - start;
  const cancelled = isCancelled();
  return {
    results,
    scannedDirs: stats.scanned,
    elapsedMs: stats.elapsedMs,
    cancelled,
    timedOut: !cancelled && Date.now() >= deadline,
  };
}

module.exports = { deepScan, defaultDeepScanRoots, canonicalKey };
