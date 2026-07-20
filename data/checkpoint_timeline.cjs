'use strict';

/**
 * Augment-style checkpoint timeline for Session Edits.
 *
 * Per-session index: ~/.incipit/checkpoint-timeline-v1/<sessionId>.json
 * Content blobs:     ~/.incipit/checkpoint-timeline-v1/<sessionId>/blobs/<sha256>
 *
 * Semantics (match Augment AggregateCheckpointManager):
 *   - Every agent write and tracked user save appends a checkpoint for that path.
 *   - List = aggregate(baselineTimestamp → now): original@baseline vs current disk.
 *   - Keep All  = raise baselineTimestamp past last checkpoint (no disk IO).
 *   - Discard   = restore each path to state@baseline (or delete if created after).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const ROOT_DIR = path.join(os.homedir(), '.incipit', 'checkpoint-timeline-v1');
const MAX_INLINE_BYTES = 256 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;

const SOURCE = Object.freeze({
  AGENT: 'agent',
  USER: 'user',
  REVERT: 'revert',
});

// sessionId -> timeline object (mutable, dirty-tracked)
const cache = new Map();
// sessionId|fileKey|baseline|diskKey -> {added,removed,statsOk}  (avoid re-LCS)
const statsCache = new Map();

function safeSessionId(sessionId) {
  return String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function sessionDir(sessionId) {
  const id = safeSessionId(sessionId);
  if (!id) throw new Error('Missing checkpoint timeline session id.');
  return path.join(ROOT_DIR, id);
}

function indexPath(sessionId) {
  return path.join(sessionDir(sessionId), 'index.json');
}

function blobsDir(sessionId) {
  return path.join(sessionDir(sessionId), 'blobs');
}

function emptyTimeline(sessionId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: safeSessionId(sessionId),
    baselineTimestamp: 0,
    files: Object.create(null),
    dirty: false,
  };
}

function loadTimeline(sessionId) {
  const id = safeSessionId(sessionId);
  if (!id) return emptyTimeline('');
  if (cache.has(id)) return cache.get(id);
  let tl = null;
  try {
    const p = indexPath(id);
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && parsed.schemaVersion === SCHEMA_VERSION && parsed.sessionId === id) {
        tl = {
          schemaVersion: SCHEMA_VERSION,
          sessionId: id,
          baselineTimestamp: Number.isFinite(parsed.baselineTimestamp) ? parsed.baselineTimestamp : 0,
          files: parsed.files && typeof parsed.files === 'object' ? parsed.files : Object.create(null),
          dirty: false,
        };
      }
    }
  } catch (_) {
    tl = null;
  }
  if (!tl) tl = emptyTimeline(id);
  cache.set(id, tl);
  return tl;
}

function saveTimeline(tl) {
  if (!tl || !tl.sessionId || !tl.dirty) return;
  const id = tl.sessionId;
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = indexPath(id);
  const tmp = finalPath + '.tmp-' + process.pid + '-' + Date.now();
  const serializable = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: id,
    baselineTimestamp: tl.baselineTimestamp || 0,
    updatedAt: Date.now(),
    files: tl.files || {},
  };
  fs.writeFileSync(tmp, JSON.stringify(serializable));
  fs.renameSync(tmp, finalPath);
  tl.dirty = false;
}

function markDirty(tl) {
  if (tl) tl.dirty = true;
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

function writeBlob(sessionId, text) {
  const body = String(text == null ? '' : text);
  const hash = hashText(body);
  const dir = blobsDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, hash);
  if (!fs.existsSync(p)) {
    if (Buffer.byteLength(body, 'utf8') > MAX_BLOB_BYTES) {
      // Store truncated marker — still reversible for small head; large files
      // fall back to "unavailable" on restore if full content missing.
      const note = body.slice(0, MAX_BLOB_BYTES);
      fs.writeFileSync(p, note, 'utf8');
    } else {
      fs.writeFileSync(p, body, 'utf8');
    }
  }
  return hash;
}

function readBlob(sessionId, hash) {
  if (!hash || typeof hash !== 'string') return null;
  if (!/^[a-f0-9]{64}$/i.test(hash)) return null;
  const p = path.join(blobsDir(sessionId), hash);
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (_) {
    return null;
  }
}

function fileKey(absPath) {
  return String(absPath || '').replace(/\\/g, '/');
}

function ensureFileRec(tl, absPath) {
  const key = fileKey(absPath);
  if (!tl.files[key] || typeof tl.files[key] !== 'object') {
    tl.files[key] = {
      path: absPath,
      checkpoints: [],
    };
    markDirty(tl);
  }
  return tl.files[key];
}

function nowTs() {
  return Date.now();
}

/**
 * Append a checkpoint for absPath after a mutation.
 * @param {string} sessionId
 * @param {string} absPath
 * @param {{
 *   source: 'agent'|'user'|'revert',
 *   afterText: string|null,   // null = deleted
 *   beforeText?: string|null, // optional explicit before
 *   tool?: string,
 *   turnKey?: string,
 *   timestamp?: number,
 * }} meta
 */
