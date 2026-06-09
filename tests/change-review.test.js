const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../data/host-badge.cjs').__test;

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-change-review-'));
}

function makeHarness(workspace, sessionId, lines) {
  const transcript = path.join(workspace, sessionId + '.jsonl');
  fs.writeFileSync(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const comm = { webview: { postMessage() {} } };
  const state = {
    comms: new Set([comm]),
    commIdentities: new Map([[comm, { sessionId, cwd: workspace, target: transcript }]]),
    targetCache: new Map(),
    parsers: new Map(),
    changeReviewStates: new Map(),
    log() {},
  };
  return { state, comm, transcript };
}

function userLine(sessionId, cwd, uuid) {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: 'please edit' }] },
    cwd,
    sessionId,
    timestamp: '2026-06-03T10:00:00.000Z',
  };
}

function snapshotLine(turnKey, trackedFileBackups, options = {}) {
  const entryMessageId = options.entryMessageId || turnKey;
  const snapshotMessageId = options.snapshotMessageId || turnKey;
  return {
    type: 'file-history-snapshot',
    messageId: entryMessageId,
    snapshot: {
      messageId: snapshotMessageId,
      trackedFileBackups,
      timestamp: '2026-06-03T10:00:00.001Z',
    },
    isSnapshotUpdate: options.isSnapshotUpdate === true,
  };
}

function snapshotUpdateLine(assistantUuid, trackedFileBackups, options = {}) {
  return snapshotLine(options.snapshotMessageId || assistantUuid, trackedFileBackups, {
    ...options,
    entryMessageId: assistantUuid,
    isSnapshotUpdate: true,
  });
}

function assistantToolLine(sessionId, cwd, uuid, toolId, name, input) {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolId,
        name,
        input,
      }],
    },
    cwd,
    sessionId,
    timestamp: '2026-06-03T10:00:00.010Z',
  };
}

function toolResultLine(sessionId, cwd, uuid, toolId, sourceToolAssistantUUID, options = {}) {
  const entry = {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{
        tool_use_id: toolId,
        type: 'tool_result',
        content: options.content || 'ok',
        is_error: options.isError === true,
      }],
    },
    cwd,
    sessionId,
    sourceToolAssistantUUID,
    timestamp: '2026-06-03T10:00:00.020Z',
  };
  if (Object.prototype.hasOwnProperty.call(options, 'toolUseResult')) {
    entry.toolUseResult = options.toolUseResult;
  }
  return entry;
}

function successfulWriteLines(sessionId, cwd, turnKey, filePath, backup, options = {}) {
  const assistantUuid = options.assistantUuid || ('assistant-' + turnKey);
  const toolId = options.toolId || ('tool-' + turnKey);
  return [
    userLine(sessionId, cwd, turnKey),
    // Real Claude Code can append this snapshot update before the assistant
    // tool_use row. It is backup metadata, not the source of the file row.
    snapshotUpdateLine(assistantUuid, { [filePath]: backup }, {
      snapshotMessageId: options.snapshotMessageId || turnKey,
    }),
    assistantToolLine(sessionId, cwd, assistantUuid, toolId, options.name || 'Write',
      options.input || { file_path: filePath, content: options.content || 'model version\n' }),
    toolResultLine(sessionId, cwd, options.resultUuid || ('tool-result-' + turnKey), toolId, assistantUuid),
  ];
}

function backupDir(sessionId) {
  return path.join(os.homedir(), '.claude', 'file-history', sessionId);
}

function reviewStatePath(sessionId) {
  return path.join(os.homedir(), '.incipit', 'change-review-v1', sessionId + '.json');
}

function finalizedReviewState(turnKey) {
  const reviewState = { turns: {}, files: {} };
  T.markChangeReviewTurnFinalized(reviewState, turnKey);
  reviewState.dirty = false;
  return reviewState;
}

function assertNoActiveTurn(payload, message = 'active composer review payload must not be exposed') {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(payload, 'activeTurn'), false, message);
}

