'use strict';

// Regression coverage for the interrupt → edit-user-bubble → rerun
// hand-off bug (corrupted conversation tree + "Mismatched content block
// type content_block_delta thinking" + send/stop flicker + editable
// action row appearing mid-stream).
//
// Two layers:
//   1. host-badge: the read-only `peek_truncate_state` quiescence probe
//      MUST detect any post-cut append (stale CLI flush or a
//      host-injected task-notification continuation). This is the
//      fail-safe that stops incipit starting a second concurrent stream.
//   2. enhance_legacy: static source invariants so a future refactor
//      that deletes the serialized hand-off gate fails CI loudly.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostBadge = require('../data/host-badge.cjs');
const T = hostBadge.__test;

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

// ---- Layer 1: peek_truncate_state advanced-detection ----

function makeEntry(obj) { return JSON.stringify(obj); }

(function peekDetectsForeignAppend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-rerun-'));
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const target = path.join(dir, sessionId + '.jsonl');

  // user → interrupted assistant with a DEGENERATE thinking block
  // (empty text + signature: the interrupt fingerprint) → trailing
  // assistant. Rerun anchors on the user row.
  const userUuid = 'u-anchor';
  const lines = [
    makeEntry({ type: 'user', uuid: 'u-prev', parentUuid: null,
      message: { role: 'user', content: 'first' } }),
    makeEntry({ type: 'assistant', uuid: 'a-prev', parentUuid: 'u-prev',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    makeEntry({ type: 'user', uuid: userUuid, parentUuid: 'a-prev',
      message: { role: 'user', content: 'edit me then rerun' } }),
    makeEntry({ type: 'assistant', uuid: 'a-interrupted', parentUuid: userUuid,
      message: { role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'SIGabc' }] } }),
  ];
  fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');

  const beforeText = fs.readFileSync(target, 'utf8');
  const transcript = T.readTranscript(target);
  const res = T.applyTruncateFromUser(transcript, userUuid);
  assert.strictEqual(res.changed, true, 'truncate should drop the anchor + interrupted tail');
  const afterText = T.serializeTranscript(transcript);
  assert.ok(
    !afterText.includes('a-interrupted'),
    'truncate must drop the degenerate interrupted-thinking assistant',
  );
  T.atomicWriteTranscript(target, afterText);

  const state = { truncateRollbacks: new Map() };
  const reg = T.registerTruncateRollback(state, {
    target, sessionId, uuid: userUuid, beforeText, afterText,
  });
  assert.ok(reg && reg.token, 'rollback registration must return a token');

  // Quiet: file is byte-identical to the cut text → safe to resend.
  const quiet = T.peekTruncateState(state, target, userUuid,
    { sessionId, rollbackToken: reg.token });
  assert.strictEqual(quiet.hasToken, true);
  assert.strictEqual(quiet.advanced, false,
    'an untouched truncated transcript must read as NOT advanced');
  ok('peek: clean cut → advanced=false');

  // A foreign writer (stale CLI flush / task-notification continuation)
  // appends after the cut → MUST read as advanced so the caller fails
  // safe instead of starting a second stream.
  fs.appendFileSync(target, makeEntry({
    type: 'user', uuid: 'tn-x', parentUuid: '343f4f63-gone',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: 'background task done' },
  }) + '\n', 'utf8');
  const advanced = T.peekTruncateState(state, target, userUuid,
    { sessionId, rollbackToken: reg.token });
  assert.strictEqual(advanced.advanced, true,
    'a post-cut append (task-notification / stale CLI) must read as advanced');
  ok('peek: foreign post-cut append → advanced=true');

  // Expired/missing token → hasToken:false (caller falls back to
  // busy + stat-stability only; must not throw).
  const noTok = T.peekTruncateState(state, target, userUuid,
    { sessionId, rollbackToken: 'nope' });
  assert.strictEqual(noTok.hasToken, false);
  assert.strictEqual(noTok.advanced, null);
  ok('peek: missing token → hasToken=false, no throw');

  // Token bound to a different transcript identity must be rejected.
  assert.throws(() => T.peekTruncateState(state, target, userUuid,
    { sessionId: 'other-session', rollbackToken: reg.token }),
    /does not match/, 'peek must reject a token from another transcript');
  ok('peek: cross-transcript token rejected');

  fs.rmSync(dir, { recursive: true, force: true });
})();