function recordCheckpoint(sessionId, absPath, meta) {
  if (!sessionId || !absPath || !meta) return null;
  const tl = loadTimeline(sessionId);
  const rec = ensureFileRec(tl, absPath);
  // Ensure monotonic timestamps so new edits always sit after baseline / prior cps.
  let ts = Number.isFinite(meta.timestamp) ? meta.timestamp : nowTs();
  const floor = Math.max(tl.baselineTimestamp || 0, maxCheckpointTimestamp(tl));
  if (ts <= floor) ts = floor + 1;
  const afterMissing = meta.afterText === null || meta.afterText === undefined;
  const afterText = afterMissing ? null : String(meta.afterText);
  const afterHash = afterText === null ? null : writeBlob(sessionId, afterText);

  let beforeHash = undefined;
  if (Object.prototype.hasOwnProperty.call(meta, 'beforeText')) {
    if (meta.beforeText === null || meta.beforeText === undefined) beforeHash = null;
    else beforeHash = writeBlob(sessionId, String(meta.beforeText));
  } else {
    // Chain: previous after becomes this before.
    const prev = rec.checkpoints.length ? rec.checkpoints[rec.checkpoints.length - 1] : null;
    beforeHash = prev ? (prev.afterHash === undefined ? null : prev.afterHash) : null;
  }

  // No-op save: same content as previous afterHash — skip (unless keep/revert).
  const toolName = typeof meta.tool === 'string' ? meta.tool : '';
  const prevCp = rec.checkpoints.length ? rec.checkpoints[rec.checkpoints.length - 1] : null;
  if (prevCp && toolName !== 'keep' && toolName !== 'discard' &&
      prevCp.afterHash === afterHash &&
      (prevCp.deleted === true) === (afterHash === null)) {
    return prevCp;
  }

  const cp = {
    ts,
    source: meta.source || SOURCE.AGENT,
    beforeHash: beforeHash === undefined ? null : beforeHash,
    afterHash,
    deleted: afterHash === null,
    tool: toolName,
    turnKey: typeof meta.turnKey === 'string' ? meta.turnKey : '',
  };
  rec.checkpoints.push(cp);
  // A real mutation after Keep re-opens the pending window for this path.
  if (cp.tool !== 'keep' && Number.isFinite(rec.acceptedAt)) {
    delete rec.acceptedAt;
  }
  // Cap history per file to keep index small (Augment shards grow too; 200 is plenty).
  if (rec.checkpoints.length > 200) {
    rec.checkpoints = rec.checkpoints.slice(-200);
  }
  markDirty(tl);
  saveTimeline(tl);
  invalidateStatsCache(sessionId, absPath);
  return cp;
}

