'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require('../data/host-badge.cjs').__test;

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'incipit-session-identity-'));
}

function withFakeHome(home, fn) {
  const desc = Object.getOwnPropertyDescriptor(os, 'homedir');
  Object.defineProperty(os, 'homedir', {
    configurable: true,
    value: () => home,
  });
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(os, 'homedir', desc);
  }
}

function encodedProjectDir(home, cwd) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function writeTranscript(home, cwd, sessionId, lines = []) {
  const dir = encodedProjectDir(home, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionId + '.jsonl');
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : ''));
  return file;
}

function makeState(comm, sessionId, cwd, target) {
  return {
    comms: new Set([comm]),
    commIdentities: new Map([[comm, { sessionId, cwd, target }]]),
    targetCache: new Map(),
    parsers: new Map(),
    changeReviewStates: new Map(),
    log() {},
  };
}

console.log('session identity binding');

(function cwdHintChoosesExactTranscriptAndFailsClosedOnMiss() {
  const home = tmp();
  const sessionId = 'same-session-id';
  const cwdA = '/workspace/alpha';
  const cwdB = '/workspace/beta';
  try {
    withFakeHome(home, () => {
      const fileA = writeTranscript(home, cwdA, sessionId);
      const fileB = writeTranscript(home, cwdB, sessionId);
      assert.strictEqual(path.resolve(T.resolveTargetFromIdentity(sessionId, cwdA)), path.resolve(fileA));
      assert.strictEqual(path.resolve(T.resolveTargetFromIdentity(sessionId, cwdB)), path.resolve(fileB));
      assert.strictEqual(T.resolveTargetFromIdentity(sessionId, '/workspace/missing'), null);
      const legacy = T.resolveTargetFromIdentity(sessionId, null);
      assert.ok(
        [path.resolve(fileA), path.resolve(fileB)].includes(path.resolve(legacy)),
        'legacy no-cwd fallback may find either exact session file, but cwd hints must be strict',
      );
    });
    ok('cwd hint binds a session id to the project-local JSONL');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})();

(function missingCwdMessagePreservesKnownIdentityCwd() {
  const home = tmp();
  const sessionId = 'known-cwd-session';
  const cwd = '/workspace/project';
  try {
    withFakeHome(home, () => {
      const target = writeTranscript(home, cwd, sessionId);
      const comm = { webview: { postMessage() {} } };

      const badgeState = makeState(comm, sessionId, cwd, target);
      T.handleBadgeIdentityUpdate(comm, badgeState, { sessionId, includeHistory: false });
      assert.strictEqual(badgeState.commIdentities.get(comm).cwd, cwd);
      assert.strictEqual(path.resolve(badgeState.commIdentities.get(comm).target), path.resolve(target));

      const editState = makeState(comm, sessionId, cwd, target);
      T.handleEditActivityIdentityUpdate(comm, editState, { sessionId, includeProject: false });
      assert.strictEqual(editState.commIdentities.get(comm).cwd, cwd);
      assert.strictEqual(path.resolve(editState.commIdentities.get(comm).target), path.resolve(target));
    });
    ok('badge/edit identity updates do not clear an already known cwd');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})();

console.log('\nPASSED: ' + passed + ' checks');
