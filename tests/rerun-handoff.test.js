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

(function userEditBeforeSignedThinkingIsRejected() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-edit-thinking-'));
  const target = path.join(dir, '22222222-3333-4444-5555-666666666666.jsonl');
  const userUuid = 'u-edited';
  const lines = [
    makeEntry({ type: 'user', uuid: userUuid, parentUuid: null,
      message: { role: 'user', content: [{ type: 'text', text: 'old' }] } }),
    makeEntry({ type: 'assistant', uuid: 'a-thinking', parentUuid: userUuid,
      message: { role: 'assistant',
        content: [{ type: 'thinking', thinking: '', signature: 'SIGabc' }] } }),
    makeEntry({ type: 'assistant', uuid: 'a-text', parentUuid: 'a-thinking',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } }),
  ];
  fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
  const transcript = T.readTranscript(target);
  assert.strictEqual(T.userEditHasDownstreamSignedThinking(transcript, userUuid), true,
    'a user edit before signed thinking must be recognized as unsafe');
  assert.throws(() => T.applyUserBlockEdit(transcript, userUuid, [
    { kind: 'text', text: 'new' },
  ]), /signed thinking blocks/,
  'plain local save must reject instead of poisoning the next API request');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('edit guard: upstream user edit before signed thinking is rejected');
})();

// ---- Layer 2: enhance_legacy serialized hand-off source invariants ----

(function sourceInvariants() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
  const host = fs.readFileSync(
    path.join(__dirname, '..', 'data', 'host-badge.cjs'), 'utf8');

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
    // Signed-thinking local edits must use a safe cut-and-resend path.
    'function saveAndRerunInlineEditor',
    'function buildRerunPayloadFromEditorDraft',
    'async function rerunFromUser(record, button, overridePayload = null)',
    'overridePayload || buildRerunPayloadFromRecord(record)',
    'Save and rerun (Ctrl+Enter)',
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
  assert.ok(host.includes('SIGNED_THINKING_USER_EDIT_ERROR') &&
      host.includes('userEditHasDownstreamSignedThinking(transcript, uuid)') &&
      host.includes("block.type === 'thinking' || block.type === 'redacted_thinking'"),
    'host local-save path must reject upstream edits before signed thinking blocks');
  ok('source: two-phase hand-off present; partial-tail wait + busy early-return removed');

  // The webview must pre-empt that host rejection in the UI: when a user
  // record has downstream signed thinking, the inline editor offers only
  // Cancel + Rerun (no Save), and Ctrl+Enter routes to Save-and-Rerun.
  // The detector must read messages.value, not DOM (virtualization drops
  // downstream rows). Regressing any of these re-exposes the dead-end ✓.
  assert.ok(
    src.includes('function userRecordHasDownstreamSignedThinking') &&
      src.includes('function recordHasSignedThinking') &&
      src.includes('const hasDownstreamThinking =') &&
      src.includes('editActions.append(cancelBtn, saveRerunBtn)'),
    'webview must hide Save (offer only Cancel+Rerun) when downstream signed thinking exists');
  // The detector is record-based, not a DOM sibling sweep.
  assert.ok(
    /function userRecordHasDownstreamSignedThinking[\s\S]{0,400}messages\.value/.test(src),
    'downstream-thinking detector must read messages.value, not DOM');
  ok('source: inline editor hides Save when downstream signed thinking present');

  // Slash-command / local-command user records must not be editable:
  // their content is the host's internal `<command-*>` protocol, not
  // prose. Editing leaks the XML into the textarea; rerun pushes it
  // through session.send where the slash parser rejects it.
  assert.strictEqual(
    T.canEditUserEntry({ type: 'user', message: { content:
      '<command-name>/model</command-name>\n<command-args>default</command-args>' } }),
    false, 'host must refuse to edit a slash-command record');
  assert.strictEqual(
    T.canEditUserEntry({ type: 'user', message: { content:
      '<local-command-stdout>Set model to claude-opus-4-8</local-command-stdout>' } }),
    false, 'host must refuse to edit a local-command stdout record');
  assert.strictEqual(
    T.canEditUserEntry({ type: 'user', message: { content: 'just normal prose' } }),
    true, 'host must still allow editing ordinary user prose');
  assert.ok(
    src.includes('function isSlashCommandRecord') &&
      src.includes('!isSlashCommandRecord(record)'),
    'webview must exclude slash-command records from the editable real-user set');
  ok('guard: slash-command / local-command records are non-editable (host + webview)');
})();

console.log('\nrerun-handoff: ' + passed + ' checks PASSED');