function recordAgentEdit(sessionId, absPath, opts = {}) {
  let afterText = opts.afterText;
  if (afterText === undefined) {
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        const st = fs.statSync(absPath);
        if (st.size <= MAX_BLOB_BYTES) afterText = fs.readFileSync(absPath, 'utf8');
        else afterText = fs.readFileSync(absPath, 'utf8'); // writeBlob truncates
      } else {
        afterText = null;
      }
    } catch (_) {
      afterText = null;
    }
  }
  let beforeText = opts.beforeText;
  if (beforeText === undefined && opts.beforePath && fs.existsSync(opts.beforePath)) {
    try {
      beforeText = fs.readFileSync(opts.beforePath, 'utf8');
    } catch (_) {
      beforeText = undefined;
    }
  }
  return recordCheckpoint(sessionId, absPath, {
    source: SOURCE.AGENT,
    afterText,
    beforeText,
    tool: opts.tool,
    turnKey: opts.turnKey,
    timestamp: opts.timestamp,
  });
}

function recordUserEdit(sessionId, absPath, afterText) {
  return recordCheckpoint(sessionId, absPath, {
    source: SOURCE.USER,
    afterText: afterText === undefined ? null : afterText,
  });
}

function contentAtOrBefore(sessionId, rec, timestamp) {
  if (!rec || !Array.isArray(rec.checkpoints) || !rec.checkpoints.length) {
    return { kind: 'unknown', text: null, hash: null, ts: 0 };
  }
  // Find latest checkpoint with ts <= timestamp. If timestamp is 0 and no
  // checkpoint at/before 0, use the beforeHash of the first checkpoint after.
  let best = null;
  for (const cp of rec.checkpoints) {
    if (!cp || !Number.isFinite(cp.ts)) continue;
    if (cp.ts <= timestamp) best = cp;
  }
  if (best) {
    if (best.deleted || best.afterHash === null) {
      return { kind: 'missing', text: null, hash: null, ts: best.ts };
    }
    const text = readBlob(sessionId, best.afterHash);
    return {
      kind: text == null ? 'unavailable' : 'content',
      text,
      hash: best.afterHash,
      ts: best.ts,
    };
  }
  // No checkpoint at/before baseline — state before first recorded edit.
  const first = rec.checkpoints[0];
  if (first && first.beforeHash === null) {
    // File was created by first checkpoint after baseline.
    return { kind: 'missing', text: null, hash: null, ts: 0 };
  }
  if (first && first.beforeHash) {
    const text = readBlob(sessionId, first.beforeHash);
    return {
      kind: text == null ? 'unavailable' : 'content',
      text,
      hash: first.beforeHash,
      ts: 0,
    };
  }
  return { kind: 'unknown', text: null, hash: null, ts: 0 };
}

function latestContent(sessionId, rec) {
  if (!rec || !rec.checkpoints || !rec.checkpoints.length) {
    return { kind: 'unknown', text: null, hash: null, ts: 0 };
  }
  const last = rec.checkpoints[rec.checkpoints.length - 1];
  if (last.deleted || last.afterHash === null) {
    return { kind: 'missing', text: null, hash: null, ts: last.ts };
  }
  const text = readBlob(sessionId, last.afterHash);
  return {
    kind: text == null ? 'unavailable' : 'content',
    text,
    hash: last.afterHash,
    ts: last.ts,
  };
}

function readDiskText(absPath) {
  try {
    if (!fs.existsSync(absPath)) return { kind: 'missing', text: null };
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { kind: 'unavailable', text: null };
    if (st.size > MAX_BLOB_BYTES * 2) {
      // Still try — line stats may skip
    }
    return { kind: 'content', text: fs.readFileSync(absPath, 'utf8') };
  } catch (_) {
    return { kind: 'unavailable', text: null };
  }
}