// ---- Layer 2: enhance_legacy serialized hand-off source invariants ----

(function sourceInvariants() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');

  const required = [
    // Re-entry latch + the CSS grey-out latch toggle.
    'historyHandoffInFlight',
    'function setHandoffLatch',
    "setAttribute('data-incipit-handoff'",
    // Two-phase hand-off: quiesce the old stream BEFORE the cut, then a
    // short post-cut foreign-write confirmation.
    'function quiesceOldStream',
    'function confirmCutQuiescent',
    // Independent stopped-stream check that does NOT trust busy===false.
    'function activeSessionTailUnsafeReason',
    // Read-only host-badge quiescence probe is actually called.
    "'peek_truncate_state'",
    // Busy→UI hysteresis for the action row / send icon.
    'function busyHysteresisReady',
  ];
  for (const needle of required) {
    assert.ok(src.includes(needle),
      'enhance_legacy.js lost the hand-off guard: ' + needle);
  }

  // Regression fence #1: the interrupted-thinking detector must NOT be
  // folded back into the global partial/busy predicate (that wedged
  // incipit into permanent pseudo-busy and stalled rerun for 8s).
  assert.ok(!src.includes('thinkingBlockIsDegenerate'),
    'thinkingBlockIsDegenerate must not exist — it poisons conversationIsBusy()');
  const tbpStart = src.indexOf('function transcriptBlockIsPartial');
  assert.ok(tbpStart > 0, 'transcriptBlockIsPartial must exist');
  const tbpBody = src.slice(tbpStart, tbpStart + 320);
  assert.ok(!/thinking/i.test(tbpBody),
    'transcriptBlockIsPartial must not consider thinking-block shape');

  // Regression fence #2: activeSessionTailUnsafeReason must NOT wait on
  // activeSessionHasPartialTail() — that condition only clears via the
  // truncate itself, so waiting on it can never succeed pre-cut.
  const asurStart = src.indexOf('function activeSessionTailUnsafeReason');
  const asurBody = src.slice(asurStart, asurStart + 320);
  assert.ok(!asurBody.includes('activeSessionHasPartialTail'),
    'activeSessionTailUnsafeReason must not block on partial-tail');

  // Regression fence #3: in rerunFromUser, quiesceOldStream() must run
  // BEFORE the truncate_from_user mutation (no cutting the JSONL until
  // the old stream is confirmed stopped).
  const rerunStart = src.indexOf('async function rerunFromUser');
  assert.ok(rerunStart > 0, 'rerunFromUser must exist');
  const qIdx = src.indexOf('await quiesceOldStream(', rerunStart);
  const tIdx = src.indexOf("requestTranscriptMutation('truncate_from_user'", rerunStart);
  assert.ok(qIdx > rerunStart && tIdx > rerunStart && qIdx < tIdx,
    'rerunFromUser must quiesce the old stream before truncating');

  // Regression fence #4: still no early-return on conversationIsBusy()
  // at the top of rerunFromUser (that bypassed the quiesce path).
  const rerunHead = src.slice(rerunStart, rerunStart + 900);
  assert.ok(
    !/transcriptHasToolResult\(record\)\) return;\s*\n\s*if \(conversationIsBusy\(\)\) return;/.test(rerunHead),
    'rerunFromUser must not early-return on conversationIsBusy() before quiesce',
  );
  ok('source: two-phase hand-off present; partial-tail wait + busy early-return removed');
})();

console.log('\nrerun-handoff: ' + passed + ' checks PASSED');
