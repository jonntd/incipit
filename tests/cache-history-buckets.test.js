'use strict';

// Equivalence proof for the bounded cache-hit history (B-min).
//
// The host used to ship one `payloadHistoryEntry` per request, an
// unbounded array re-serialized over postMessage every turn the cache
// popup is open. It now ships <= HISTORY_MAX_BUCKETS aggregate buckets.
// The load-bearing claim is: summing any contiguous run of buckets
// reproduces the EXACT totals/mean/min the old full per-request array
// would have produced for exactly the requests those buckets cover —
// only the brush selection granularity coarsens, never the numbers.
//
// This test proves that claim against real local Claude transcripts and
// a deterministic synthetic 5000-request session (so the > K path is
// always exercised, even with no local transcripts). It does NOT send
// any Claude message — it drives the real host parser/bucketizer
// offline, per the project red line on validating history logic.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createParser,
  processUsageEntry,
  payloadHistoryEntry,
  payloadHistoryBuckets,
  totalContextTokens,
  HISTORY_MAX_BUCKETS,
} = require('../data/host-badge.cjs').__test;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failures += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : err));
  }
}

const FLOAT_EPS = 1e-9;
function approx(a, b, msg) {
  assert.ok(Math.abs(a - b) <= FLOAT_EPS + 1e-9 * Math.max(Math.abs(a), Math.abs(b)),
    (msg || 'approx') + ': ' + a + ' !~= ' + b);
}

// Reference (OLD) per-request rows, exactly what the webview used to
// receive and summarize before B-min.
function refRows(parser) {
  return parser.order.map(id => payloadHistoryEntry(parser, id));
}
// Reference exact aggregate over a contiguous per-request window
// [start, end) — the math the old webview summarizeHistoryRows did.
function refAggregate(rows, start, end) {
  const out = { requests: 0, fresh: 0, write: 0, read: 0, output: 0,
    hitSum: 0, minHit: 1, latestHit: NaN, firstTs: '', lastTs: '' };
  for (let i = start; i < end; i++) {
    const r = rows[i];
    out.requests += 1;
    out.fresh += r.input || 0;
    out.write += r.cw || 0;
    out.read += r.cr || 0;
    out.output += r.output || 0;
    out.hitSum += r.hit || 0;
    if ((r.hit || 0) < out.minHit) out.minHit = r.hit || 0;
  }
  if (out.requests) {
    out.latestHit = rows[end - 1].hit;
    out.firstTs = rows[start].ts;
    out.lastTs = rows[end - 1].ts;
  }
  return out;
}
// NEW aggregate over a contiguous bucket window [bi, bj] — exactly the
// sums the bucket-aware webview summarizeHistoryRows performs.
function bucketAggregate(buckets, bi, bj) {
  const out = { requests: 0, fresh: 0, write: 0, read: 0, output: 0,
    hitSum: 0, minHit: 1, latestHit: NaN, firstTs: '', lastTs: '' };
  for (let b = bi; b <= bj; b++) {
    const k = buckets[b];
    out.requests += k.c;
    out.fresh += k.f;
    out.write += k.w;
    out.read += k.r;
    out.output += k.o;
    out.hitSum += k.hs;
    if (k.lo < out.minHit) out.minHit = k.lo;
  }
  if (bj >= bi && buckets.length) {
    out.latestHit = buckets[bj].hit;
    out.firstTs = buckets[bi].t0;
    out.lastTs = buckets[bj].ts;
  }
  return out;
}

