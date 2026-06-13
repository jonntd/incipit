'use strict';

// Regression fence for the Notes (snippets) + reject-reminder feature.
//
// Contract (the design agreed with the user, see
// dev-notes/2026-06-13-notes-and-reject-reminder.md):
//   · clicking a snippet (or the reject bubble's Insert) puts text in the
//     composer WITHOUT sending and WITHOUT writing the contenteditable — the
//     only insertion path is the official mention command, invoked host-side
//     via a `notes_insert_request` message (memo 2026-04-15 / 2026-06-06)
//   · notes persist per scope: Global in one file, Project keyed by SHA256(cwd),
//     written atomically (tmp + rename); the two scopes never bleed
//   · the reject bubble accumulates rejected paths (deduped), only fires on a
//     SUCCESSFUL reject, and renders a plain-fact English reminder
//   · panel interactions are delegated to the stable panel element, never bound
//     per-row (memo 2026-06-13: per-node handlers die on rebuild)
//   · the note icon mounts on the identity heartbeat, not a new body observer

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostBadge = require('../data/host-badge.cjs');
const T = hostBadge.__test;

const footer = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_footer_badge.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(__dirname, '..', 'data', 'host-badge.cjs'), 'utf8');
const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8');
const warm = fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

function setupNotesBody() {
  const idx = footer.indexOf('function setupNotes(');
  assert.ok(idx >= 0, 'missing function setupNotes');
  const end = footer.indexOf('\nexport function initFooterBadge', idx);
  assert.ok(end > idx, 'could not bound setupNotes');
  return footer.slice(idx, end);
}
const notes = setupNotesBody();