function diskFingerprint(absPath) {
  try {
    if (!fs.existsSync(absPath)) return 'missing';
    const st = fs.statSync(absPath);
    if (!st.isFile()) return 'not-file';
    return st.size + ':' + Math.round(st.mtimeMs);
  } catch (_) {
    return 'err';
  }
}

function statsCacheKey(sessionId, absPath, baseline, baseHash, diskKey) {
  return [
    safeSessionId(sessionId),
    fileKey(absPath),
    baseline || 0,
    baseHash || '',
    diskKey || '',
  ].join('|');
}

function invalidateStatsCache(sessionId, absPath) {
  const prefix = safeSessionId(sessionId) + '|' + (absPath ? fileKey(absPath) : '');
  for (const k of statsCache.keys()) {
    if (k.startsWith(prefix) || (!absPath && k.startsWith(safeSessionId(sessionId) + '|'))) {
      statsCache.delete(k);
    }
  }
}


function countTextLines(text) {
  return text === '' ? 0 : String(text).split('\n').length;
}

function lineDiffStats(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const m = Math.max(0, endA - start + 1);
  const n = Math.max(0, endB - start + 1);
  if (m === 0 && n === 0) return { added: 0, removed: 0 };
  if (m === 0) return { added: n, removed: 0 };
  if (n === 0) return { added: 0, removed: m };
  // Multiset LCS approx for large middles (same as host-badge fallback spirit).
  if (m * n > 400 * 1000) {
    const counts = new Map();
    for (let i = start; i <= endA; i++) counts.set(a[i], (counts.get(a[i]) || 0) + 1);
    let common = 0;
    for (let i = start; i <= endB; i++) {
      const c = counts.get(b[i]) || 0;
      if (!c) continue;
      common++;
      if (c === 1) counts.delete(b[i]);
      else counts.set(b[i], c - 1);
    }
    return {
      added: Math.max(0, endB - start + 1 - common),
      removed: Math.max(0, endA - start + 1 - common),
    };
  }
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[start + i - 1] === b[start + j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = curr[j - 1] > prev[j] ? curr[j - 1] : prev[j];
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  const lcs = prev[n];
  return { added: n - lcs, removed: m - lcs };
}

function pathHasCheckpointsAfterBaseline(rec, baseline) {
  if (!rec || !Array.isArray(rec.checkpoints)) return false;
  return rec.checkpoints.some(cp => cp && Number.isFinite(cp.ts) && cp.ts > baseline);
}

function maxCheckpointTimestamp(tl) {
  let max = 0;
  if (!tl || !tl.files) return max;
  for (const rec of Object.values(tl.files)) {
    if (!rec || !Array.isArray(rec.checkpoints)) continue;
    for (const cp of rec.checkpoints) {
      if (cp && Number.isFinite(cp.ts) && cp.ts > max) max = cp.ts;
    }
  }
  return max;
}

/**
 * Pending files for Edits list (Augment getAggregateCheckpoint).
 */
function listPending(sessionId, opts = {}) {
  const tl = loadTimeline(sessionId);
  const baseline = Number.isFinite(opts.baselineTimestamp)
    ? opts.baselineTimestamp
    : (tl.baselineTimestamp || 0);
  const files = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let hasLineStats = false;

  for (const rec of Object.values(tl.files || {})) {
    if (!rec || !pathHasCheckpointsAfterBaseline(rec, baseline)) continue;
    const absPath = rec.path;
    const base = contentAtOrBefore(sessionId, rec, baseline);
    // Lightweight disk probe first (mtime/size) so cache hits avoid reading file text.
    const diskKey = diskFingerprint(absPath);
    const cacheKey = statsCacheKey(sessionId, absPath, baseline, base.hash, diskKey);
    let added = 0;
    let removed = 0;
    let statsOk = false;
    let isCreated = base.kind === 'missing';
    let isDeleted = diskKey === 'missing' && !isCreated;
    let status = base.kind === 'unavailable' ? 'unavailable' : 'pending';
    let diskKind = diskKey === 'missing' ? 'missing' : (diskKey === 'not-file' || diskKey === 'err' ? 'unavailable' : 'content');

    const cached = statsCache.get(cacheKey);
    if (cached && typeof cached === 'object') {
      added = cached.added || 0;
      removed = cached.removed || 0;
      statsOk = cached.statsOk === true;
      isCreated = cached.isCreated === true;
      isDeleted = cached.isDeleted === true;
      status = cached.status || status;
      if (!isCreated && !isDeleted && added === 0 && removed === 0 && statsOk) continue;
      if (isCreated && diskKind === 'missing') continue;
      if (base.kind === 'missing' && diskKind === 'missing') continue;
    } else {
      // Cache miss: read disk once and compute.
      const disk = readDiskText(absPath);
      diskKind = disk.kind;
      isCreated = base.kind === 'missing';
      isDeleted = disk.kind === 'missing' && !isCreated;
      if (isCreated && disk.kind === 'content') {
        added = countTextLines(disk.text);
        removed = 0;
        statsOk = true;
      } else if (isDeleted && base.kind === 'content') {
        added = 0;
        removed = countTextLines(base.text);
        statsOk = true;
      } else if (base.kind === 'content' && disk.kind === 'content') {
        if (base.hash && hashText(disk.text) === base.hash) {
          statsCache.set(cacheKey, {
            added: 0, removed: 0, statsOk: true,
            isCreated: false, isDeleted: false, status: 'pending',
          });
          continue;
        }
        const stats = lineDiffStats(base.text, disk.text);
        added = stats.added || 0;
        removed = stats.removed || 0;
        statsOk = true;
        if (added === 0 && removed === 0) {
          statsCache.set(cacheKey, {
            added: 0, removed: 0, statsOk: true,
            isCreated: false, isDeleted: false, status: 'pending',
          });
          continue;
        }
      } else if (base.kind === 'missing' && disk.kind === 'missing') {
        continue;
      }
      if (base.kind === 'unavailable' || disk.kind === 'unavailable') status = 'unavailable';
      statsCache.set(cacheKey, {
        added, removed, statsOk, isCreated, isDeleted, status,
      });
    }

    totalAdded += added;
    totalRemoved += removed;
    hasLineStats = hasLineStats || statsOk;

    const afterBaseline = (rec.checkpoints || []).filter(
      cp => cp && Number.isFinite(cp.ts) && cp.ts > baseline && cp.tool !== 'keep'
    );
    const hasAgent = afterBaseline.some(cp => cp.source === SOURCE.AGENT);
    const hasUser = afterBaseline.some(cp => cp.source === SOURCE.USER);
    let source = SOURCE.AGENT;
    if (hasAgent && hasUser) source = 'mixed';
    else if (hasUser && !hasAgent) source = SOURCE.USER;
    else if (hasAgent) source = SOURCE.AGENT;
    else if (afterBaseline.length && afterBaseline[afterBaseline.length - 1].source) {
      source = afterBaseline[afterBaseline.length - 1].source;
    }
    const last = afterBaseline.length
      ? afterBaseline[afterBaseline.length - 1]
      : rec.checkpoints[rec.checkpoints.length - 1];
    const displayPath = opts.displayPathFor
      ? (opts.displayPathFor(absPath) || absPath)
      : absPath;

    // Lightweight list row — no baselineText payload (diff loads via getDiffSides).
    files.push({
      id: 'tl:' + fileKey(absPath),
      filePath: absPath,
      displayPath,
      isCreated: isCreated && diskKind === 'content',
      isDeleted,
      added,
      removed,
      hasLineStats: statsOk,
      status,
      live: false,
      tool: last && last.tool ? last.tool : '',
      source,
      baselineMissing: isCreated,
      currentMissing: isDeleted,
    });
  }

  files.sort((a, b) => String(a.displayPath || a.filePath).localeCompare(String(b.displayPath || b.filePath)));
  return {
    empty: files.length === 0,
    files,
    totals: {
      files: files.length,
      added: totalAdded,
      removed: totalRemoved,
      hasLineStats,
      live: 0,
      created: files.filter(f => f.isCreated).length,
      deleted: files.filter(f => f.isDeleted).length,
    },
    baselineTimestamp: baseline,
    maxCheckpointTimestamp: maxCheckpointTimestamp(tl),
    engine: 'checkpoint-timeline',
  };
}

/** Keep All: raise baseline past every recorded checkpoint. */
function acceptAll(sessionId) {
  const tl = loadTimeline(sessionId);
  const maxTs = maxCheckpointTimestamp(tl);
  // Pending list uses ts > baseline, so baseline == last kept checkpoint is correct.
  const next = Math.max(maxTs, tl.baselineTimestamp || 0);
  tl.baselineTimestamp = next;
  // Global Keep supersedes per-file acceptedAt markers.
  for (const rec of Object.values(tl.files || {})) {
    if (rec && Number.isFinite(rec.acceptedAt)) delete rec.acceptedAt;
  }
  markDirty(tl);
  saveTimeline(tl);
  invalidateStatsCache(sessionId);
  return { ok: true, baselineTimestamp: next };
}

function acceptFile(sessionId, absPath) {
  const tl = loadTimeline(sessionId);
  const rec = tl.files[fileKey(absPath)];
  if (!rec || !rec.checkpoints || !rec.checkpoints.length) {
    return { ok: true, skipped: true };
  }
  // Per-file Keep (Augment-like): hide this path from the pending list without
  // raising the global baseline (other files stay pending). Snapshot current
  // disk so a later agent edit after this keep starts a clean window.
  const disk = readDiskText(absPath);
  const afterText = disk.kind === 'content' ? disk.text : null;
  const cp = recordCheckpoint(sessionId, absPath, {
    source: SOURCE.USER,
    afterText,
    tool: 'keep',
  });
  rec.acceptedAt = cp ? cp.ts : Date.now();
  markDirty(tl);
  saveTimeline(tl);
  invalidateStatsCache(sessionId, absPath);
  return { ok: true, acceptedAt: rec.acceptedAt };
}

// For listPending: also skip files with acceptedAt >= last change after baseline
function listPendingFiltered(sessionId, opts = {}) {
  const result = listPending(sessionId, opts);
  const tl = loadTimeline(sessionId);
  const baseline = result.baselineTimestamp || 0;
  result.files = result.files.filter(f => {
    const rec = tl.files[fileKey(f.filePath)];
    if (!rec || !Number.isFinite(rec.acceptedAt)) return true;
    // If accepted after baseline and no newer checkpoint after acceptedAt, hide.
    const newer = (rec.checkpoints || []).some(cp =>
      cp && Number.isFinite(cp.ts) && cp.ts > rec.acceptedAt && cp.ts > baseline && cp.tool !== 'keep'
    );
    return newer;
  });
  result.empty = result.files.length === 0;
  result.totals.files = result.files.length;
  let a = 0;
  let r = 0;
  let created = 0;
  let deleted = 0;
  for (const f of result.files) {
    a += f.added || 0;
    r += f.removed || 0;
    if (f.isCreated) created += 1;
    if (f.isDeleted) deleted += 1;
  }
  result.totals.added = a;
  result.totals.removed = r;
  result.totals.created = created;
  result.totals.deleted = deleted;
  return result;
}

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.incipit-cp-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text == null ? '' : text, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Revert one path (or all pending) to baseline state.
 */
function revertToBaseline(sessionId, absPath) {
  const tl = loadTimeline(sessionId);
  const baseline = tl.baselineTimestamp || 0;
  const keys = absPath
    ? [fileKey(absPath)]
    : Object.keys(tl.files || {}).filter(k => pathHasCheckpointsAfterBaseline(tl.files[k], baseline));

  const results = [];
  for (const key of keys) {
    const rec = tl.files[key];
    if (!rec) {
      results.push({ path: key, ok: false, error: 'not tracked' });
      continue;
    }
    if (!pathHasCheckpointsAfterBaseline(rec, baseline)) {
      results.push({ path: rec.path, ok: true, skipped: true });
      continue;
    }
    const base = contentAtOrBefore(sessionId, rec, baseline);
    const targetPath = rec.path;
    try {
      if (base.kind === 'missing') {
        if (fs.existsSync(targetPath)) {
          const lst = fs.lstatSync(targetPath);
          if (!lst.isFile() || lst.isSymbolicLink()) {
            throw new Error('Refusing to delete a non-regular file.');
          }
          fs.unlinkSync(targetPath);
        }
        recordCheckpoint(sessionId, targetPath, {
          source: SOURCE.REVERT,
          afterText: null,
          beforeText: undefined,
          tool: 'discard',
        });
        results.push({ path: targetPath, ok: true, status: 'deleted' });
      } else if (base.kind === 'content') {
        atomicWriteText(targetPath, base.text);
        recordCheckpoint(sessionId, targetPath, {
          source: SOURCE.REVERT,
          afterText: base.text,
          tool: 'discard',
        });
        results.push({ path: targetPath, ok: true, status: 'restored' });
      } else {
        results.push({ path: targetPath, ok: false, status: 'unavailable', error: 'baseline content missing' });
      }
    } catch (error) {
      results.push({
        path: targetPath,
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    }
  }
  return {
    ok: results.every(r => r.ok),
    results,
  };
}

function getDiffSides(sessionId, absPath) {
  const tl = loadTimeline(sessionId);
  const rec = tl.files[fileKey(absPath)];
  if (!rec) return null;
  const baseline = tl.baselineTimestamp || 0;
  const base = contentAtOrBefore(sessionId, rec, baseline);
  const disk = readDiskText(absPath);
  return {
    path: absPath,
    baseline,
    left: base.kind === 'content' ? base.text : '',
    leftMissing: base.kind === 'missing',
    right: disk.kind === 'content' ? disk.text : '',
    rightMissing: disk.kind === 'missing',
    leftUnavailable: base.kind === 'unavailable',
    rightUnavailable: disk.kind === 'unavailable',
  };
}

function isPathTracked(sessionId, absPath) {
  const tl = loadTimeline(sessionId);
  const rec = tl.files[fileKey(absPath)];
  if (!rec) return false;
  return pathHasCheckpointsAfterBaseline(rec, tl.baselineTimestamp || 0)
    || (rec.checkpoints && rec.checkpoints.length > 0);
}

function getBaselineTimestamp(sessionId) {
  return loadTimeline(sessionId).baselineTimestamp || 0;
}

function clearCache(sessionId) {
  if (sessionId) {
    const id = safeSessionId(sessionId);
    cache.delete(id);
    invalidateStatsCache(id);
  } else {
    cache.clear();
    statsCache.clear();
  }
}

module.exports = {
  SOURCE,
  SCHEMA_VERSION,
  ROOT_DIR,
  loadTimeline,
  saveTimeline,
  recordCheckpoint,
  recordAgentEdit,
  recordUserEdit,
  listPending: listPendingFiltered,
  listPendingRaw: listPending,
  acceptAll,
  acceptFile,
  revertToBaseline,
  getDiffSides,
  isPathTracked,
  getBaselineTimestamp,
  maxCheckpointTimestamp,
  contentAtOrBefore,
  readBlob,
  writeBlob,
  hashText,
  clearCache,
  invalidateStatsCache,
  fileKey,
  // test helpers
  __test: {
    emptyTimeline,
    lineDiffStats,
    countTextLines,
    pathHasCheckpointsAfterBaseline,
  },
};