function assertEquivalent(label, parser) {
  const rows = refRows(parser);
  const n = rows.length;
  const buckets = payloadHistoryBuckets(parser);

  // Structure: bounded, every request covered exactly once, contiguous.
  assert.ok(buckets.length <= HISTORY_MAX_BUCKETS,
    label + ': bucket count ' + buckets.length + ' > cap ' + HISTORY_MAX_BUCKETS);
  if (n === 0) {
    assert.strictEqual(buckets.length, 0, label + ': empty parser must yield no buckets');
    return;
  }
  assert.ok(buckets.length <= n, label + ': more buckets than requests');
  if (n <= HISTORY_MAX_BUCKETS) {
    assert.strictEqual(buckets.length, n,
      label + ': N<=K must be 1 request/bucket (' + buckets.length + ' vs ' + n + ')');
    for (const k of buckets) {
      assert.strictEqual(k.c, 1, label + ': N<=K bucket count must be 1');
      assert.strictEqual(k.lo, k.hi, label + ': single-request bucket lo must equal hi');
      assert.strictEqual(k.lo, k.hit, label + ': single-request bucket lo must equal hit');
    }
  }
  let covered = 0;
  for (const k of buckets) {
    assert.ok(k.c >= 1, label + ': empty bucket emitted');
    covered += k.c;
  }
  assert.strictEqual(covered, n,
    label + ': buckets cover ' + covered + ' of ' + n + ' requests');

  // Full-range equivalence.
  const refFull = refAggregate(rows, 0, n);
  const bkFull = bucketAggregate(buckets, 0, buckets.length - 1);
  assert.strictEqual(bkFull.requests, refFull.requests, label + ': full requests');
  assert.strictEqual(bkFull.fresh, refFull.fresh, label + ': full fresh');
  assert.strictEqual(bkFull.write, refFull.write, label + ': full write');
  assert.strictEqual(bkFull.read, refFull.read, label + ': full read');
  assert.strictEqual(bkFull.output, refFull.output, label + ': full output');
  assert.strictEqual(bkFull.minHit, refFull.minHit, label + ': full minHit');
  assert.strictEqual(bkFull.latestHit, refFull.latestHit, label + ': full latestHit');
  assert.strictEqual(bkFull.firstTs, refFull.firstTs, label + ': full firstTs');
  assert.strictEqual(bkFull.lastTs, refFull.lastTs, label + ': full lastTs');
  approx(bkFull.hitSum / bkFull.requests, refFull.hitSum / refFull.requests,
    label + ': full meanHit');

  // Random contiguous sub-range equivalence. Cumulative bucket counts
  // map a bucket window back to the exact per-request window it covers.
  const cum = [0];
  for (const k of buckets) cum.push(cum[cum.length - 1] + k.c);
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const trials = Math.min(200, Math.max(20, buckets.length));
  for (let t = 0; t < trials; t++) {
    let bi = Math.floor(rnd() * buckets.length);
    let bj = Math.floor(rnd() * buckets.length);
    if (bi > bj) { const s = bi; bi = bj; bj = s; }
    const start = cum[bi];
    const end = cum[bj + 1];
    const ref = refAggregate(rows, start, end);
    const bk = bucketAggregate(buckets, bi, bj);
    const w = ' [' + bi + '..' + bj + ' -> req ' + start + '..' + end + ']';
    assert.strictEqual(bk.requests, ref.requests, label + ': sub requests' + w);
    assert.strictEqual(bk.fresh, ref.fresh, label + ': sub fresh' + w);
    assert.strictEqual(bk.write, ref.write, label + ': sub write' + w);
    assert.strictEqual(bk.read, ref.read, label + ': sub read' + w);
    assert.strictEqual(bk.output, ref.output, label + ': sub output' + w);
    assert.strictEqual(bk.minHit, ref.minHit, label + ': sub minHit' + w);
    assert.strictEqual(bk.latestHit, ref.latestHit, label + ': sub latestHit' + w);
    assert.strictEqual(bk.firstTs, ref.firstTs, label + ': sub firstTs' + w);
    assert.strictEqual(bk.lastTs, ref.lastTs, label + ': sub lastTs' + w);
    approx(bk.hitSum / Math.max(1, bk.requests),
      ref.hitSum / Math.max(1, ref.requests), label + ': sub meanHit' + w);
  }
}

function parserFromJsonl(file) {
  const parser = createParser(file);
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    processUsageEntry(parser, entry);
  }
  return parser;
}

function syntheticParser(count) {
  const parser = createParser('synthetic.jsonl');
  for (let i = 0; i < count; i++) {
    // Deterministic spread incl. periodic deep cache-miss crashes
    // (read 0 -> hit 0) so min/peak preservation is exercised.
    const crash = (i % 137) === 0;
    const read = crash ? 0 : 40000 + ((i * 911) % 600000);
    const cw = crash ? 90000 : 2000 + ((i * 7) % 9000);
    const fresh = (i % 53) === 0 ? 1500 : 3 + (i % 17);
    processUsageEntry(parser, {
      type: 'assistant',
      requestId: 'r' + i,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60000).toISOString(),
      message: { usage: {
        input_tokens: fresh,
        cache_creation_input_tokens: cw,
        cache_read_input_tokens: read,
        output_tokens: 100 + (i % 800),
      } },
    });
  }
  return parser;
}

function findLocalJsonls(limit) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const found = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(sub); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(sub, f);
      try { found.push({ fp, size: fs.statSync(fp).size }); } catch (_) {}
    }
  }
  found.sort((a, b) => b.size - a.size);
  return found.slice(0, limit).map(x => x.fp);
}

console.log('cache-history bucket equivalence');

check('empty parser -> no buckets', () => {
  assertEquivalent('empty', createParser('empty.jsonl'));
});
check('synthetic 1 request (degenerate)', () => {
  assertEquivalent('synthetic-1', syntheticParser(1));
});
check('synthetic ' + HISTORY_MAX_BUCKETS + ' requests (boundary, 1:1)', () => {
  assertEquivalent('synthetic-K', syntheticParser(HISTORY_MAX_BUCKETS));
});
check('synthetic 5000 requests (> K, bucketed)', () => {
  const p = syntheticParser(5000);
  const b = payloadHistoryBuckets(p);
  assert.strictEqual(b.length, HISTORY_MAX_BUCKETS, 'must hit the cap');
  assertEquivalent('synthetic-5000', p);
});

const locals = findLocalJsonls(6);
if (!locals.length) {
  console.log('  note  no local ~/.claude transcripts found; synthetic coverage only');
} else {
  for (const fp of locals) {
    check('local ' + path.basename(fp), () => {
      assertEquivalent(path.basename(fp), parserFromJsonl(fp));
    });
  }
}

if (failures) {
  console.log('\nFAILED: ' + failures + ' check(s)');
  process.exit(1);
}
console.log('\nPASSED');