(function parsesSnapshotAndAggregatesOneFilePerTurn() {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'new\ntext\n');
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      filePath: 'src/a.txt',
      added: 2,
      removed: 1,
    });
    T.processChangeReviewEntry(parser, snapshotLine('u1', {
      [path.join('src', 'a.txt')]: {
        backupFileName: 'backup-a@v1',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      },
    }));
    const reviewState = { turns: {}, files: {} };
    T.markChangeReviewTurnStarted(reviewState, 'u1');
    const pending = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(pending);
    assert.strictEqual(pending.turns.length, 0, 'unfinished turn must not be promoted to webview payload');
    assert.strictEqual(pending.latestTurn, null);
    const payload = T.buildChangeReviewPayload(parser, finalizedReviewState('u1'));
    assertNoActiveTurn(payload);
    assert.strictEqual(payload.turns.length, 1);
    assert.strictEqual(payload.latestTurn.files.length, 1);
    assert.strictEqual(payload.latestTurn.totals.files, 1);
    assert.strictEqual(payload.latestTurn.files[0].added, 2);
    assert.strictEqual(payload.latestTurn.files[0].removed, 1);
    assert.strictEqual(payload.latestTurn.files[0].hasLineStats, true);
    assert.ok(path.isAbsolute(payload.latestTurn.files[0].filePath));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload.latestTurn.files[0], 'oldText'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(payload.latestTurn.files[0], 'newText'), false);
    ok('snapshot parse + same-turn file aggregation, exposed only after finalized');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function pendingReviewPersistsAcrossMultipleFileToolsUntilTurnFinalized() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    const reviewState = { turns: {}, files: {} };
    T.markChangeReviewTurnStarted(reviewState, 'u1');
    assertNoActiveTurn(T.buildChangeReviewPayload(parser, reviewState));

    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      filePath: 'a.txt',
      added: 1,
      removed: 0,
    });
    const first = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(first);
    assert.strictEqual(first.turns.length, 0);

    T.countChangeReviewTool(parser, {
      id: 'tool-2',
      turnKey: 'u1',
      filePath: 'b.txt',
      added: 3,
      removed: 2,
    });
    const second = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(second);
    assert.strictEqual(second.turns.length, 0, 'pending lifecycle stays hidden until finalized');

    T.markChangeReviewTurnFinalized(reviewState, 'u1');
    const final = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(final);
    assert.strictEqual(final.turns.length, 1);
    assert.strictEqual(final.latestTurn.files.length, 2);
    ok('pending review persists across multiple file tools until turn finalized');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function agentToolStatsCreateSummaryOnlyLifecycleReview() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    const reviewState = { turns: {}, files: {} };
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.markChangeReviewTurnStarted(reviewState, 'u1');
    assertNoActiveTurn(T.buildChangeReviewPayload(parser, reviewState));

    T.processEditActivityEntry(parser, assistantToolLine('s1', dir, 'assistant-agent', 'tool-agent', 'Agent', {
      description: 'delegate file edits',
      subagent_type: 'general-purpose',
      prompt: 'write files',
    }));
    T.processEditActivityEntry(parser, toolResultLine('s1', dir, 'tool-result-agent', 'tool-agent', 'assistant-agent', {
      toolUseResult: {
        status: 'completed',
        toolStats: {
          editFileCount: 2,
          linesAdded: 533,
          linesRemoved: 0,
        },
      },
    }));

    const pending = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(pending);
    assert.strictEqual(pending.turns.length, 0);

    T.markChangeReviewTurnFinalized(reviewState, 'u1');
    const final = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(final);
    assert.strictEqual(final.turns.length, 1);
    assert.strictEqual(final.latestTurn.files.length, 0);
    assert.strictEqual(final.latestTurn.totals.files, 2);
    assert.strictEqual(final.latestTurn.totals.added, 533);
    ok('Agent toolStats create a summary-only finalized change review');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function agentToolStatsWithoutLinesDoNotClaimZeroLineStats() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    const reviewState = { turns: {}, files: {} };
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.markChangeReviewTurnStarted(reviewState, 'u1');
    T.processEditActivityEntry(parser, assistantToolLine('s1', dir, 'assistant-agent', 'tool-agent', 'Agent', {
      description: 'delegate file edits',
    }));
    T.processEditActivityEntry(parser, toolResultLine('s1', dir, 'tool-result-agent', 'tool-agent', 'assistant-agent', {
      toolUseResult: {
        status: 'completed',
        toolStats: {
          editFileCount: 2,
        },
      },
    }));
    T.markChangeReviewTurnFinalized(reviewState, 'u1');
    const final = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(final);
    assert.strictEqual(final.latestTurn.files.length, 0);
    assert.strictEqual(final.latestTurn.totals.files, 2);
    assert.strictEqual(final.latestTurn.totals.added, 0);
    assert.strictEqual(final.latestTurn.totals.removed, 0);
    assert.strictEqual(final.latestTurn.totals.hasLineStats, false);
    ok('Agent summary-only review without line stats does not claim +0/-0 data');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function historicalTurnWithoutLifecycleStateDoesNotEnterPayload() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      filePath: 'a.txt',
      added: 1,
      removed: 0,
    });
    const payload = T.buildChangeReviewPayload(parser, { turns: {}, files: {} });
    assertNoActiveTurn(payload);
    assert.strictEqual(payload.turns.length, 0);
    assert.strictEqual(payload.empty, true);
    const staleState = T.buildChangeReviewPayload(parser, { turns: { u1: { finalized: false } }, files: {} });
    assertNoActiveTurn(staleState, 'stale unfinalized state without lifecycle start must stay hidden');
    ok('historical turn without lifecycle state does not enter payload');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function staleStartForPreviousTurnIsIgnoredAfterNextUserIsCurrent() {
  const dir = tmp();
  const sessionId = 'cr-stale-start-' + Date.now();
  try {
    fs.writeFileSync(path.join(dir, 'old.txt'), 'old turn file\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'old.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
      userLine(sessionId, dir, 'u2'),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const result = T.resolveChangeReviewTurnStarted(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const reviewState = state.changeReviewStates.get(sessionId);
    assert.strictEqual(reviewState.turns.u1.finalized, true, 'stale start must not unfinalize the previous turn');
    assertNoActiveTurn(result);
    assert.strictEqual(result.turns.length, 1);
    assert.strictEqual(result.latestTurn.turnKey, 'u1');
    ok('stale start for previous turn is ignored once next user is current');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function explicitFinalizeForMissingTurnDoesNotFallbackToPreviousFileTurn() {
  const dir = tmp();
  const sessionId = 'cr-finalize-no-fallback-' + Date.now();
  try {
    fs.writeFileSync(path.join(dir, 'old.txt'), 'old turn file\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'old.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const reviewState = state.changeReviewStates.get(sessionId);
    T.markChangeReviewTurnStarted(reviewState, 'u1');
    assert.strictEqual(reviewState.turns.u1.finalized, false);
    const result = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u2-missing' });
    assert.strictEqual(reviewState.turns.u1.finalized, false, 'explicit missing finalize must not finalize the latest old turn');
    assert.strictEqual(result.turns.length, 0);
    ok('explicit finalize for missing turn does not fallback to previous file turn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function emptySameUuidLifecycleRestoresPreviousFinalizedReview() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      filePath: 'a.txt',
      added: 4,
      removed: 2,
    });
    T.processChangeReviewEntry(parser, snapshotLine('u1', {
      'a.txt': { backupFileName: null, version: 1 },
    }));
    const reviewState = finalizedReviewState('u1');
    const before = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(before.latestTurn.files[0].added, 4);
    const turn = parser.changeReviewTurns.get('u1');
    const file = Array.from(turn.files.values())[0];
    file.lastSeenAt = 1;
    const startedAt = T.markChangeReviewTurnStarted(reviewState, 'u1');
    turn.lifecycleStartedAt = startedAt;
    const active = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(active);
    assert.strictEqual(active.turns.length, 0);
    T.markChangeReviewTurnFinalized(reviewState, 'u1');
    const wrongFinal = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(wrongFinal.turns.length, 0, 'plain finalize would keep the empty slice hidden');

    const reviewState2 = finalizedReviewState('u1');
    const startedAt2 = T.markChangeReviewTurnStarted(reviewState2, 'u1');
    turn.lifecycleStartedAt = startedAt2;
    fs.writeFileSync(parser.path, JSON.stringify(userLine('s1', dir, 'u1')) + '\n');
    const comm = { webview: { postMessage() {} } };
    const state = {
      comms: new Set([comm]),
      commIdentities: new Map([[comm, { sessionId: 's1', cwd: dir, target: parser.path }]]),
      changeReviewStates: new Map([['s1', reviewState2]]),
      targetCache: new Map(),
      parsers: new Map([[parser.path, parser]]),
      log() {},
    };
    const result = T.resolveChangeReviewTurnFinalized(state, comm, {
      sessionId: 's1',
      cwd: dir,
      turnKey: 'u1',
    });
    assertNoActiveTurn(result);
    assert.strictEqual(result.turns.length, 1);
    assert.strictEqual(result.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'a.txt');
    assert.strictEqual(result.latestTurn.files[0].added, 4);
    assert.strictEqual(result.latestTurn.files[0].removed, 2);
    ok('empty same-uuid lifecycle restores previous finalized review instead of +0/-0 ghost');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath('s1'), { force: true });
  }
})();

(function staleSnapshotUpdateCannotReviveOldLifecycleFiles() {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'old\nnew\n');
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.processEditActivityEntry(parser, assistantToolLine('s1', dir, 'assistant-1', 'tool-1', 'Edit', {
      file_path: 'src/a.txt',
      old_string: 'old\n',
      new_string: 'old\nnew\n',
    }));
    T.processEditActivityEntry(parser, toolResultLine('s1', dir, 'tool-result-1', 'tool-1', 'assistant-1'));
    T.processChangeReviewEntry(parser, snapshotLine('snapshot-history-id', {
      [path.join('src', 'a.txt')]: {
        backupFileName: 'backup-a@v1',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      },
    }, {
      entryMessageId: 'assistant-1',
      snapshotMessageId: 'snapshot-history-id',
      isSnapshotUpdate: true,
    }));
    const reviewState = finalizedReviewState('u1');
    const turn = parser.changeReviewTurns.get('u1');
    const file = Array.from(turn.files.values())[0];
    assert.strictEqual(file.added, 1);
    file.lastSeenAt = 1;
    const startedAt = T.markChangeReviewTurnStarted(reviewState, 'u1');
    turn.lifecycleStartedAt = startedAt;
    T.processChangeReviewEntry(parser, snapshotLine('snapshot-history-id-2', {
      [path.join('src', 'a.txt')]: {
        backupFileName: 'backup-a@v2',
        version: 2,
        backupTime: '2026-06-03T10:02:01.000Z',
      },
    }, {
      entryMessageId: 'assistant-1',
      snapshotMessageId: 'snapshot-history-id-2',
      isSnapshotUpdate: true,
    }));
    assert.strictEqual(file.added, 1, 'old snapshot update must not reset additions to zero');
    assert.strictEqual(file.backupFileName, 'backup-a@v1', 'old snapshot update must not replace backup metadata');
    const payload = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(payload);
    assert.strictEqual(payload.turns.length, 0);
    ok('stale snapshot update cannot revive old lifecycle files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function snapshotUpdateMergesIntoToolTurnAndFiltersTrackedHistory() {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'old\nnew\n');
    fs.writeFileSync(path.join(dir, 'src', 'other.txt'), 'historical\n');
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.processEditActivityEntry(parser, assistantToolLine('s1', dir, 'assistant-1', 'tool-1', 'Edit', {
      file_path: 'src/a.txt',
      old_string: 'old\n',
      new_string: 'old\nnew\n',
    }));
    T.processChangeReviewEntry(parser, snapshotLine('snapshot-history-id', {
      [path.join('src', 'a.txt')]: {
        backupFileName: 'backup-a@v1',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      },
      [path.join('src', 'other.txt')]: {
        backupFileName: 'backup-other@v1',
        version: 1,
        backupTime: '2026-06-03T09:00:01.000Z',
      },
    }, {
      entryMessageId: 'assistant-1',
      snapshotMessageId: 'snapshot-history-id',
      isSnapshotUpdate: true,
    }));
    T.processEditActivityEntry(parser, toolResultLine('s1', dir, 'tool-result-1', 'tool-1', 'assistant-1'));
    const payload = T.buildChangeReviewPayload(parser, finalizedReviewState('u1'));
    assert.strictEqual(payload.turns.length, 1);
    assert.strictEqual(payload.latestTurn.id, 'u1');
    assert.strictEqual(payload.latestTurn.files.length, 1, 'tracked history must not be shown as this turn');
    assert.strictEqual(payload.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'src/a.txt');
    assert.strictEqual(payload.latestTurn.files[0].hasBackup, true);
    assert.strictEqual(payload.latestTurn.files[0].backupFileName, 'backup-a@v1');
    assert.strictEqual(payload.latestTurn.files[0].added, 1);
    assert.strictEqual(payload.latestTurn.files[0].removed, 0);
    assert.strictEqual(payload.latestTurn.files[0].hasLineStats, true);
    ok('snapshot update merges into tool turn and filters tracked history');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function plainSnapshotDoesNotCreateAChangeReviewTurn() {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'new text\n');
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.processChangeReviewEntry(parser, snapshotLine('u1', {
      'a.txt': {
        backupFileName: 'missing-backup',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      },
    }));
    const payload = T.buildChangeReviewPayload(parser, finalizedReviewState('u1'));
    assertNoActiveTurn(payload);
    assert.strictEqual(payload.latestTurn, null);
    assert.strictEqual(payload.turns.length, 0);
    assert.strictEqual(payload.empty, true);
    ok('plain file-history snapshot does not create a +0/-0 change review turn');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function latticeMemoEditThenPlainSnapshotDoesNotMoveReviewToNextTurn() {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.sisyphus'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sisyphus', 'memo.md'), 'old\nnew\n');
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    const reviewState = { turns: {}, files: {} };

    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.processChangeReviewEntry(parser, snapshotUpdateLine('assistant-edit', {
      [path.join('.sisyphus', 'memo.md')]: {
        backupFileName: 'memo@v1',
        version: 1,
        backupTime: '2026-06-04T08:01:00.000Z',
      },
    }, { snapshotMessageId: 'old-baseline' }));
    T.processEditActivityEntry(parser, assistantToolLine('s1', dir, 'assistant-edit', 'tool-edit', 'Edit', {
      file_path: path.join('.sisyphus', 'memo.md'),
      old_string: 'old\n',
      new_string: 'old\nnew\n',
    }));
    T.processEditActivityEntry(parser, toolResultLine('s1', dir, 'tool-result-edit', 'tool-edit', 'assistant-edit'));
    T.markChangeReviewTurnFinalized(reviewState, 'u1');
    const first = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(first.turns.length, 1);
    assert.strictEqual(first.latestTurn.turnKey, 'u1');
    assert.strictEqual(first.latestTurn.files[0].displayPath.replace(/\\/g, '/'), '.sisyphus/memo.md');
    assert.strictEqual(first.latestTurn.files[0].hasBackup, true);
    assert.strictEqual(first.latestTurn.files[0].hasLineStats, true);

    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u2'));
    T.processChangeReviewEntry(parser, snapshotLine('u2', {
      [path.join('.sisyphus', 'memo.md')]: {
        backupFileName: 'memo@v2',
        version: 2,
        backupTime: '2026-06-04T08:03:24.000Z',
      },
    }));
    T.markChangeReviewTurnFinalized(reviewState, 'u2');
    const second = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(second.turns.length, 1, 'plain next-turn snapshot must not create a new review block');
    assert.strictEqual(second.latestTurn.turnKey, 'u1');
    assert.strictEqual(second.latestTurn.files[0].backupFileName, 'memo@v1');
    ok('Lattice memo edit + next plain snapshot does not become a +0/-0 next-turn review');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function latticeLongEditTurnShowsToolStatsAndIgnoresTrackedMemoResidual() {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.sisyphus'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.sisyphus', 'memo.md'), 'memo from previous turn\n');
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    const reviewState = { turns: {}, files: {} };
    const files = [
      ['apps/control_flutter/lib/main.dart', 2, 1],
      ['apps/control_flutter/lib/pages/onboarding/welcome_page.dart', 3, 2],
      ['apps/control_flutter/test/widget_test.dart', 1, 0],
      ['crates/lattice-coordinator/src/lib.rs', 2, 0],
      ['crates/lattice-ffi/src/lib.rs', 1, 1],
      ['spec/04-control-client-and-coordinator-deployment.md', 1, 1],
    ];

    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u-edit'));
    files.forEach(([filePath, added, removed], idx) => {
      const assistantUuid = 'assistant-edit-' + idx;
      const toolId = 'tool-edit-' + idx;
      const oldText = Array.from({ length: removed }, (_, i) => 'old ' + i).join('\n') + (removed ? '\n' : '');
      const newText = oldText + Array.from({ length: added }, (_, i) => 'new ' + i).join('\n') + (added ? '\n' : '');
      T.processChangeReviewEntry(parser, snapshotUpdateLine(assistantUuid, {
        [path.join('.sisyphus', 'memo.md')]: {
          backupFileName: 'memo@v2',
          version: 2,
          backupTime: '2026-06-04T08:00:00.000Z',
        },
        [filePath]: {
          backupFileName: 'backup-' + idx,
          version: 1,
          backupTime: '2026-06-04T08:10:0' + idx + '.000Z',
        },
      }, { snapshotMessageId: 'u-edit' }));
      T.processEditActivityEntry(parser, assistantToolLine('s1', dir, assistantUuid, toolId, 'Edit', {
        file_path: filePath,
        old_string: oldText,
        new_string: newText,
      }));
      T.processEditActivityEntry(parser, toolResultLine('s1', dir, 'tool-result-' + idx, toolId, assistantUuid));
    });
    T.markChangeReviewTurnFinalized(reviewState, 'u-edit');

    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u-next'));
    T.processChangeReviewEntry(parser, snapshotLine('u-next', {
      [path.join('.sisyphus', 'memo.md')]: {
        backupFileName: 'memo@v3',
        version: 3,
        backupTime: '2026-06-04T08:30:00.000Z',
      },
      ...Object.fromEntries(files.map(([filePath], idx) => [filePath, {
        backupFileName: 'backup-' + idx,
        version: 2,
        backupTime: '2026-06-04T08:30:0' + idx + '.000Z',
      }])),
    }));
    T.markChangeReviewTurnFinalized(reviewState, 'u-next');

    const payload = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(payload.turns.length, 1);
    assert.strictEqual(payload.latestTurn.turnKey, 'u-edit');
    assert.strictEqual(payload.latestTurn.files.length, files.length);
    assert.ok(!payload.latestTurn.files.some(file => file.displayPath.replace(/\\/g, '/') === '.sisyphus/memo.md'));
    assert.ok(payload.latestTurn.files.every(file => file.hasLineStats === true));
    assert.ok(payload.latestTurn.files.every(file => file.added > 0 || file.removed > 0));
    assert.strictEqual(parser.changeReviewSnapshotUpdates.size, 0, 'unmatched tracked memo snapshot updates must be pruned');
    ok('Lattice long edit turn shows tool line stats and ignores tracked memo residual');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function finalizedWriteOverwriteUsesBackupDiffForLargeFileStats() {
  const dir = tmp();
  const sessionId = 'cr-large-write-' + Date.now();
  const hist = backupDir(sessionId);
  try {
    fs.mkdirSync(hist, { recursive: true });
    const filePath = 'large-write.txt';
    const oldText = Array.from({ length: 800 }, (_, i) => 'old line ' + i).join('\n') + '\n';
    const newText = Array.from({ length: 900 }, (_, i) => 'new line ' + i).join('\n') + '\n';
    fs.writeFileSync(path.join(hist, 'large@v1'), oldText);
    fs.writeFileSync(path.join(dir, filePath), newText);
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', filePath, {
        backupFileName: 'large@v1',
        version: 1,
        backupTime: '2026-06-04T13:17:40.584Z',
      }, {
        name: 'Write',
        input: { file_path: filePath, content: newText },
      }),
    ]);

    const finalized = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assert.strictEqual(finalized.latestTurn.files.length, 1);
    assert.strictEqual(finalized.latestTurn.files[0].added, 900);
    assert.strictEqual(finalized.latestTurn.files[0].removed, 800);
    assert.strictEqual(finalized.latestTurn.files[0].hasLineStats, true);
    ok('finalized Write overwrite uses backup diff for large-file line stats');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hist, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function staleLineStatsGuardIsInvalidatedForOldCachedReviews() {
  const dir = tmp();
  const sessionId = 'cr-stale-line-stats-' + Date.now();
  const hist = backupDir(sessionId);
  try {
    fs.mkdirSync(hist, { recursive: true });
    const transcript = path.join(dir, sessionId + '.jsonl');
    const filePath = 'cached-large-write.txt';
    const oldText = Array.from({ length: 800 }, (_, i) => 'old cached ' + i).join('\n') + '\n';
    const newText = Array.from({ length: 900 }, (_, i) => 'new cached ' + i).join('\n') + '\n';
    fs.writeFileSync(path.join(hist, 'cached@v1'), oldText);
    fs.writeFileSync(path.join(dir, filePath), newText);
    const parser = T.createParser(transcript);
    T.processChangeReviewEntry(parser, userLine(sessionId, dir, 'u1'));
    T.processChangeReviewEntry(parser, snapshotUpdateLine('assistant-1', {
      [filePath]: {
        backupFileName: 'cached@v1',
        version: 1,
        backupTime: '2026-06-04T13:17:40.584Z',
      },
    }, { snapshotMessageId: 'u1' }));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      assistantUuid: 'assistant-1',
      filePath,
      added: 100,
      removed: 0,
    });
    const turn = parser.changeReviewTurns.get('u1');
    const file = Array.from(turn.files.values())[0];
    const reviewState = finalizedReviewState('u1');
    reviewState.files[file.id] = {
      status: 'pending',
      guard: {
        signature: [file.sessionId, file.turnKey, file.filePath, file.backupFileName, file.version].join('\0'),
      },
    };

    assert.strictEqual(T.captureChangeReviewGuards(parser, reviewState, { onlyFinalized: true }), true);
    assert.strictEqual(file.added, 900);
    assert.strictEqual(file.removed, 800);
    assert.strictEqual(reviewState.files[file.id].guard.lineStatsVersion, 2);
    ok('old cached change-review guards are invalidated for line-stat recalculation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hist, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function startedLifecycleShowsOnlyNewFilesForSameUuidRerun() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      filePath: 'a.txt',
      added: 1,
      removed: 0,
    });
    T.processChangeReviewEntry(parser, snapshotLine('u1', {
      'a.txt': { backupFileName: null, version: 1 },
    }));
    const reviewState = finalizedReviewState('u1');
    const oldPayload = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(oldPayload.turns.length, 1);
    const turn = parser.changeReviewTurns.get('u1');
    const oldFile = Array.from(turn.files.values())[0];
    oldFile.lastSeenAt = 1;
    const startedAt = T.markChangeReviewTurnStarted(reviewState, 'u1');
    turn.lifecycleStartedAt = startedAt;
    const emptyActive = T.buildChangeReviewPayload(parser, reviewState);
    assert.strictEqual(emptyActive.turns.length, 0);
    assertNoActiveTurn(emptyActive, 'rerun without a fresh file tool must not expose an active review');
    T.countChangeReviewTool(parser, {
      id: 'tool-2',
      turnKey: 'u1',
      filePath: 'b.txt',
      added: 2,
      removed: 1,
    });
    const active = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(active);
    assert.strictEqual(active.turns.length, 0);
    T.markChangeReviewTurnFinalized(reviewState, 'u1');
    const final = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(final);
    assert.strictEqual(final.turns.length, 1);
    assert.strictEqual(final.latestTurn.files.length, 1);
    assert.strictEqual(final.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'b.txt');
    ok('same-uuid rerun lifecycle shows only new files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function sameUuidRerunResetsSameFileSummary() {
  const dir = tmp();
  try {
    const parser = T.createParser(path.join(dir, 's1.jsonl'));
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      filePath: 'a.txt',
      added: 1,
      removed: 0,
    });
    T.processChangeReviewEntry(parser, snapshotLine('u1', {
      'a.txt': { backupFileName: null, version: 1 },
    }));
    const reviewState = finalizedReviewState('u1');
    const turn = parser.changeReviewTurns.get('u1');
    const file = Array.from(turn.files.values())[0];
    file.lastSeenAt = 1;
    const startedAt = T.markChangeReviewTurnStarted(reviewState, 'u1');
    turn.lifecycleStartedAt = startedAt;
    T.countChangeReviewTool(parser, {
      id: 'tool-2',
      turnKey: 'u1',
      filePath: 'a.txt',
      added: 5,
      removed: 4,
    });
    const activeFile = Array.from(turn.files.values())[0];
    assert.strictEqual(activeFile.added, 5, 'same-file rerun must reset old lifecycle additions');
    assert.strictEqual(activeFile.removed, 4, 'same-file rerun must reset old lifecycle removals');
    assert.strictEqual(activeFile.backupFileName, undefined, 'same-file rerun must wait for a fresh snapshot');
    const active = T.buildChangeReviewPayload(parser, reviewState);
    assertNoActiveTurn(active);
    assert.strictEqual(active.turns.length, 0);
    ok('same-uuid rerun resets same-file lifecycle summary');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function usageCacheHydratesChangeReviewHistory() {
  const dir = tmp();
  try {
    const transcript = path.join(dir, 's1.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify(userLine('s1', dir, 'u1')),
      JSON.stringify(snapshotUpdateLine('assistant-1', {
        'src/a.txt': {
          backupFileName: 'backup-a@v1',
          version: 1,
          backupTime: '2026-06-03T10:00:01.000Z',
        },
      })),
      '',
    ].join('\n'));
    const stat = fs.statSync(transcript);
    const parser = T.createParser(transcript);
    T.processChangeReviewEntry(parser, userLine('s1', dir, 'u1'));
    T.processChangeReviewEntry(parser, snapshotUpdateLine('assistant-1', {
      'src/a.txt': {
        backupFileName: 'backup-a@v1',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      },
    }));
    T.countChangeReviewTool(parser, {
      id: 'tool-1',
      turnKey: 'u1',
      assistantUuid: 'assistant-1',
      filePath: 'src/a.txt',
      added: 3,
      removed: 2,
    });
    parser.size = stat.size;
    parser.committedSize = stat.size;
    const index = T.serializeUsageCacheParser(parser, stat);
    const hydrated = T.createParser(transcript);
    assert.strictEqual(T.hydrateUsageCacheParser(hydrated, index), true);
    const payload = T.buildChangeReviewPayload(hydrated, finalizedReviewState('u1'));
    assert.strictEqual(payload.turns.length, 1);
    assert.strictEqual(payload.latestTurn.files.length, 1);
    assert.strictEqual(payload.latestTurn.files[0].hasBackup, true);
    assert.strictEqual(payload.latestTurn.files[0].added, 3);
    assert.strictEqual(payload.latestTurn.files[0].removed, 2);
    ok('usage cache hydrates change-review history');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function usageCacheHydratesAgentSummaryOnlyReviewHistory() {
  const dir = tmp();
  try {
    const transcript = path.join(dir, 's1.jsonl');
    const lines = [
      userLine('s1', dir, 'u1'),
      assistantToolLine('s1', dir, 'assistant-agent', 'tool-agent', 'Agent', {
        description: 'delegate file edits',
      }),
      toolResultLine('s1', dir, 'tool-result-agent', 'tool-agent', 'assistant-agent', {
        toolUseResult: {
          status: 'completed',
          toolStats: {
            editFileCount: 2,
            linesAdded: 533,
            linesRemoved: 0,
          },
        },
      }),
    ];
    fs.writeFileSync(transcript, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const stat = fs.statSync(transcript);
    const parser = T.createParser(transcript);
    for (const line of lines) {
      T.processChangeReviewEntry(parser, line);
      T.processEditActivityEntry(parser, line);
    }
    parser.size = stat.size;
    parser.committedSize = stat.size;
    const index = T.serializeUsageCacheParser(parser, stat);
    const hydrated = T.createParser(transcript);
    assert.strictEqual(T.hydrateUsageCacheParser(hydrated, index), true);
    const payload = T.buildChangeReviewPayload(hydrated, finalizedReviewState('u1'));
    assert.strictEqual(payload.turns.length, 1);
    assert.strictEqual(payload.latestTurn.files.length, 0);
    assert.strictEqual(payload.latestTurn.summary.files, 2);
    assert.strictEqual(payload.latestTurn.totals.added, 533);
    assert.strictEqual(payload.latestTurn.totals.hasLineStats, true);
    ok('usage cache hydrates Agent summary-only change-review history');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

(function identityUpdatePreservesKnownCwdWhenReviewHasNoCwdHint() {
  const dir = tmp();
  const sessionId = 'cr-identity-' + Date.now();
  try {
    const { state, comm } = makeHarness(dir, sessionId, [
      userLine(sessionId, dir, 'u1'),
    ]);
    T.handleChangeReviewIdentityUpdate(comm, state, { sessionId, cwd: null });
    assert.strictEqual(state.commIdentities.get(comm).cwd, dir);
    ok('identity update preserves existing cwd when review message omits cwd');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function rejectsCreatedFileByDeletingOnlyWhenGuardMatches() {
  const dir = tmp();
  const sessionId = 'cr-created-' + Date.now();
  try {
    const created = path.join(dir, 'created.txt');
    fs.writeFileSync(created, 'created by model\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'created.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, true);
    assert.ok(!fs.existsSync(created), 'created file should be removed');
    assert.strictEqual(result.payload.latestTurn.files[0].status, 'rejected');
    ok('reject created file: guarded delete');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function rejectsExistingFileByRestoringOfficialBackup() {
  const dir = tmp();
  const sessionId = 'cr-restore-' + Date.now();
  const hist = backupDir(sessionId);
  try {
    fs.mkdirSync(hist, { recursive: true });
    fs.writeFileSync(path.join(hist, 'old@v1'), 'old contents\n');
    fs.writeFileSync(path.join(dir, 'target.txt'), 'new contents\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'target.txt', {
        backupFileName: 'old@v1',
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }, {
        name: 'Edit',
        input: { file_path: 'target.txt', old_string: 'old contents\n', new_string: 'new contents\n' },
      }),
    ]);
    const finalized = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assert.strictEqual(finalized.latestTurn.files[0].hasLineStats, true);
    assert.strictEqual(finalized.latestTurn.files[0].added, 1);
    assert.strictEqual(finalized.latestTurn.files[0].removed, 1);
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'target.txt'), 'utf8'), 'old contents\n');
    ok('reject existing file: restore official backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hist, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function rejectTurnAfterSameUuidRerunOnlyTouchesFreshLifecycleFiles() {
  const dir = tmp();
  const sessionId = 'cr-lifecycle-reject-' + Date.now();
  try {
    const oldFile = path.join(dir, 'old.txt');
    const newFile = path.join(dir, 'new.txt');
    fs.writeFileSync(oldFile, 'old lifecycle model file\n');
    fs.writeFileSync(newFile, 'new lifecycle model file\n');
    const { state, comm, transcript } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'old.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    const oldFinal = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assert.strictEqual(oldFinal.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'old.txt');
    const parser = state.parsers.get(transcript);
    const turn = parser.changeReviewTurns.get('u1');
    const staleOld = Array.from(turn.files.values())[0];
    staleOld.lastSeenAt = 1;
    const started = T.resolveChangeReviewTurnStarted(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assertNoActiveTurn(started, 'same-uuid rerun starts with no active payload');
    T.processChangeReviewEntry(parser, snapshotUpdateLine('assistant-new', {
      'new.txt': {
        backupFileName: null,
        version: 2,
        backupTime: '2026-06-03T10:00:02.000Z',
      },
    }));
    T.countChangeReviewTool(parser, {
      id: 'tool-new',
      turnKey: 'u1',
      assistantUuid: 'assistant-new',
      filePath: 'new.txt',
      added: 1,
      removed: 0,
    });
    const newFinal = T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    assertNoActiveTurn(newFinal);
    assert.strictEqual(newFinal.latestTurn.files.length, 1);
    assert.strictEqual(newFinal.latestTurn.files[0].displayPath.replace(/\\/g, '/'), 'new.txt');
    const reviewState = state.changeReviewStates.get(sessionId);
    const oldId = T.changeReviewEntryId(sessionId, 'u1', oldFile);
    const newId = T.changeReviewEntryId(sessionId, 'u1', newFile);
    assert.strictEqual(reviewState.files[oldId], undefined, 'hidden old lifecycle file must not get a fresh guard state');
    assert.ok(reviewState.files[newId], 'fresh lifecycle file must get a guard state');
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results.length, 1, 'reject turn must clear only fresh lifecycle files');
    assert.ok(fs.existsSync(oldFile), 'old lifecycle file must not be deleted by the rerun reject');
    assert.ok(!fs.existsSync(newFile), 'fresh lifecycle created file should be deleted');
    ok('reject turn after same-uuid rerun touches only fresh lifecycle files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function staleGuardRefusesUserModifiedFile() {
  const dir = tmp();
  const sessionId = 'cr-stale-' + Date.now();
  try {
    const created = path.join(dir, 'created.txt');
    fs.writeFileSync(created, 'model version\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'created.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    T.resolveChangeReviewTurnFinalized(state, comm, { sessionId, cwd: dir, turnKey: 'u1' });
    const parserPayload = T.resolveChangeReviewDiff(state, comm, {
      sessionId,
      cwd: dir,
      fileId: T.changeReviewEntryId(sessionId, 'u1', created),
    });
    assert.strictEqual(parserPayload.ok, true);
    assert.strictEqual(parserPayload.diff.oldText, '');
    assert.strictEqual(parserPayload.diff.newText, 'model version\n');
    fs.writeFileSync(created, 'user changed it\n');
    const result = T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: false,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(fs.existsSync(created), 'stale file must not be deleted');
    assert.strictEqual(result.payload.latestTurn.files[0].status, 'stale');
    ok('stale guard refuses reject after user modification');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

(function busyRejectIsRefused() {
  const dir = tmp();
  const sessionId = 'cr-busy-' + Date.now();
  try {
    fs.writeFileSync(path.join(dir, 'created.txt'), 'model version\n');
    const { state, comm } = makeHarness(dir, sessionId, [
      ...successfulWriteLines(sessionId, dir, 'u1', 'created.txt', {
        backupFileName: null,
        version: 1,
        backupTime: '2026-06-03T10:00:01.000Z',
      }),
    ]);
    assert.throws(() => T.resolveChangeReviewReject(state, comm, {
      sessionId,
      cwd: dir,
      turnKey: 'u1',
      busy: true,
    }), /current reply/);
    ok('busy reject is refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(reviewStatePath(sessionId), { force: true });
  }
})();

console.log(`change-review tests passed: ${passed}`);
