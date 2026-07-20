'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TL = require('../data/checkpoint_timeline.cjs');

function tmpSession() {
  const id = 'tl-test-' + Math.random().toString(16).slice(2, 10);
  return id;
}

function cleanup(sessionId) {
  try {
    TL.clearCache(sessionId);
    const dir = path.join(TL.ROOT_DIR, sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function ok(msg) {
  console.log('  ok ', msg);
}

{
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const filePath = path.join(dir, 'a.js');
  try {
    fs.writeFileSync(filePath, 'one\n');
    TL.recordAgentEdit(sid, filePath, {
      beforeText: 'one\n',
      afterText: 'one\ntwo\n',
      tool: 'Edit',
      turnKey: 'u1',
    });
    fs.writeFileSync(filePath, 'one\ntwo\n');

    let list = TL.listPending(sid);
    assert.strictEqual(list.empty, false);
    assert.strictEqual(list.files.length, 1);
    assert.ok(list.files[0].added >= 1);
    assert.strictEqual(list.engine, 'checkpoint-timeline');
    ok('agent edit appears in pending list');

    // User hand-edit on tracked path
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n');
    TL.recordUserEdit(sid, filePath, 'one\ntwo\nthree\n');
    list = TL.listPending(sid);
    assert.strictEqual(list.files.length, 1);
    assert.ok(list.files[0].added >= 2);
    ok('user edit updates aggregate stats');

    // Second agent edit
    fs.writeFileSync(filePath, 'one\ntwo\nthree\nfour\n');
    TL.recordAgentEdit(sid, filePath, {
      beforeText: 'one\ntwo\nthree\n',
      afterText: 'one\ntwo\nthree\nfour\n',
      tool: 'Edit',
      turnKey: 'u2',
    });
    list = TL.listPending(sid);
    assert.strictEqual(list.files.length, 1);
    assert.ok(list.files[0].added >= 3);
    ok('multi-step edits stay one pending path');

    // Diff sides: left is original before first checkpoint, right is current disk
    const sides = TL.getDiffSides(sid, filePath);
    assert.ok(sides);
    assert.strictEqual(sides.left, 'one\n');
    assert.strictEqual(sides.right, 'one\ntwo\nthree\nfour\n');
    ok('diff sides are baseline→now across user+agent');

    // Discard restores to baseline (before first agent edit)
    const rev = TL.revertToBaseline(sid, filePath);
    assert.strictEqual(rev.ok, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'one\n');
    ok('discard restores earliest baseline including wiping user edits');

    // After discard, if baseline still 0, file may still show if revert added checkpoints
    // Raise baseline via Keep semantics after re-edit
    fs.writeFileSync(filePath, 'final\n');
    TL.recordAgentEdit(sid, filePath, { beforeText: 'one\n', afterText: 'final\n', tool: 'Write' });
    let keep = TL.acceptAll(sid);
    assert.strictEqual(keep.ok, true);
    list = TL.listPending(sid);
    assert.strictEqual(list.empty, true, 'keep all clears pending');
    ok('keep all raises baseline and clears list');

    // New agent edit after keep is pending again
    fs.writeFileSync(filePath, 'final\nextra\n');
    TL.recordAgentEdit(sid, filePath, {
      beforeText: 'final\n',
      afterText: 'final\nextra\n',
      tool: 'Edit',
    });
    list = TL.listPending(sid);
    assert.strictEqual(list.empty, false);
    assert.ok(list.files[0].added >= 1);
    ok('edits after keep start a new pending window');

    // Discard after keep returns to post-keep content
    TL.revertToBaseline(sid, filePath);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'final\n');
    ok('discard after keep restores post-keep baseline not ancient history');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

{
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const created = path.join(dir, 'new.js');
  try {
    TL.recordAgentEdit(sid, created, {
      beforeText: null,
      afterText: 'hello\n',
      tool: 'Write',
    });
    fs.writeFileSync(created, 'hello\n');
    let list = TL.listPending(sid);
    assert.strictEqual(list.files[0].isCreated, true);
    TL.revertToBaseline(sid, created);
    assert.strictEqual(fs.existsSync(created), false);
    ok('created file discard deletes the file');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

{
  // host-badge can load timeline module
  const host = require('../data/host-badge.cjs');
  assert.ok(host.__test.checkpointTimeline);
  assert.strictEqual(typeof host.__test.checkpointTimeline.listPending, 'function');
  ok('host-badge exports checkpointTimeline');
}



{
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const filePath = path.join(dir, 'mix.js');
  try {
    fs.writeFileSync(filePath, 'a\n');
    TL.recordAgentEdit(sid, filePath, { beforeText: 'a\n', afterText: 'a\nb\n', tool: 'Edit' });
    fs.writeFileSync(filePath, 'a\nb\n');
    TL.recordUserEdit(sid, filePath, 'a\nb\nc\n');
    fs.writeFileSync(filePath, 'a\nb\nc\n');
    const list = TL.listPending(sid);
    assert.strictEqual(list.files[0].source, 'mixed');
    ok('agent then user yields mixed source');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}



{
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const a = path.join(dir, 'a.js');
  const b = path.join(dir, 'b.js');
  try {
    fs.writeFileSync(a, 'A1\n');
    fs.writeFileSync(b, 'B1\n');
    TL.recordAgentEdit(sid, a, { beforeText: 'A0\n', afterText: 'A1\n', tool: 'Edit' });
    TL.recordAgentEdit(sid, b, { beforeText: 'B0\n', afterText: 'B1\n', tool: 'Edit' });
    let list = TL.listPending(sid);
    assert.strictEqual(list.files.length, 2);

    TL.acceptFile(sid, a);
    list = TL.listPending(sid);
    assert.strictEqual(list.files.length, 1);
    assert.strictEqual(list.files[0].filePath, b);
    ok('single-file keep hides only that path');

    // New agent edit on kept path reappears
    fs.writeFileSync(a, 'A2\n');
    TL.recordAgentEdit(sid, a, { beforeText: 'A1\n', afterText: 'A2\n', tool: 'Edit' });
    list = TL.listPending(sid);
    assert.strictEqual(list.files.length, 2);
    ok('agent edit after per-file keep reopens that path');

    // Keep All clears both
    TL.acceptAll(sid);
    list = TL.listPending(sid);
    assert.strictEqual(list.empty, true);
    ok('keep all clears remaining after partial keep');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}



{
  // Host-badge bridge: list via buildSessionEditsPayload + timeline Keep/Discard
  // (resolvers need a real VS Code session identity; core semantics tested here).
  const T = require('../data/host-badge.cjs').__test;
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-host-'));
  const filePath = path.join(dir, 'h.js');
  try {
    TL.clearCache(sid);
    try { fs.rmSync(path.join(TL.ROOT_DIR, sid), { recursive: true, force: true }); } catch (_) {}

    fs.writeFileSync(filePath, 'v1\n');
    const hist = path.join(os.homedir(), '.claude', 'file-history', sid);
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, 'b0'), 'v0\n');

    const parser = T.createParser(path.join(dir, sid + '.jsonl'));
    parser.projectCwd = dir;
    parser.path = path.join(dir, sid + '.jsonl');
    fs.writeFileSync(parser.path, '');
    const turnKey = 'u1';
    const file = {
      id: T.changeReviewEntryId(sid, turnKey, filePath),
      sessionId: sid,
      turnKey,
      filePath,
      displayPath: 'h.js',
      backupFileName: 'b0',
      added: 1,
      removed: 1,
      hasLineStats: true,
      tool: 'Edit',
      lastSeenAt: Date.now(),
    };
    const turn = {
      turnKey,
      sessionId: sid,
      order: 0,
      cwd: dir,
      files: new Map([[filePath, file]]),
      summary: null,
    };
    parser.changeReviewTurns = new Map([[turnKey, turn]]);
    const state = { changeReviewStates: new Map(), log() {} };
    const reviewState = T.loadChangeReviewState(state, sid);
    T.markChangeReviewTurnFinalized(reviewState, turnKey);
    reviewState.files[file.id] = { status: 'pending' };

    TL.recordAgentEdit(sid, filePath, {
      beforeText: 'v0\n',
      afterText: 'v1\n',
      tool: 'Edit',
      turnKey,
    });

    let se = T.buildSessionEditsPayload(parser, reviewState);
    assert.strictEqual(se.engine, 'checkpoint-timeline');
    assert.strictEqual(se.empty, false);
    assert.ok(se.files.some(f => f.filePath === filePath));
    ok('host buildSessionEditsPayload uses timeline');

    fs.writeFileSync(filePath, 'v1\nuser\n');
    TL.recordUserEdit(sid, filePath, 'v1\nuser\n');
    se = T.buildSessionEditsPayload(parser, reviewState);
    assert.ok(se.files[0].added >= 1);
    assert.ok(se.files[0].source === 'mixed' || se.files[0].source === 'user');
    ok('host list reflects user edit on timeline');

    // Keep via timeline + change-review accept (same as host keep-all body)
    TL.acceptAll(sid);
    T.markChangeReviewFileAccepted(reviewState, file);
    se = T.buildSessionEditsPayload(parser, reviewState);
    assert.strictEqual(se.empty, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'v1\nuser\n');
    ok('host keep path clears list and keeps disk');

    fs.writeFileSync(filePath, 'v2\n');
    TL.recordAgentEdit(sid, filePath, {
      beforeText: 'v1\nuser\n',
      afterText: 'v2\n',
      tool: 'Edit',
    });
    se = T.buildSessionEditsPayload(parser, reviewState);
    assert.strictEqual(se.empty, false);

    const disc = TL.revertToBaseline(sid, filePath);
    assert.strictEqual(disc.ok, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'v1\nuser\n');
    ok('host discard path restores post-keep baseline');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try {
      fs.rmSync(path.join(os.homedir(), '.claude', 'file-history', sid), { recursive: true, force: true });
    } catch (_) {}
  }
}

{
  // Identical re-save does not grow the chain
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const filePath = path.join(dir, 'same.js');
  try {
    fs.writeFileSync(filePath, 'x\n');
    TL.recordAgentEdit(sid, filePath, { beforeText: '', afterText: 'x\n', tool: 'Write' });
    const tl1 = TL.loadTimeline(sid);
    const n1 = tl1.files[TL.fileKey(filePath)].checkpoints.length;
    TL.recordUserEdit(sid, filePath, 'x\n');
    const tl2 = TL.loadTimeline(sid);
    const n2 = tl2.files[TL.fileKey(filePath)].checkpoints.length;
    assert.strictEqual(n2, n1);
    ok('identical user re-save does not append checkpoint');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}



{
  // Live hybrid: unfinalized CR turn marks timeline row live; orphan live appears.
  const T = require('../data/host-badge.cjs').__test;
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-live-'));
  const tracked = path.join(dir, 'tracked.js');
  const liveOnly = path.join(dir, 'live-only.js');
  try {
    TL.clearCache(sid);
    try { fs.rmSync(path.join(TL.ROOT_DIR, sid), { recursive: true, force: true }); } catch (_) {}
    fs.writeFileSync(tracked, 't1\n');
    fs.writeFileSync(liveOnly, 'l1\n');
    const hist = path.join(os.homedir(), '.claude', 'file-history', sid);
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, 'bt'), 't0\n');
    fs.writeFileSync(path.join(hist, 'bl'), 'l0\n');

    const parser = T.createParser(path.join(dir, sid + '.jsonl'));
    parser.projectCwd = dir;
    parser.path = path.join(dir, sid + '.jsonl');
    fs.writeFileSync(parser.path, '');
    parser.changeReviewCurrentTurnKey = 'u-live';

    TL.recordAgentEdit(sid, tracked, { beforeText: 't0\n', afterText: 't1\n', tool: 'Edit', turnKey: 'u-live' });

    function makeFile(filePath, backup, display) {
      return {
        id: T.changeReviewEntryId(sid, 'u-live', filePath),
        sessionId: sid,
        turnKey: 'u-live',
        filePath,
        displayPath: display,
        backupFileName: backup,
        added: 1,
        removed: 1,
        hasLineStats: true,
        tool: 'Edit',
        lastSeenAt: Date.now(),
      };
    }
    const fTracked = makeFile(tracked, 'bt', 'tracked.js');
    const fLive = makeFile(liveOnly, 'bl', 'live-only.js');
    const turn = {
      turnKey: 'u-live',
      sessionId: sid,
      order: 0,
      cwd: dir,
      lifecycleStartedAt: Date.now(),
      files: new Map([[tracked, fTracked], [liveOnly, fLive]]),
      summary: null,
    };
    parser.changeReviewTurns = new Map([['u-live', turn]]);
    const state = { changeReviewStates: new Map(), log() {} };
    const reviewState = T.loadChangeReviewState(state, sid);
    // NOT finalized — live turn
    reviewState.files[fTracked.id] = { status: 'pending' };
    reviewState.files[fLive.id] = { status: 'pending' };

    const se = T.buildSessionEditsPayload(parser, reviewState);
    assert.strictEqual(se.empty, false);
    const by = Object.fromEntries(se.files.map(f => [f.displayPath || f.filePath, f]));
    assert.ok(by['tracked.js'], 'tracked on timeline');
    assert.strictEqual(by['tracked.js'].live, true, 'tracked marked live');
    assert.ok(by['live-only.js'], 'live-only hybrid row');
    assert.strictEqual(by['live-only.js'].live, true);
    assert.ok((se.totals.live || 0) >= 1);
    ok('live hybrid marks timeline rows and includes live-only files');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try {
      fs.rmSync(path.join(os.homedir(), '.claude', 'file-history', sid), { recursive: true, force: true });
    } catch (_) {}
  }
}



{
  const sid = tmpSession();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const filePath = path.join(dir, 'big.js');
  try {
    const body = 'line\n'.repeat(200);
    fs.writeFileSync(filePath, body + 'extra\n');
    TL.recordAgentEdit(sid, filePath, { beforeText: body, afterText: body + 'extra\n', tool: 'Edit' });
    const list = TL.listPending(sid);
    assert.strictEqual(list.files.length, 1);
    assert.strictEqual(list.files[0].baselineText, undefined);
    assert.ok(!('baselineText' in list.files[0]));
    ok('baselineText stripped from list payload');

    // Second listPending should hit stats cache (same mtime) and stay correct
    const list2 = TL.listPending(sid);
    assert.strictEqual(list2.files[0].added, list.files[0].added);
    assert.strictEqual(list2.files[0].removed, list.files[0].removed);
    ok('listPending stats cache reuses counts');

    // Diff still works without baselineText on list rows
    const sides = TL.getDiffSides(sid, filePath);
    assert.ok(sides && typeof sides.left === 'string');
    assert.ok(sides.right.includes('extra'));
    ok('getDiffSides still loads full baseline for native diff');
  } finally {
    cleanup(sid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('checkpoint-timeline tests passed');