function tmpNotesDir() {
  const dir = path.join(os.tmpdir(), 'incipit-notes-test-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Storage roundtrip + scope isolation + atomic write (host-badge exports)
// ---------------------------------------------------------------------------
(function storageRoundtripAndIsolation() {
  const dir = tmpNotesDir();
  try {
    const g = T.saveNotes('global', null, [{ id: 'a', text: 'global one', createdAt: 1 }], dir);
    assert.ok(g.ok, 'global save ok');
    assert.ok(fs.existsSync(path.join(dir, 'global.json')), 'global.json written');

    const cwdA = '/work/projA';
    const cwdB = '/work/projB';
    assert.ok(T.saveNotes('project', cwdA, [{ id: 'pa', text: 'A note', createdAt: 1 }], dir).ok);
    assert.ok(T.saveNotes('project', cwdB, [{ id: 'pb', text: 'B note', createdAt: 1 }], dir).ok);

    const loadedA = T.loadNotes('project', cwdA, dir);
    const loadedB = T.loadNotes('project', cwdB, dir);
    assert.strictEqual(loadedA.length, 1);
    assert.strictEqual(loadedA[0].text, 'A note');
    assert.strictEqual(loadedB[0].text, 'B note');
    assert.notStrictEqual(
      T.notesFilePath('project', cwdA, dir),
      T.notesFilePath('project', cwdB, dir),
      'distinct cwds map to distinct files (keyed by projectKey)',
    );

    // Global and project stay separate.
    assert.strictEqual(T.loadNotes('global', null, dir)[0].text, 'global one');

    // Atomic: no .tmp- leftovers after a write.
    const leftovers = fs.readdirSync(dir).filter(f => f.indexOf('.tmp-') !== -1);
    assert.strictEqual(leftovers.length, 0, 'no temp files remain (atomic rename)');

    ok('storage: roundtrip, global/project isolation, atomic write');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function projectScopeNeedsCwd() {
  assert.strictEqual(T.notesFilePath('project', '', '/x'), null, 'project notes without cwd → no path');
  const res = T.saveNotes('project', null, [{ id: 'a', text: 'x' }], '/x');
  assert.strictEqual(res.ok, false, 'project save without cwd is refused');
  ok('storage: project scope without a workspace is refused, not misfiled');
})();

(function sanitizeRules() {
  const cleaned = T.sanitizeNotesList([
    { id: 'keep', text: 'real' },
    { id: 'blank', text: '   ' },            // dropped: blank
    { text: 'no id here' },                   // gets a synthesized id
    { id: 'keep', text: 'dup id' },           // duplicate id is disambiguated
    null,                                     // ignored
  ]);
  assert.ok(cleaned.every(n => n.text.trim()), 'blank notes dropped');
  const ids = cleaned.map(n => n.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique after sanitize');
  assert.ok(cleaned.length <= T.NOTES_MAX_COUNT);

  const crlf = T.sanitizeNoteText('line1\r\nline2\rline3');
  assert.strictEqual(crlf, 'line1\nline2\nline3', 'CRLF/CR normalized to LF so stored text inserts identically');
  ok('storage: sanitize drops blanks, dedups ids, normalizes CRLF');
})();

// ---------------------------------------------------------------------------
// 2. Insertion only via the official mention command — never the composer DOM
// ---------------------------------------------------------------------------
(function insertionGoesThroughTheMentionCommand() {
  assert.strictEqual(
    hostBadge.__test.NOTES_INSERT_COMMAND, 'incipit.claudeCode.insertAtMention',
    'insert reuses the official mention command bridge',
  );
  const insIdx = hostSrc.indexOf('function handleNotesInsertRequest');
  assert.ok(insIdx >= 0, 'host has a notes insert handler');
  const insBody = hostSrc.slice(insIdx, insIdx + 1200);
  assert.ok(
    insBody.includes('executeCommand(NOTES_INSERT_COMMAND') || insBody.includes("executeCommand('incipit.claudeCode.insertAtMention'"),
    'host insert delegates to the mention command',
  );

  // Webview side: insertion is a postMessage, NOT a composer DOM write.
  assert.ok(notes.includes("type: 'notes_insert_request'"), 'webview insertion is a notes_insert_request message');
  assert.ok(!notes.includes('execCommand'), 'no document.execCommand insertion path');
  assert.ok(!notes.includes('messageInput'), 'never touches the host messageInput layer');
  // Guard the WRITE/QUERY vectors, not the word — the design comment legitimately
  // names contenteditable. There must be no contenteditable property write or selector.
  assert.ok(!notes.includes('.contentEditable'), 'no contentEditable property write');
  assert.ok(!/\[contenteditable/i.test(notes), 'no contenteditable selector query into the host editor');
  ok('insert: only via the mention command bridge, no composer DOM write');
})();

// ---------------------------------------------------------------------------
// 3. Reject reminder bubble: success-only, deduped, plain-fact English
// ---------------------------------------------------------------------------
(function rejectBubbleContract() {
  assert.ok(
    notes.includes("window.addEventListener('incipit:change-review-rejected'"),
    'bubble listens for the reject bridge event',
  );
  assert.ok(notes.includes('function addRejectedPaths') && notes.includes('.indexOf(p) === -1'),
    'rejected paths accumulate with dedup');
  assert.ok(notes.includes('function buildRejectReminder'), 'has a reminder builder');
  assert.ok(notes.includes("'I rejected your '") && notes.includes("' been reverted.'"),
    'reminder is the plain-fact English the user chose');

  // enhance_legacy: dispatch ONLY on success, with paths captured BEFORE the post.
  const turnIdx = legacy.indexOf('function rejectChangeReviewTurn');
  const turnBody = legacy.slice(turnIdx, turnIdx + 700);
  assert.ok(turnBody.indexOf('changeReviewTurnFilePaths(turnKey)') < turnBody.indexOf('postChangeReviewRequest'),
    'turn reject captures paths before posting');
  assert.ok(turnBody.indexOf('.then(() => { dispatchChangeReviewRejected') < turnBody.indexOf('.catch('),
    'turn reject dispatches in the success branch, not on failure');

  const fileIdx = legacy.indexOf('function rejectChangeReviewFile');
  const fileBody = legacy.slice(fileIdx, fileIdx + 700);
  assert.ok(fileBody.indexOf('changeReviewFilePathsByIds([fileId])') < fileBody.indexOf('postChangeReviewRequest'),
    'file reject captures path before posting');
  assert.ok(fileBody.includes('.then(() => { dispatchChangeReviewRejected'),
    'file reject dispatches in the success branch');

  assert.ok(
    legacy.includes("new CustomEvent('incipit:change-review-rejected'"),
    'bridge uses the agreed window CustomEvent',
  );
  ok('reject bubble: success-only dispatch, pre-capture, dedup, factual template');
})();

// ---------------------------------------------------------------------------
// 4. Panel interactions delegated to the stable element; icon rides heartbeat
// ---------------------------------------------------------------------------
(function delegationAndMount() {
  assert.ok(notes.includes('function bindPanelDelegation'), 'panel uses a single delegation binder');
  // Rows are pure factories — no per-node click handlers that die on rebuild.
  const rowIdx = notes.indexOf('function buildNoteRow');
  const rowBody = notes.slice(rowIdx, notes.indexOf('function buildEditor'));
  assert.ok(!rowBody.includes('addEventListener'), 'note rows do not self-bind handlers (memo 2026-06-13)');

  // Icon mounts on the shared identity heartbeat, not a fresh body observer.
  assert.ok(notes.includes('registerIdentityPublisher'), 'note icon rides the identity heartbeat');
  assert.ok(!notes.includes('new MutationObserver'), 'no new body-wide observer for the note icon');

  // Icon sits immediately left of the cache badge.
  assert.ok(notes.includes("host.insertBefore(btn, badge)"), 'note icon anchored left of the cache badge');
  ok('panel: delegated interactions, heartbeat mount, icon left of badge');
})();

// ---------------------------------------------------------------------------
// 5. Themed both ways with the shared dialog tokens
// ---------------------------------------------------------------------------
(function themedBothWays() {
  assert.ok(theme.includes('[data-incipit-notes-panel]') && theme.includes('[data-incipit-notes-bubble]'),
    'dark theme styles the panel and bubble');
  assert.ok(theme.includes('#a8896e'), 'primary action uses the shared #a8896e');
  assert.ok(warm.includes('[data-incipit-notes-panel]') && warm.includes('#ffffff'),
    'warm-white override repaints the panel');
  assert.ok(warm.includes('[data-incipit-notes-bubble-insert]'), 'warm-white override repaints the bubble insert button');
  ok('theme: dark + warm-white share the custom-model dialog language');
})();

console.log('\nnotes: ' + passed + ' checks PASSED');
