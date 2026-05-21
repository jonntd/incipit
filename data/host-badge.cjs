'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const GLOBAL_KEY = '__cceBadge';
let vscodeApi = null;
// `POLL_INTERVAL_MS` matches the 0.1.10 cadence. We layer event-driven
// `schedulePoll(WRITE_POLL_DEBOUNCE_MS)` on top via wrappers around
// `fs.appendFile`/`writeFile` callbacks and `createWriteStream`'s
// `finish`/`close`/`end` events, so most writes get a faster refresh
// than the interval — but the interval itself stays at 1.5s because the
// JSONL stream Claude Code opens generally never `finish`/`close` for
// the life of a session, leaving us with only the interval as a backstop.
const POLL_INTERVAL_MS = 1500;
const WRITE_POLL_DEBOUNCE_MS = 120;
const JSONL_SUFFIX = '.jsonl';
const USAGE_CACHE_SCHEMA_VERSION = 1;
const USAGE_CACHE_INDEX_DIR = path.join(os.homedir(), '.incipit', 'claude-usage-cache-v1');
const USAGE_CACHE_HASH_BYTES = 4096;
const EDIT_ACTIVITY_SCHEMA_VERSION = 1;
const EDIT_ACTIVITY_INDEX_DIR = path.join(os.homedir(), '.incipit', 'claude-edit-activity-v1');
const PROJECT_INDEX_BATCH_FILES = 2;
const PROJECT_INDEX_BATCH_BYTES = 8 * 1024 * 1024;
const PROJECT_INDEX_BATCH_DELAY_MS = 45;
const PROJECT_INDEX_SCAN_MIN_INTERVAL_MS = 12000;
const GLOBAL_INDEX_SCAN_MIN_INTERVAL_MS = 60000;
// Keep rollback tokens long enough to cover Claude Code's 5-minute
// launch/byte watchdog path, but cap entries because each one keeps
// the original transcript text in memory until send succeeds or fails.
const TRUNCATE_ROLLBACK_TTL_MS = 6 * 60 * 1000;
const TRUNCATE_ROLLBACK_MAX = 3;
// Cache-hit history is transported as a BOUNDED array of aggregate
// buckets, never one entry per request. `parser.order.map(...)` is
// O(requests) bytes re-serialized over postMessage every turn the cache
// popup is open; on a long-lived npm-published session that grows
// without limit (50k requests ≈ 6MB per refresh). Buckets keep the wire
// + retained cost constant regardless of session length. Each bucket
// carries EXACT partial sums of the real requests it spans, so summing
// any contiguous run of buckets reproduces the exact totals/mean/min the
// full array would have — only the brush *selection granularity*
// coarsens (a bucket can't be split); the numbers never become
// estimates. When requests <= HISTORY_MAX_BUCKETS every bucket is
// exactly one request, i.e. byte-for-byte the old per-request behaviour.
const HISTORY_MAX_BUCKETS = 1500;

function attachComm(comm) {
  const state = getOrCreateState();
  state.comms.add(comm);
  wrapShutdown(comm, state);
  attachMessageHandler(comm, state);
  startPolling(state);
}

function getOrCreateState() {
  const globalRef = globalThis;
  if (globalRef[GLOBAL_KEY]) return globalRef[GLOBAL_KEY];
  const state = createState();
  globalRef[GLOBAL_KEY] = state;
  return state;
}

function createState() {
  return {
    comms: new Set(),
    started: false,
    patchedFs: false,
    ourFile: null,
    commIdentities: new Map(),
    targetCache: new Map(),
    parsers: new Map(),
    timer: null,
    pollTimer: null,
    tick: null,
    editProjectIndexes: new Map(),
    editProjectJobs: new Map(),
    editProjectScanAt: new Map(),
    editGlobalJob: null,
    editGlobalScanAt: 0,
    truncateRollbacks: new Map(),
    log(message) {
      try { console.log(`[cceBadge] ${message}`); } catch (_) {}
    },
  };
}

function wrapShutdown(comm, state) {
  if (!comm || comm.__cceBadgeWrapped) return;
  if (typeof comm.shutdown !== 'function') {
    throw new Error('[cceBadge] attachComm expected a comm with shutdown()');
  }
  const original = comm.shutdown;
  comm.__cceBadgeWrapped = true;
  comm.shutdown = async function wrappedShutdown() {
    state.comms.delete(comm);
    state.commIdentities.delete(comm);
    if (comm.__incipitMessageDisposable && typeof comm.__incipitMessageDisposable.dispose === 'function') {
      try { comm.__incipitMessageDisposable.dispose(); } catch (_) {}
      comm.__incipitMessageDisposable = null;
    }
    if (state.comms.size === 0) stopPolling(state);
    return original.apply(this, arguments);
  };
}

function attachMessageHandler(comm, state) {
  if (!comm || comm.__incipitMessageHandlerAttached) return;
  const webview = comm.webview;
  if (!webview || typeof webview.onDidReceiveMessage !== 'function') return;
  comm.__incipitMessageHandlerAttached = true;
  comm.__incipitMessageDisposable = webview.onDidReceiveMessage(message => {
    handleWebviewMessage(comm, state, message);
  });
}

function handleWebviewMessage(comm, state, message) {
  if (!message || message.__incipit !== true) return;
  if (message.type === 'badge_identity_update') {
    handleBadgeIdentityUpdate(comm, state, message);
    return;
  }
  if (message.type === 'edit_activity_identity_update') {
    handleEditActivityIdentityUpdate(comm, state, message);
    return;
  }
  if (message.type === 'diff_line_info_request') {
    handleDiffLineInfoRequest(comm, state, message);
    return;
  }
  if (message.type === 'conversation_mutation_request') {
    handleConversationMutationRequest(comm, state, message);
    return;
  }
  if (message.type === 'file_reveal_request') {
    handleFileRevealRequest(comm, state, message);
  }
}

function handleBadgeIdentityUpdate(comm, state, message) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const includeHistory = message.includeHistory === true;
  if (!sessionId) {
    state.commIdentities.delete(comm);
    sendPayload(comm, emptyBadgePayload(null, null));
    return;
  }
  const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
  const previous = state.commIdentities.get(comm);
  if (previous && previous.sessionId === sessionId && previous.cwd === cwd && previous.target) {
    sendCurrentBadgePayload(state, comm, previous.target, sessionId, includeHistory);
    return;
  }
  const target = resolveTargetFromIdentity(sessionId, cwd);
  const identity = { sessionId, cwd, target };
  state.commIdentities.set(comm, identity);
  if (!target) {
    sendPayload(comm, emptyBadgePayload(sessionId, null));
    return;
  }
  sendCurrentBadgePayload(state, comm, target, sessionId, includeHistory);
}

function handleEditActivityIdentityUpdate(comm, state, message) {
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
  const includeProject = message.includeProject === true;
  if (!sessionId) {
    state.commIdentities.delete(comm);
    if (includeProject) {
      sendEditActivityPayload(
        comm,
        editActivityEnvelope(
          emptyEditActivityPayload(null, null),
          buildProjectEditActivityResponse(state, null, comm, null)
        )
      );
      return;
    }
    sendEditActivityPayload(comm, emptyEditActivityPayload(null, null));
    return;
  }
  const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : null;
  const previous = state.commIdentities.get(comm);
  if (previous && previous.sessionId === sessionId && previous.cwd === cwd && previous.target) {
    sendCurrentEditActivityPayload(state, comm, previous.target, sessionId, includeProject);
    return;
  }
  const target = resolveTargetFromIdentity(sessionId, cwd);
  const identity = { sessionId, cwd, target };
  state.commIdentities.set(comm, identity);
  if (!target) {
    if (includeProject) {
      sendEditActivityPayload(
        comm,
        editActivityEnvelope(
          emptyEditActivityPayload(sessionId, null),
          buildProjectEditActivityResponse(state, null, comm, sessionId)
        )
      );
      return;
    }
    sendEditActivityPayload(comm, emptyEditActivityPayload(sessionId, null));
    return;
  }
  sendCurrentEditActivityPayload(state, comm, target, sessionId, includeProject);
}

function handleDiffLineInfoRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'diff_line_info_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(resolveDiffLineInfo(message));
  } catch (error) {
    state.log(`diff line info error: ${error && error.message ? error.message : error}`);
    reply({ error: String(error && error.message ? error.message : error) });
  }
}

function handleConversationMutationRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'conversation_mutation_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(resolveConversationMutation(state, message));
  } catch (error) {
    state.log(`conversation mutation error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

async function handleFileRevealRequest(comm, state, message) {
  const requestId = message.requestId;
  const reply = payload => {
    try {
      comm.webview.postMessage({
        __incipit: true,
        type: 'file_reveal_response',
        requestId,
        payload,
      });
    } catch (_) {}
  };
  try {
    reply(await revealContainingFolder(message));
  } catch (error) {
    state.log(`file reveal error: ${error && error.message ? error.message : error}`);
    reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function getVSCodeApi() {
  if (vscodeApi) return vscodeApi;
  // Loaded lazily so unit tests can parse this helper outside VS Code.
  vscodeApi = require('vscode');
  return vscodeApi;
}

function decodePathSegment(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function normalizeFileRevealPath(value) {
  let raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('No file path supplied.');
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    raw = url.pathname || '';
    if (/^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
    raw = process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw;
  }
  const hashIndex = raw.indexOf('#');
  if (hashIndex !== -1) raw = raw.slice(0, hashIndex);
  const queryIndex = raw.indexOf('?');
  if (queryIndex !== -1) raw = raw.slice(0, queryIndex);
  raw = decodePathSegment(raw).trim();
  if (!raw) throw new Error('No file path supplied.');
  return raw;
}

function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function revealContainingFolder(message) {
  const vscode = getVSCodeApi();
  const cwd = typeof message.cwd === 'string' && message.cwd ? message.cwd : '';
  const raw = normalizeFileRevealPath(message.filePath);
  if (!path.isAbsolute(raw) && !cwd) {
    throw new Error('Relative file path has no workspace cwd.');
  }
  const resolved = path.resolve(cwd || process.cwd(), raw);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw new Error('File path does not exist.');
  }

  if (cwd) {
    const realRoot = fs.realpathSync(cwd);
    const realTarget = fs.realpathSync(resolved);
    if (!isPathInside(realTarget, realRoot)) {
      throw new Error('File path is outside the active workspace.');
    }
  }

  const directoryPath = stat.isDirectory() ? resolved : path.dirname(resolved);
  // VS Code public API: open the directory URI with the operating system's
  // external handler. This is a real OS file-manager reveal of the containing
  // folder, not a `revealInExplorer` sidebar fallback.
  const ok = await vscode.env.openExternal(vscode.Uri.file(directoryPath));
  if (ok === false) throw new Error('VS Code could not open the containing folder.');
  return { ok: true, directoryPath };
}

function resolveDiffLineInfo(message) {
  const filePath = typeof message.filePath === 'string' ? message.filePath : '';
  if (!filePath || !path.isAbsolute(filePath)) {
    return { startLine: null, oldStartLine: null, newStartLine: null };
  }
  if (!fs.existsSync(filePath)) {
    return { startLine: null, oldStartLine: null, newStartLine: null, missing: true };
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const oldText = typeof message.oldText === 'string' ? message.oldText : '';
  const newText = typeof message.newText === 'string' ? message.newText : '';
  const newStartLine = findSnippetStartLine(text, newText) || findSnippetStartLine(text, oldText);
  const oldStartLine = findSnippetStartLine(text, oldText) || newStartLine;
  return {
    startLine: newStartLine || oldStartLine || null,
    oldStartLine: oldStartLine || null,
    newStartLine: newStartLine || oldStartLine || null,
  };
}

function normalizeTextForSearch(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function findSnippetStartLine(fileText, snippet) {
  const haystack = normalizeTextForSearch(fileText);
  const needle = normalizeTextForSearch(snippet);
  if (!needle) return null;
  let index = haystack.indexOf(needle);
  if (index < 0) {
    const trimmed = needle.trim();
    if (trimmed && trimmed !== needle) index = haystack.indexOf(trimmed);
  }
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (haystack.charCodeAt(i) === 10) line++;
  }
  return line;
}

function resolveConversationMutation(state, message) {
  // The webview pulls `sessionId` straight off the connection's
  // `activeSessionId` signal (decompiled `Jn.activeSessionId.value`).
  // That's the canonical identity for the current panel — pinpointing
  // the exact JSONL file even with multi-window / multi-panel /
  // sidebar-vs-editor topologies. We never want to silently fall back
  // to "newest mtime" when an explicit sessionId was provided but
  // doesn't resolve, because that is exactly how we'd write into the
  // wrong session.
  // Fail closed when no sessionId is supplied. The webview is the only
  // caller and 0.1.5+ always passes one (`transcriptRecordIdentity()`
  // reads `Jn.activeSessionId.value`). If the fiber pierce fails, the
  // webview fails up-front and never reaches the host, so the only way
  // we'd land here is a stale shape on a future Claude Code release —
  // and the legacy newest-mtime fallback is exactly the heuristic that
  // could silently mutate a different transcript file in multi-window /
  // multi-panel / sidebar-vs-editor setups (memo red line: "不要退回
  // newest-mtime"). Refuse instead; the user gets a toast and reloads.
  if (typeof message.sessionId !== 'string' || !message.sessionId) {
    throw new Error(
      'Missing sessionId on transcript mutation request. ' +
      'Reload the window and try again.'
    );
  }
  const target = resolveTargetFromIdentity(message.sessionId, message.cwd);
  if (!target || !fs.existsSync(target)) {
    throw new Error(
      `Could not locate transcript JSONL for session ${message.sessionId}. ` +
      `Reload the window and try again.`
    );
  }

  const op = typeof message.op === 'string' ? message.op : '';
  if (!op) throw new Error('Missing transcript mutation operation');

  if (op === 'resolve_assistant_uuid') {
    const transcript = readTranscript(target);
    return resolveAssistantUuid(transcript, message);
  }

  const uuid = typeof message.uuid === 'string' ? message.uuid : '';
  if (!uuid) throw new Error('Missing message uuid');

  if (op === 'rollback_truncate_from_user') {
    return rollbackTruncateFromUser(state, target, uuid, message);
  }

  if (op === 'peek_truncate_state') {
    return peekTruncateState(state, target, uuid, message);
  }

  if (op === 'get_message') {
    const transcript = readTranscript(target);
    const rows = transcript.rowsByUuid.get(uuid);
    if (!rows || !rows.length) throw new Error(`Message ${uuid} was not found`);
    const row = rows[rows.length - 1];
    return {
      ok: true,
      op,
      uuid,
      filePath: target,
      type: row.entry.type || null,
      text: editableTextFromEntry(row.entry),
      canEditUser: canEditUserEntry(row.entry),
      canEditAssistantText: canEditAssistantTextEntry(row.entry),
      canRerun: row.entry.type === 'user' && canEditUserEntry(row.entry),
    };
  }

  const before = fs.statSync(target);
  const transcript = readTranscript(target);
  let result;
  if (op === 'edit_user') {
    // Rich path: caller sent an explicit `blocks` spec listing kept
    // (by index) refs/images plus new text/image blocks. Lets the
    // user remove individual ide_* attachments and images instead of
    // forcing the legacy first-text-block overwrite.
    if (Array.isArray(message.blocks)) {
      result = applyUserBlockEdit(transcript, uuid, message.blocks);
    } else {
      result = applyUserEdit(transcript, uuid, textPayload(message));
    }
  } else if (op === 'edit_assistant_text') {
    result = applyAssistantTextEdit(transcript, uuid, textPayload(message));
  } else if (op === 'truncate_from_user') {
    result = applyTruncateFromUser(transcript, uuid);
  } else {
    throw new Error(`Unsupported transcript mutation operation: ${op}`);
  }

  if (!result || !result.changed) {
    return { ok: true, op, uuid, changed: false, filePath: target };
  }

  const current = fs.statSync(target);
  if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
    throw new Error('Transcript changed while editing; please try again after the current response finishes');
  }

  // Note: we deliberately do NOT write persistent transcript backups.
  // Earlier versions wrote a full JSONL copy under
  // `~/.incipit-backup/jsonl-history/` per mutation, which accumulated
  // hundreds of MB on real users without ever being read back (no UI
  // surfaced an "undo edit" affordance against the copy). The host's
  // own JSONL append-log + git history of the project itself remain
  // the recovery mechanisms. Rerun truncation is the one exception in
  // shape: it gets a short-lived in-memory rollback token below, only
  // to cover `session.send()` failing before a replacement append.
  const nextText = serializeTranscript(transcript);
  atomicWriteTranscript(target, nextText);
  let rollbackToken = null;
  let rollbackExpiresAt = null;
  if (op === 'truncate_from_user') {
    const rollback = registerTruncateRollback(state, {
      target,
      sessionId: message.sessionId,
      uuid,
      beforeText: transcript.rawText || '',
      afterText: nextText,
    });
    rollbackToken = rollback.token;
    rollbackExpiresAt = rollback.expiresAt;
  }
  resetTranscriptParserState(state, target);
  try { poll(state); } catch (_) {}

  return {
    ok: true,
    op,
    uuid,
    changed: true,
    droppedUuids: result.droppedUuids || [],
    droppedFromIndex: result.droppedFromIndex == null ? null : result.droppedFromIndex,
    rollbackToken,
    rollbackExpiresAt,
    filePath: target,
    reloadRecommended: true,
  };
}

function registerTruncateRollback(state, entry) {
  pruneTruncateRollbacks(state, Date.now());
  const token = createRollbackToken();
  const now = Date.now();
  const expiresAt = now + TRUNCATE_ROLLBACK_TTL_MS;
  state.truncateRollbacks.set(token, {
    target: entry.target,
    sessionId: entry.sessionId,
    uuid: entry.uuid,
    beforeText: entry.beforeText,
    afterLength: String(entry.afterText || '').length,
    afterHash: hashText(entry.afterText || ''),
    createdAt: now,
    expiresAt,
  });
  while (state.truncateRollbacks.size > TRUNCATE_ROLLBACK_MAX) {
    const first = state.truncateRollbacks.keys().next().value;
    if (!first) break;
    state.truncateRollbacks.delete(first);
  }
  return { token, expiresAt };
}

function pruneTruncateRollbacks(state, now) {
  if (!state.truncateRollbacks || typeof state.truncateRollbacks.entries !== 'function') {
    state.truncateRollbacks = new Map();
    return;
  }
  for (const [token, entry] of state.truncateRollbacks.entries()) {
    if (!entry || entry.expiresAt <= now) state.truncateRollbacks.delete(token);
  }
}

function createRollbackToken() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function matchesRollbackAfterText(text, entry) {
  return (
    String(text || '').length === entry.afterLength &&
    hashText(text) === entry.afterHash
  );
}

function rollbackTruncateFromUser(state, target, uuid, message) {
  pruneTruncateRollbacks(state, Date.now());
  const token = typeof message.rollbackToken === 'string' ? message.rollbackToken : '';
  if (!token) throw new Error('Missing rerun rollback token');
  const entry = state.truncateRollbacks && state.truncateRollbacks.get(token);
  if (!entry) {
    return {
      ok: true,
      op: 'rollback_truncate_from_user',
      uuid,
      changed: false,
      rolledBack: false,
      reason: 'expired_or_missing',
      filePath: target,
    };
  }
  if (entry.target !== target || entry.uuid !== uuid || entry.sessionId !== message.sessionId) {
    throw new Error('Rerun rollback token does not match this transcript');
  }
  const currentText = fs.readFileSync(target, 'utf8');
  if (!matchesRollbackAfterText(currentText, entry)) {
    state.truncateRollbacks.delete(token);
    return {
      ok: true,
      op: 'rollback_truncate_from_user',
      uuid,
      changed: false,
      rolledBack: false,
      reason: 'transcript_advanced',
      filePath: target,
    };
  }
  atomicWriteTranscript(target, entry.beforeText);
  state.truncateRollbacks.delete(token);
  resetTranscriptParserState(state, target);
  try { poll(state); } catch (_) {}
  return {
    ok: true,
    op: 'rollback_truncate_from_user',
    uuid,
    changed: true,
    rolledBack: true,
    filePath: target,
    reloadRecommended: true,
  };
}

// Read-only quiescence probe used by the rerun teardown serializer.
//
// After `truncate_from_user` writes the cut JSONL, incipit must NOT spawn
// the resume CLI until the *previous* (just-interrupted) CLI has fully
// stopped writing — otherwise two live streams append to the same file
// and the host's root stream-assembler throws
// `Mismatched content block type content_block_delta thinking`.
//
// The truncate registered a rollback entry holding the exact post-cut
// text length + sha256. Here we compare the current on-disk file to that
// fingerprint WITHOUT consuming the token or writing anything:
//   - `advanced:false`  → file is byte-identical to the cut text: no
//                          other writer (old CLI / task-notification
//                          background append) has touched it. Safe to
//                          resend once this has held stable for a window.
//   - `advanced:true`   → something appended after the cut (stale CLI
//                          still flushing, or a host-injected
//                          task-notification continuation). The caller
//                          must fail safe (roll back / abort) instead of
//                          starting a second concurrent stream.
// `hasToken:false` means the rollback token expired; the caller then
// falls back to busy + stat-stability only.
function peekTruncateState(state, target, uuid, message) {
  pruneTruncateRollbacks(state, Date.now());
  const token = typeof message.rollbackToken === 'string' ? message.rollbackToken : '';
  const entry = token && state.truncateRollbacks && state.truncateRollbacks.get(token);
  let sizeBytes = null;
  let mtimeMs = null;
  try {
    const st = fs.statSync(target);
    sizeBytes = st.size;
    mtimeMs = st.mtimeMs;
  } catch (_) {}
  if (!entry) {
    return {
      ok: true,
      op: 'peek_truncate_state',
      uuid,
      hasToken: false,
      advanced: null,
      sizeBytes,
      mtimeMs,
      filePath: target,
    };
  }
  if (entry.target !== target || entry.uuid !== uuid || entry.sessionId !== message.sessionId) {
    throw new Error('Peek rollback token does not match this transcript');
  }
  let advanced = true;
  try {
    advanced = !matchesRollbackAfterText(fs.readFileSync(target, 'utf8'), entry);
  } catch (_) {
    advanced = true;
  }
  return {
    ok: true,
    op: 'peek_truncate_state',
    uuid,
    hasToken: true,
    advanced,
    sizeBytes,
    mtimeMs,
    filePath: target,
  };
}

function textPayload(message) {
  if (typeof message.text !== 'string') throw new Error('Missing replacement text');
  return message.text;
}

function resolveAssistantUuid(transcript, message) {
  const betaMessageId = typeof message.betaMessageId === 'string' ? message.betaMessageId : '';
  if (!betaMessageId) throw new Error('Missing assistant message id');
  const requestedTail = normalizeLookupText(message.textTail || '');

  for (let i = transcript.rows.length - 1; i >= 0; i--) {
    const entry = transcript.rows[i].entry;
    if (!entry || entry.type !== 'assistant') continue;
    if (!entry.message || entry.message.id !== betaMessageId) continue;
    const uuid = typeof entry.uuid === 'string' ? entry.uuid : '';
    if (!uuid) continue;
    const text = editableTextFromEntry(entry);
    const normalized = normalizeLookupText(text);
    const tailMatched = requestedTail.length < 24 ||
      normalized.includes(requestedTail) ||
      requestedTail.includes(normalized.slice(-Math.min(normalized.length, requestedTail.length)));
    return {
      ok: true,
      op: 'resolve_assistant_uuid',
      uuid,
      matched: true,
      tailMatched,
      canEditAssistantText: canEditAssistantTextEntry(entry),
    };
  }

  return {
    ok: true,
    op: 'resolve_assistant_uuid',
    uuid: null,
    matched: false,
  };
}

function normalizeLookupText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function readTranscript(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const hasFinalNewline = /\r?\n$/.test(raw);
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  if (hasFinalNewline && lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((line, index) => {
    const row = { raw: line, index, entry: null, changed: false, drop: false };
    if (line.trim()) {
      try { row.entry = JSON.parse(line); } catch (_) {}
    }
    return row;
  });
  // `rowsByUuid` is Map<string, Row[]> rather than a single-row map:
  // compacted JSONLs preserve segments and re-emit the same uuid in
  // both places (audited at 905 duplicate rows / 451 groups across 72
  // local sessions, with 251 of those groups containing tool_use or
  // tool_result blocks). A naive `.set(uuid, row)` overwrites earlier
  // copies and edit/truncate operations would only see the latest one,
  // letting stale duplicates survive. Edits walk every row sharing a
  // uuid; truncate cuts at the latest row's index but keeps earlier
  // duplicates as legitimate history.
  const transcript = {
    filePath,
    rawText: raw,
    rows,
    hasFinalNewline,
    rowsByUuid: new Map(),
    sessionId: path.basename(filePath, JSONL_SUFFIX),
  };
  for (const row of rows) {
    const entry = row.entry;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.sessionId === 'string' && entry.sessionId) transcript.sessionId = entry.sessionId;
    if (typeof entry.uuid === 'string') {
      const list = transcript.rowsByUuid.get(entry.uuid);
      if (list) list.push(row);
      else transcript.rowsByUuid.set(entry.uuid, [row]);
    }
  }
  return transcript;
}

function serializeTranscript(transcript) {
  const lines = [];
  for (const row of transcript.rows) {
    if (row.drop) continue;
    if (row.entry && row.changed) lines.push(JSON.stringify(row.entry));
    else lines.push(row.raw);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// (Transcript JSONL backups removed; see comment above the
//  `atomicWriteTranscript` call. `sanitizeFilePart` was only used by
//  the backup helper and is removed alongside it.)

function atomicWriteTranscript(filePath, text) {
  const tmp = `${filePath}.incipit-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function resetTranscriptParserState(state, filePath) {
  if (!filePath) return;
  state.targetCache.delete(filePath);
  state.parsers.delete(filePath);
  deleteUsageCacheIndex(filePath);
}

// Apply a text replacement to *every* row sharing this uuid. Compact
// preservation can produce duplicate-uuid rows (verified at 905 dup
// rows / 451 groups across 72 local sessions); editing only the
// latest copy would let stale text hiding in earlier copies resurface
// after another compact. Sample-check the latest row's type for
// validation; if any row reports a change, the operation succeeded.
function applyUserEdit(transcript, uuid, text) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'user') throw new Error('Only user messages can be edited with this operation');
  if (!canEditUserEntry(sample)) {
    throw new Error('Tool result records cannot be edited; rerun the prior user message instead');
  }
  let any = false;
  for (const row of rows) {
    if (replaceTextContent(row.entry, text, { requireExistingText: false })) {
      row.changed = true;
      any = true;
    }
  }
  return { changed: any };
}

// Block-aware user edit. The webview chip strip lets the user drop
// individual ide_opened_file/ide_selection refs and images, and add
// new images via paste/drop/file-pick. On save the webview sends a
// `blocks` spec describing the new content array as a sequence of:
//   { kind:'keep', index } — preserve the original block at that index
//   { kind:'text', text }  — new text block (the user's prose)
//   { kind:'image', source:{type:'base64', media_type, data} } — new image
//
// Validation contract (every spec must clear these gates before any
// row is mutated; one bad spec fails the whole op so partial rebuilds
// can't sneak through):
//   - keep.index is a non-negative integer; per-row range check is
//     applied below (dup-uuid rows MAY have different lengths, though
//     compact-preserved dups normally don't)
//   - text.text is a string; must NOT begin with `<ide_*>` so the user
//     cannot synthesize a fake auto-attached ref via the prose box
//   - image.source.type === 'base64' with valid media_type + data
//
// Per-row application gate: only keep blocks of type 'text' or 'image'
// (never tool_result, even though canEditUserEntry already screens at
// the row level — defensive). After rebuild, content must be non-empty.
// We compare JSON-stringified old vs new to skip rows whose content
// happens to already match the spec (no-op write).

// Mirrors webview's MAX_INLINE_IMAGE_BYTES; raw decoded bytes, not
// base64 length. Anthropic's API will reject anything well above this,
// and persisting an unbounded blob into JSONL would bloat the
// transcript and break later resume/compact passes.
const HOST_MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function validateImageBase64(data) {
  // Raw size cap is computed from the base64 string length up front so
  // we can reject before paying the Buffer.from cost. Each 4-char base64
  // group encodes 3 raw bytes; padding subtracts one byte per `=`.
  const len = data.length;
  if (len === 0) {
    throw new Error('image source data is empty');
  }
  if (len % 4 !== 0) {
    throw new Error('image source data is not valid base64 (length not multiple of 4)');
  }
  if (!BASE64_RE.test(data)) {
    throw new Error('image source data contains non-base64 characters');
  }
  let pad = 0;
  if (data.charCodeAt(len - 1) === 61) pad++;
  if (data.charCodeAt(len - 2) === 61) pad++;
  const rawBytes = (len / 4) * 3 - pad;
  if (rawBytes > HOST_MAX_INLINE_IMAGE_BYTES) {
    throw new Error(
      `image source exceeds ${HOST_MAX_INLINE_IMAGE_BYTES} raw bytes ` +
      `(got ~${rawBytes})`
    );
  }
  // Final decode check. Buffer.from('base64') is lenient with garbage
  // inputs (silently drops invalid chars), so we compare the round-trip
  // length to confirm the input is actually decodable.
  const buf = Buffer.from(data, 'base64');
  if (buf.length !== rawBytes) {
    throw new Error('image source data failed base64 decode round-trip');
  }
}

function applyUserBlockEdit(transcript, uuid, blocks) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'user') {
    throw new Error('Only user messages can be edited with this operation');
  }
  if (!canEditUserEntry(sample)) {
    throw new Error('Tool result records cannot be edited; rerun the prior user message instead');
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('Empty blocks list');
  }
  for (const spec of blocks) {
    if (!spec || typeof spec !== 'object') {
      throw new Error('Invalid block spec');
    }
    if (spec.kind === 'keep') {
      if (!Number.isInteger(spec.index) || spec.index < 0) {
        throw new Error('keep spec requires a non-negative integer index');
      }
    } else if (spec.kind === 'text') {
      if (typeof spec.text !== 'string') {
        throw new Error('text spec requires a string text');
      }
      if (/^\s*<ide_[a-z_]+\b/.test(spec.text)) {
        throw new Error('User-typed text may not start with an <ide_*> tag (refs round-trip via keep, not text)');
      }
    } else if (spec.kind === 'image') {
      const src = spec.source;
      if (!src || typeof src !== 'object') {
        throw new Error('image spec requires a source object');
      }
      if (src.type !== 'base64' || typeof src.data !== 'string' || typeof src.media_type !== 'string') {
        throw new Error('image source must be {type:"base64", media_type, data}');
      }
      if (!/^image\/(png|jpeg|gif|webp)$/.test(src.media_type)) {
        throw new Error(`Unsupported image media_type: ${src.media_type}`);
      }
      // Host is the disk-write authority; even though the webview
      // already enforces these limits, validate at the trust boundary
      // so a stale webview or future caller can't persist a non-base64
      // string or an unbounded blob into message.content.
      validateImageBase64(src.data);
    } else {
      throw new Error(`Unsupported block spec kind: ${spec.kind}`);
    }
  }

  let any = false;
  for (const row of rows) {
    if (applyBlockSpecToEntry(row.entry, blocks)) {
      row.changed = true;
      any = true;
    }
  }
  return { changed: any };
}

function applyBlockSpecToEntry(entry, blocks) {
  if (!entry.message || typeof entry.message !== 'object') entry.message = {};
  let content = entry.message.content;
  // Normalise string content to a single-text-block array so the
  // blocks path is uniform. The on-disk shape becomes array form;
  // Anthropic API treats both shapes equivalently.
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return false;
  }
  const newContent = [];
  for (const spec of blocks) {
    if (spec.kind === 'keep') {
      if (spec.index >= content.length) {
        // Out-of-range for THIS row's content (dup-uuid shape drift,
        // exceedingly rare). Skip silently rather than fail; user's
        // other intent (other kept blocks present in this row + new
        // text/image) still applies.
        continue;
      }
      const block = content[spec.index];
      if (!block || typeof block !== 'object') continue;
      // Defensive: only carry text/image. tool_result blocks must
      // never be preserved through this op — canEditUserEntry already
      // rejected the row, but double-gate here too.
      if (block.type === 'text' || block.type === 'image') {
        newContent.push(block);
      }
    } else if (spec.kind === 'text') {
      newContent.push({ type: 'text', text: spec.text });
    } else if (spec.kind === 'image') {
      newContent.push({ type: 'image', source: spec.source });
    }
  }
  if (newContent.length === 0) return false;
  const oldStr = JSON.stringify(content);
  const newStr = JSON.stringify(newContent);
  if (oldStr === newStr) return false;
  entry.message.content = newContent;
  return true;
}

function applyAssistantTextEdit(transcript, uuid, text) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'assistant') throw new Error('Only assistant messages can be edited with this operation');
  if (!canEditAssistantTextEntry(sample)) {
    throw new Error('This assistant record has no editable text block');
  }
  let any = false;
  for (const row of rows) {
    if (replaceTextContent(row.entry, text, { requireExistingText: true })) {
      row.changed = true;
      any = true;
    }
  }
  return { changed: any };
}

function requireTranscriptRows(transcript, uuid) {
  const rows = transcript.rowsByUuid.get(uuid);
  if (!rows || !rows.length) throw new Error(`Message ${uuid} was not found`);
  return rows;
}

// Truncate-from-user: drop the user record at `uuid` and every row
// that follows it in the JSONL, then drop any file-history-snapshot
// rows whose `messageId` referenced something that just died.
//
// This replaces the old delete_message + cascade dance entirely. The
// reasons it's safer:
//   - Cuts by row index, so duplicate uuids inside the cut region
//     vanish together (no "delete uuid X but the compact-preserved
//     copy at row 200 stays"). Earlier dup-uuid copies *before* the
//     cut survive — they're legitimate history.
//   - No parentUuid rewriting. The kept prefix ends at a user-or-
//     earlier boundary, so nothing left has a dangling parent.
//   - No orphan tool_use blocks. tool_use must be triggered by a
//     preceding user input; truncating from the user wipes the entire
//     dependent subtree (assistant replies, tool calls, tool results).
//   - Anthropic API contract holds: messages always start on a user
//     role with strict alternation after re-launch.
//
// `summary` rows whose `leafUuid` belongs only to the cut region get
// dropped with the rest — summaries describe a chain, and a chain
// that's been chopped is no longer summarised by that row. We don't
// try to retarget summaries to an earlier leaf; if the same uuid still
// has a kept row, however, the pre-cut summary still belongs to the
// surviving prefix and stays.
function applyTruncateFromUser(transcript, uuid) {
  const rows = requireTranscriptRows(transcript, uuid);
  const sample = rows[rows.length - 1].entry;
  if (sample.type !== 'user') {
    throw new Error('truncate_from_user requires a user message uuid');
  }
  // Same gate as edit: compact-summary / transcript-only records are
  // CLI-managed bookkeeping. Truncating *at* one of these would leave
  // the surviving JSONL with a dangling compact_boundary system record
  // pointing at a removed user line, which the CLI's resume path
  // can't reconcile cleanly. (Truncating *past* one is fine — the
  // boundary itself stays put.)
  if (sample.isCompactSummary === true || sample.isVisibleInTranscriptOnly === true) {
    throw new Error('Compact-summary records cannot be the rerun anchor');
  }
  const cutIdx = rows[rows.length - 1].index;
  const droppedUuids = new Set();
  for (let i = cutIdx; i < transcript.rows.length; i++) {
    const r = transcript.rows[i];
    r.drop = true;
    const e = r.entry;
    if (e && typeof e.uuid === 'string') droppedUuids.add(e.uuid);
  }
  const keptUuids = new Set();
  for (const r of transcript.rows) {
    if (r.drop) continue;
    const e = r.entry;
    if (e && typeof e.uuid === 'string') keptUuids.add(e.uuid);
  }
  // Drop file-history-snapshot rows pointing only into the cut region,
  // even if they appear before the cut (snapshots are typically just
  // before their messageId; defensive sweep covers either layout).
  // Compact transcripts can preserve the same uuid before and after
  // the cut, so uuid membership in `droppedUuids` is not enough by
  // itself. If a kept row still owns that uuid, its pre-cut snapshot is
  // part of the surviving prefix and must stay.
  for (const r of transcript.rows) {
    if (r.drop) continue;
    const e = r.entry;
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'file-history-snapshot' &&
        typeof e.messageId === 'string' &&
        droppedUuids.has(e.messageId) &&
        !keptUuids.has(e.messageId)) {
      r.drop = true;
    }
    // Drop summaries whose leafUuid lands in the cut region.
    if (e.type === 'summary' &&
        typeof e.leafUuid === 'string' &&
        droppedUuids.has(e.leafUuid) &&
        !keptUuids.has(e.leafUuid)) {
      r.drop = true;
    }
  }
  return {
    changed: droppedUuids.size > 0,
    droppedUuids: Array.from(droppedUuids),
    droppedFromIndex: cutIdx,
  };
}

function editableTextFromEntry(entry) {
  return textFromContent(entry && entry.message && entry.message.content);
}

function canEditUserEntry(entry) {
  if (!entry || entry.type !== 'user') return false;
  if (toolResultIdsFromEntry(entry).length !== 0) return false;
  // Compact-summary records: persisted with `isCompactSummary:true` and
  // `isVisibleInTranscriptOnly:true` by the CLI. The webview's UT()
  // wrapper drops both flags when building Iz instances, but here we
  // read the raw JSONL entry — so this is the authoritative gate.
  // These records are CLI-managed bookkeeping; mutating them through
  // the user-edit path leaves the model with a bogus turn the CLI's
  // own compact accounting can't reconcile.
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return false;
  return true;
}

function canEditAssistantTextEntry(entry) {
  if (!entry || entry.type !== 'assistant') return false;
  const content = entry.message && entry.message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some(block =>
    block && block.type === 'text' && typeof block.text === 'string'
  );
}

function replaceTextContent(entry, text, options) {
  if (!entry.message || typeof entry.message !== 'object') entry.message = {};
  const content = entry.message.content;
  const requireExistingText = !!(options && options.requireExistingText);
  if (typeof content === 'string') {
    if (content === text) return false;
    entry.message.content = text;
    return true;
  }
  if (!Array.isArray(content)) {
    if (requireExistingText) return false;
    entry.message.content = text;
    return true;
  }

  let changed = false;
  let wroteText = false;
  const next = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      if (!wroteText) {
        if (block.text !== text) changed = true;
        next.push({ ...block, text });
        wroteText = true;
      } else {
        changed = true;
      }
    } else {
      next.push(block);
    }
  }
  if (!wroteText) {
    if (requireExistingText) return false;
    next.unshift({ type: 'text', text });
    changed = true;
  }
  if (changed) entry.message.content = next;
  return changed;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function toolResultIdsFromEntry(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block && block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map(block => block.tool_use_id);
}

function stopPolling(state) {
  if (!state.started) return;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  state.started = false;
}

function startPolling(state) {
  if (state.started) return;
  state.started = true;
  patchFs(state);
  state.tick = () => schedulePoll(state, 0);
  state.tick();
  state.timer = setInterval(state.tick, POLL_INTERVAL_MS);
}

function patchFs(state) {
  if (state.patchedFs) return;
  state.patchedFs = true;
  const root = projectsRoot();
  wrapFsMethod('appendFile', state, root);
  wrapFsMethod('appendFileSync', state, root);
  wrapFsMethod('writeFile', state, root);
  wrapFsMethod('writeFileSync', state, root);
  wrapFsMethod('createWriteStream', state, root);
}

function wrapFsMethod(name, state, root) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  if (name === 'createWriteStream') {
    fs[name] = function wrappedCreateWriteStream(filePath) {
      const tracked = trackSessionFile(state, root, filePath);
      const stream = original.apply(fs, arguments);
      if (tracked) attachWriteStreamPoll(state, stream);
      return stream;
    };
    return;
  }
  fs[name] = function wrapped(filePath) {
    const tracked = trackSessionFile(state, root, filePath);
    if (!tracked) return original.apply(fs, arguments);

    const args = Array.prototype.slice.call(arguments);
    let scheduled = false;
    const scheduleOnce = () => {
      if (scheduled) return;
      scheduled = true;
      schedulePoll(state, WRITE_POLL_DEBOUNCE_MS);
    };
    const lastIndex = args.length - 1;
    const isSync = name.endsWith('Sync');
    let callbackWrapped = false;
    if (!isSync && typeof args[lastIndex] === 'function') {
      const callback = args[lastIndex];
      callbackWrapped = true;
      args[lastIndex] = function wrappedCallback() {
        try {
          return callback.apply(this, arguments);
        } finally {
          scheduleOnce();
        }
      };
    }

    const result = original.apply(fs, args);
    if (isSync || !callbackWrapped) {
      if (result && typeof result.then === 'function') result.finally(scheduleOnce);
      else scheduleOnce();
    }
    return result;
  };
}

function trackSessionFile(state, root, filePath) {
  if (!isSessionFilePath(root, filePath)) return false;
  if (state.ourFile !== filePath) {
    state.ourFile = filePath;
    state.log(`ourFile=${filePath}`);
  }
  return true;
}

function isSessionFilePath(root, filePath) {
  return (
    typeof filePath === 'string' &&
    filePath.startsWith(root) &&
    filePath.toLowerCase().endsWith(JSONL_SUFFIX)
  );
}

function attachWriteStreamPoll(state, stream) {
  if (!stream || stream.__incipitPollWrapped) return;
  stream.__incipitPollWrapped = true;
  // Event subscriptions only — we deliberately do NOT override
  // `stream.write` / `stream.end`. Overwriting those methods changes the
  // object identity of host APIs and risked surprises in downstream code
  // that holds references to the original prototypes. `finish` fires
  // after the writable side has drained, `close` after the underlying fd
  // is released, and `end` is the user-side finalize entry; together
  // they cover the only moments at which a new poll is actually useful.
  const schedule = () => schedulePoll(state, WRITE_POLL_DEBOUNCE_MS);
  if (typeof stream.once === 'function') {
    try { stream.once('finish', schedule); } catch (_) {}
    try { stream.once('close', schedule); } catch (_) {}
    try { stream.once('end', schedule); } catch (_) {}
  }
}

function schedulePoll(state, delay) {
  if (!state || !state.started) return;
  const wait = Math.max(0, Number(delay) || 0);
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  if (wait === 0) {
    poll(state);
    return;
  }
  state.pollTimer = setTimeout(() => {
    state.pollTimer = null;
    poll(state);
  }, wait);
}

function poll(state) {
  try {
    const targets = resolveTargetFiles(state);
    for (const target of targets) {
      if (!target || !fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (isCacheHit(state, target, stat)) continue;
      const before = state.targetCache.get(target);
      const beforeSnapshot = before ? {
        payload: before.payload,
        usageVersion: before.usageVersion,
        editPayload: before.editPayload,
        editVersion: before.editVersion,
      } : null;
      const payload = buildCachedPayload(state, target, stat, false);
      const after = state.targetCache.get(target);
      if (badgeCacheChanged(beforeSnapshot, after)) broadcastTarget(state, target, payload);
      const parser = state.parsers.get(target);
      if (parser) {
        const editPayload = buildCachedEditActivityPayload(state, target, parser);
        persistProjectEditActivitySession(state, target, parser, stat);
        const afterEdit = state.targetCache.get(target);
        if (editCacheChanged(beforeSnapshot, afterEdit)) broadcastEditActivityTarget(state, target, editPayload);
      }
    }
  } catch (error) {
    state.log(`tick error: ${error}`);
  }
}

function resolveTargetFiles(state) {
  const targets = new Set();
  let hasIdentity = false;
  for (const [comm, identity] of state.commIdentities) {
    if (!state.comms.has(comm) || !identity || !identity.sessionId) continue;
    hasIdentity = true;
    let target = identity.target;
    if (!target || !fs.existsSync(target)) {
      target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      identity.target = target;
    }
    if (target) targets.add(target);
  }
  if (!hasIdentity) return [];
  if (state.ourFile) {
    const ourBase = path.basename(state.ourFile);
    for (const identity of state.commIdentities.values()) {
      if (!identity || !identity.sessionId) continue;
      if (identity.target === state.ourFile || ourBase === identity.sessionId + JSONL_SUFFIX) {
        if (!identity.target) identity.target = state.ourFile;
        targets.add(state.ourFile);
        break;
      }
    }
  }
  return Array.from(targets);
}

// Direct (sessionId, cwd) → JSONL path. Mirrors Claude Code's own encoding
// (`cwd.replace(/[^a-zA-Z0-9]/g, '-')`) and fixes target by `<sessionId>.jsonl`.
// Returns null on any miss so the caller can fall through to the legacy
// heuristic. The session-line cross-check inside `resolveConversationMutation`
// will catch a stale or wrong file before we touch it.
function resolveTargetFromIdentity(sessionId, cwd) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  let dir = null;
  if (typeof cwd === 'string' && cwd) {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    dir = path.join(projectsRoot(), encoded);
    if (!fs.existsSync(dir)) dir = null;
  }
  if (!dir) {
    // No cwd hint — search every project dir for a matching `<sessionId>.jsonl`.
    // Cheap because we only stat one filename per dir.
    const root = projectsRoot();
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return null; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, sessionId + JSONL_SUFFIX);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
  const candidate = path.join(dir, sessionId + JSONL_SUFFIX);
  return fs.existsSync(candidate) ? candidate : null;
}

function isCacheHit(state, filePath, stat) {
  const cached = state.targetCache.get(filePath);
  return (
    cached &&
    stat &&
    cached.size === stat.size &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.payload
  );
}

function cachedBadgePayload(state, target, includeHistory) {
  const cached = target ? state.targetCache.get(target) : null;
  if (!cached) return null;
  return includeHistory ? (cached.historyPayload || null) : (cached.payload || null);
}

function badgeCacheChanged(before, after) {
  if (!after || !after.payload) return false;
  if (!before || !before.payload) return true;
  return before.usageVersion !== after.usageVersion;
}

function editCacheChanged(before, after) {
  if (!after || !after.editPayload) return false;
  if (!before || !before.editPayload) return true;
  return before.editVersion !== after.editVersion;
}

function buildCachedPayload(state, target, stat, includeHistory) {
  const cached = state.targetCache.get(target);
  const sameFileStat = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs;
  if (sameFileStat) {
    const hit = includeHistory ? cached.historyPayload : cached.payload;
    if (hit) return hit;
  }

  const parser = updateParser(state, target, stat);
  const sameUsageVersion = cached && cached.usageVersion === parser.usageVersion;
  const next = sameFileStat ? cached : {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    usageVersion: parser.usageVersion,
    editVersion: cached ? cached.editVersion : undefined,
    payload: sameUsageVersion ? cached.payload : null,
    historyPayload: sameUsageVersion ? cached.historyPayload : null,
    editPayload: cached ? cached.editPayload : null,
  };
  next.size = stat.size;
  next.mtimeMs = stat.mtimeMs;
  next.usageVersion = parser.usageVersion;
  if (!next.payload) next.payload = buildPayload(parser, false) || emptyBadgePayload(null, target);
  if (includeHistory && !next.historyPayload) {
    next.historyPayload = buildPayload(parser, true) || emptyBadgePayload(null, target);
  }
  state.targetCache.set(target, next);
  return includeHistory ? next.historyPayload : next.payload;
}

function buildCachedEditActivityPayload(state, target, parser) {
  const cached = state.targetCache.get(target) || {
    size: parser.size || 0,
    mtimeMs: parser.mtimeMs || 0,
    usageVersion: parser.usageVersion || 0,
    payload: null,
    historyPayload: null,
  };
  if (cached.editPayload && cached.editVersion === parser.editVersion) {
    return cached.editPayload;
  }
  cached.editVersion = parser.editVersion;
  cached.editPayload = buildEditActivityPayload(parser);
  state.targetCache.set(target, cached);
  return cached.editPayload;
}

function sendCurrentBadgePayload(state, comm, target, sessionId, includeHistory) {
  if (!target || !fs.existsSync(target)) {
    sendPayload(comm, emptyBadgePayload(sessionId, target || null));
    return;
  }
  try {
    const stat = fs.statSync(target);
    let payload = cachedBadgePayload(state, target, includeHistory);
    if (!payload || !isCacheHit(state, target, stat)) {
      payload = buildCachedPayload(state, target, stat, includeHistory);
    }
    sendPayload(comm, annotateBadgePayload(payload, sessionId, target));
  } catch (_) {
    sendPayload(comm, emptyBadgePayload(sessionId, target));
  }
}

function sendCurrentEditActivityPayload(state, comm, target, sessionId, includeProject) {
  if (!target || !fs.existsSync(target)) {
    sendEditActivityPayload(comm, emptyEditActivityPayload(sessionId, target || null));
    return;
  }
  try {
    const stat = fs.statSync(target);
    const parser = updateParser(state, target, stat);
    const conversation = annotateEditActivityPayload(
      buildCachedEditActivityPayload(state, target, parser),
      sessionId,
      target
    );
    persistProjectEditActivitySession(state, target, parser, stat);
    const project = includeProject
      ? buildProjectEditActivityResponse(state, target, comm, sessionId)
      : null;
    sendEditActivityPayload(comm, editActivityEnvelope(conversation, project));
  } catch (_) {
    sendEditActivityPayload(comm, emptyEditActivityPayload(sessionId, target));
  }
}

function emptyBadgePayload(sessionId, target) {
  return {
    empty: true,
    sessionId: sessionId || null,
    src: target || null,
    ts: Date.now(),
    recent: [],
    totals: null,
  };
}

function emptyEditActivityPayload(sessionId, target) {
  return {
    empty: true,
    sessionId: sessionId || null,
    src: target || null,
    ts: Date.now(),
    totals: { added: 0, removed: 0, edits: 0, activeDays: 0 },
    days: [],
  };
}

function annotateBadgePayload(payload, sessionId, target) {
  if (!payload || typeof payload !== 'object') return emptyBadgePayload(sessionId, target);
  if (!sessionId || payload.sessionId === sessionId) return payload;
  return { ...payload, sessionId };
}

function annotateEditActivityPayload(payload, sessionId, target) {
  if (!payload || typeof payload !== 'object') return emptyEditActivityPayload(sessionId, target);
  return {
    ...payload,
    sessionId: sessionId || payload.sessionId || null,
    src: target || payload.src || null,
  };
}

function editActivityEnvelope(conversation, project) {
  const base = conversation || emptyEditActivityPayload(null, null);
  return {
    ...base,
    conversation: base,
    project: project || null,
  };
}

// JSONL session files are append-only in steady state. Reading the whole file
// every 1.5s on a long, streaming session was a measurable extension-host
// stall (22-29MB files parsed in ~100-150ms per tick).
//
// Strategy:
//   - Keep parser state across ticks: file size + partial trailing line +
//     `byRequest` map + order list + running token sums.
//   - On growth: read only `[oldSize, newSize)`, decode through StringDecoder
//     so a multi-byte UTF-8 char split across the boundary survives, split on
//     newline, accumulate.
//   - On shrink / path swap / first run: rebuild from scratch (rare).
//
// The host writer can in principle update the same `requestId` later, so
// `processLine` subtracts old contributions before adding new ones — keeps
// `sums` correct without a full re-scan.
function updateParser(state, target, stat) {
  let parser = state.parsers.get(target);
  const needReset =
    !parser ||
    parser.path !== target ||
    stat.size < parser.size ||
    (stat.size === parser.size && parser.mtimeMs && stat.mtimeMs !== parser.mtimeMs);
  if (needReset) {
    parser = loadUsageCacheParser(state, target, stat) || createParser(target);
    state.parsers.set(target, parser);
  }
  if (stat.size > parser.size) appendNewBytes(parser, target, stat.size);
  parser.mtimeMs = stat.mtimeMs;
  saveUsageCacheParser(state, parser, stat);
  return parser;
}

function createParser(filePath, options = {}) {
  return {
    path: filePath,
    editOnly: options.editOnly === true,
    size: 0,
    committedSize: 0,
    mtimeMs: 0,
    partialLine: '',
    partialChunks: [],
    partialLength: 0,
    decoder: new StringDecoder('utf8'),
    byRequest: new Map(),
    order: [],
    sums: { fresh: 0, cw: 0, cr: 0, out: 0 },
    latestUsageId: null,
    projectCwd: null,
    editPending: new Map(),
    editCounted: new Map(),
    editDays: new Map(),
    editSums: { added: 0, removed: 0, edits: 0 },
    usageVersion: 0,
    editVersion: 0,
    persistDirty: false,
  };
}

function usageCacheKeyForFile(filePath) {
  const resolved = path.resolve(filePath || '');
  const stable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

function usageCacheIndexPath(filePath) {
  return path.join(USAGE_CACHE_INDEX_DIR, usageCacheKeyForFile(filePath) + '.json');
}

function deleteUsageCacheIndex(filePath) {
  try {
    const indexPath = usageCacheIndexPath(filePath);
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
  } catch (_) {}
}

function readFileHashSlice(filePath, start, length) {
  if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return null;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function usageCacheGuards(filePath, indexedSize) {
  const size = Math.max(0, Math.floor(indexedSize || 0));
  const headLength = Math.min(USAGE_CACHE_HASH_BYTES, size);
  const tailLength = Math.min(USAGE_CACHE_HASH_BYTES, size);
  const tailStart = Math.max(0, size - tailLength);
  return {
    headLength,
    headHash: headLength ? readFileHashSlice(filePath, 0, headLength) : null,
    tailStart,
    tailLength,
    tailHash: tailLength ? readFileHashSlice(filePath, tailStart, tailLength) : null,
  };
}

function usageCacheGuardsMatch(filePath, index) {
  if (!index || !index.guards) return false;
  const guards = index.guards;
  if (guards.headLength) {
    const headHash = readFileHashSlice(filePath, 0, guards.headLength);
    if (!headHash || headHash !== guards.headHash) return false;
  }
  if (guards.tailLength) {
    const tailHash = readFileHashSlice(filePath, guards.tailStart || 0, guards.tailLength);
    if (!tailHash || tailHash !== guards.tailHash) return false;
  }
  return true;
}

function safeTokenNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function compactUsage(usage) {
  usage = usage && typeof usage === 'object' ? usage : {};
  return {
    input_tokens: safeTokenNumber(usage.input_tokens),
    cache_creation_input_tokens: safeTokenNumber(usage.cache_creation_input_tokens),
    cache_read_input_tokens: safeTokenNumber(usage.cache_read_input_tokens),
    output_tokens: safeTokenNumber(usage.output_tokens),
  };
}

function compactEditItem(item) {
  if (!item || typeof item.id !== 'string' || !item.id) return null;
  return {
    id: item.id,
    name: typeof item.name === 'string' ? item.name : '',
    ts: typeof item.ts === 'string' ? item.ts : '',
    day: typeof item.day === 'string' && item.day ? item.day : localDayKey(item.ts),
    added: safeTokenNumber(item.added),
    removed: safeTokenNumber(item.removed),
  };
}

function serializeUsageCacheParser(parser, stat) {
  if (!parser || parser.editOnly || !parser.path) return null;
  const indexedSize = Math.max(0, Math.min(parser.committedSize || 0, parser.size || 0));
  if (indexedSize <= 0) return null;
  const guards = usageCacheGuards(parser.path, indexedSize);
  const records = [];
  for (const id of parser.order) {
    const row = parser.byRequest.get(id);
    if (!row) continue;
    records.push({
      id,
      ts: typeof row.ts === 'string' ? row.ts : '',
      usage: compactUsage(row.usage),
    });
  }
  return {
    schemaVersion: USAGE_CACHE_SCHEMA_VERSION,
    pathKey: usageCacheKeyForFile(parser.path),
    sourceBasename: path.basename(parser.path),
    indexedSize,
    fileSizeAtSave: stat && Number.isFinite(stat.size) ? stat.size : parser.size,
    completeAtSave: !!(stat && indexedSize === stat.size),
    mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : parser.mtimeMs,
    updatedAt: Date.now(),
    guards,
    projectCwd: parser.projectCwd || null,
    usage: {
      usageVersion: parser.usageVersion || 0,
      latestUsageId: parser.latestUsageId || null,
      records,
    },
    edit: {
      editVersion: parser.editVersion || 0,
      pending: Array.from(parser.editPending.values()).map(compactEditItem).filter(Boolean),
      counted: Array.from(parser.editCounted.values()).map(compactEditItem).filter(Boolean),
    },
  };
}

function saveUsageCacheParser(state, parser, stat) {
  if (!parser || parser.editOnly || !parser.persistDirty) return;
  try {
    const index = serializeUsageCacheParser(parser, stat);
    if (!index) return;
    fs.mkdirSync(USAGE_CACHE_INDEX_DIR, { recursive: true });
    const finalPath = usageCacheIndexPath(parser.path);
    const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(index));
    fs.renameSync(tmpPath, finalPath);
    parser.persistDirty = false;
  } catch (error) {
    if (state && typeof state.log === 'function') {
      state.log(`usage cache index save skipped: ${error && error.message ? error.message : error}`);
    }
  }
}

function loadUsageCacheParser(state, target, stat) {
  try {
    const indexPath = usageCacheIndexPath(target);
    if (!fs.existsSync(indexPath)) return null;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!index || index.schemaVersion !== USAGE_CACHE_SCHEMA_VERSION) return null;
    if (index.pathKey !== usageCacheKeyForFile(target)) return null;
    if (index.sourceBasename !== path.basename(target)) return null;
    const indexedSize = Number(index.indexedSize);
    if (!Number.isFinite(indexedSize) || indexedSize < 0 || indexedSize > stat.size) return null;
    if (indexedSize <= 0) return null;
    if (index.completeAtSave && indexedSize === stat.size && index.mtimeMs !== stat.mtimeMs) return null;
    if (!usageCacheGuardsMatch(target, index)) return null;
    const parser = createParser(target);
    parser.size = indexedSize;
    parser.committedSize = indexedSize;
    parser.mtimeMs = Number.isFinite(index.mtimeMs) ? index.mtimeMs : 0;
    if (!hydrateUsageCacheParser(parser, index)) return null;
    parser.persistDirty = false;
    return parser;
  } catch (error) {
    if (state && typeof state.log === 'function') {
      state.log(`usage cache index ignored: ${error && error.message ? error.message : error}`);
    }
    return null;
  }
}

function hydrateUsageCacheParser(parser, index) {
  parser.projectCwd = typeof index.projectCwd === 'string' && index.projectCwd ? index.projectCwd : null;
  const usage = index.usage && typeof index.usage === 'object' ? index.usage : {};
  const records = Array.isArray(usage.records) ? usage.records : [];
  const seen = new Set();
  parser.byRequest = new Map();
  parser.order = [];
  parser.sums = { fresh: 0, cw: 0, cr: 0, out: 0 };
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id || seen.has(record.id)) return false;
    const compact = compactUsage(record.usage);
    seen.add(record.id);
    parser.order.push(record.id);
    parser.byRequest.set(record.id, {
      ts: typeof record.ts === 'string' ? record.ts : '',
      usage: compact,
    });
    parser.sums.fresh += compact.input_tokens || 0;
    parser.sums.cw += compact.cache_creation_input_tokens || 0;
    parser.sums.cr += compact.cache_read_input_tokens || 0;
    parser.sums.out += compact.output_tokens || 0;
  }
  parser.latestUsageId = typeof usage.latestUsageId === 'string' && parser.byRequest.has(usage.latestUsageId)
    ? usage.latestUsageId
    : (parser.order.length ? parser.order[parser.order.length - 1] : null);
  parser.usageVersion = Number.isFinite(usage.usageVersion)
    ? usage.usageVersion
    : parser.order.length;

  const edit = index.edit && typeof index.edit === 'object' ? index.edit : {};
  parser.editPending = new Map();
  parser.editCounted = new Map();
  parser.editDays = new Map();
  parser.editSums = { added: 0, removed: 0, edits: 0 };
  const counted = Array.isArray(edit.counted) ? edit.counted : [];
  for (const raw of counted) {
    const item = compactEditItem(raw);
    if (!item || parser.editCounted.has(item.id)) continue;
    parser.editCounted.set(item.id, item);
    parser.editSums.added += item.added || 0;
    parser.editSums.removed += item.removed || 0;
    parser.editSums.edits += 1;
    const key = item.day || localDayKey(item.ts);
    let day = parser.editDays.get(key);
    if (!day) {
      day = { day: key, added: 0, removed: 0, edits: 0 };
      parser.editDays.set(key, day);
    }
    day.added += item.added || 0;
    day.removed += item.removed || 0;
    day.edits += 1;
  }
  const pending = Array.isArray(edit.pending) ? edit.pending : [];
  for (const raw of pending) {
    const item = compactEditItem(raw);
    if (!item || parser.editCounted.has(item.id)) continue;
    parser.editPending.set(item.id, item);
  }
  parser.editVersion = Number.isFinite(edit.editVersion)
    ? edit.editVersion
    : parser.editCounted.size;
  return true;
}

function appendNewBytes(parser, filePath, newSize) {
  const length = newSize - parser.size;
  if (length <= 0) return;
  const oldSize = parser.size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, oldSize);
    parser.size = newSize;
    const decoded = parser.decoder.write(buffer);
    appendDecodedText(parser, decoded);
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline !== -1) parser.committedSize = oldSize + lastNewline + 1;
  } finally {
    fs.closeSync(fd);
  }
}

function appendDecodedText(parser, decoded) {
  if (!decoded) return;
  // Streaming writes may extend one unfinished JSONL row for many ticks.
  // Keep those chunks as an array so each poll does not repeatedly flatten
  // the whole growing assistant message before a newline arrives.
  if (decoded.indexOf('\n') === -1) {
    appendPartialLine(parser, decoded);
    return;
  }
  const text = takePartialLine(parser) + decoded;
  const lines = text.split('\n');
  setPartialLine(parser, lines.pop() || '');
  for (let i = 0; i < lines.length; i++) processLine(parser, lines[i]);
}

function appendPartialLine(parser, text) {
  if (!text) return;
  parser.partialChunks.push(text);
  parser.partialLength += text.length;
  parser.partialLine = parser.partialLength <= 4096
    ? parser.partialLine + text
    : '';
}

function setPartialLine(parser, text) {
  parser.partialChunks = text ? [text] : [];
  parser.partialLength = text ? text.length : 0;
  parser.partialLine = text && text.length <= 4096 ? text : '';
}

function takePartialLine(parser) {
  if (!parser.partialChunks.length) return parser.partialLine || '';
  const text = parser.partialChunks.join('');
  setPartialLine(parser, '');
  return text;
}

function processLine(parser, line) {
  if (!line) return;
  const entry = parseJsonLine(line);
  if (!entry) return;
  if (typeof entry.cwd === 'string' && entry.cwd && parser.projectCwd !== entry.cwd) {
    parser.projectCwd = entry.cwd;
    parser.persistDirty = true;
  }
  processUsageEntry(parser, entry);
  processEditActivityEntry(parser, entry);
}

function processUsageEntry(parser, entry) {
  if (parser.editOnly) return;
  if (!entry || entry.type !== 'assistant') return;
  if (!entry.message?.usage) return;
  const requestId = entry.requestId || `idx${parser.order.length}`;
  const usage = entry.message.usage;
  const ts = entry.timestamp || '';
  const old = parser.byRequest.get(requestId);
  if (old) {
    parser.sums.fresh -= old.usage.input_tokens || 0;
    parser.sums.cw    -= old.usage.cache_creation_input_tokens || 0;
    parser.sums.cr    -= old.usage.cache_read_input_tokens || 0;
    parser.sums.out   -= old.usage.output_tokens || 0;
    if (parser.order[parser.order.length - 1] !== requestId) {
      const idx = parser.order.indexOf(requestId);
      if (idx !== -1) parser.order.splice(idx, 1);
      parser.order.push(requestId);
    }
  } else {
    parser.order.push(requestId);
  }
  parser.sums.fresh += usage.input_tokens || 0;
  parser.sums.cw    += usage.cache_creation_input_tokens || 0;
  parser.sums.cr    += usage.cache_read_input_tokens || 0;
  parser.sums.out   += usage.output_tokens || 0;
  parser.byRequest.set(requestId, { usage, ts });
  parser.latestUsageId = requestId;
  parser.usageVersion += 1;
  parser.persistDirty = true;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

function processEditActivityEntry(parser, entry) {
  if (!entry || typeof entry !== 'object') return;
  const expectedSessionId = path.basename(parser.path, JSONL_SUFFIX);
  if (entry.sessionId && entry.sessionId !== expectedSessionId) return;
  const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
  if (!blocks.length) return;

  if (entry.type === 'assistant') {
    for (const block of blocks) {
      if (!block || block.type !== 'tool_use') continue;
      const item = editActivityFromToolUse(block, entry.timestamp || '');
      if (!item || !item.id) continue;
      if (parser.editCounted.has(item.id)) continue;
      parser.editPending.set(item.id, item);
      parser.persistDirty = true;
    }
    return;
  }

  if (entry.type !== 'user') return;
  for (const block of blocks) {
    if (!block || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const item = parser.editPending.get(block.tool_use_id);
    if (!item) continue;
    parser.editPending.delete(block.tool_use_id);
    parser.persistDirty = true;
    if (toolResultIsError(block)) continue;
    countEditActivity(parser, item);
  }
}

function toolResultIsError(block) {
  return block && block.is_error === true;
}

function editActivityFromToolUse(block, ts) {
  if (!block || typeof block.id !== 'string') return null;
  const name = block.name;
  if (name !== 'Write' && name !== 'Edit' && name !== 'MultiEdit') return null;
  const input = block.input && typeof block.input === 'object' ? block.input : null;
  if (!input) return null;
  const stats = computeEditActivityStats(name, input);
  if (!stats) return null;
  return {
    id: block.id,
    name,
    ts: ts || '',
    day: localDayKey(ts),
    added: stats.added || 0,
    removed: stats.removed || 0,
  };
}

function computeEditActivityStats(name, input) {
  if (name === 'Write') {
    if (typeof input.content !== 'string') return null;
    return { added: countTextLines(input.content), removed: 0 };
  }
  if (name === 'Edit') {
    if (typeof input.old_string !== 'string' && typeof input.new_string !== 'string') return null;
    return lineDiffStats(
      typeof input.old_string === 'string' ? input.old_string : '',
      typeof input.new_string === 'string' ? input.new_string : ''
    );
  }
  if (name === 'MultiEdit') {
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      return lineDiffStats(
        typeof input.old_string === 'string' ? input.old_string : '',
        typeof input.new_string === 'string' ? input.new_string : ''
      );
    }
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let added = 0;
    let removed = 0;
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      if (typeof edit.old_string !== 'string' && typeof edit.new_string !== 'string') continue;
      const stat = lineDiffStats(
        typeof edit.old_string === 'string' ? edit.old_string : '',
        typeof edit.new_string === 'string' ? edit.new_string : ''
      );
      added += stat.added || 0;
      removed += stat.removed || 0;
    }
    return added || removed ? { added, removed } : null;
  }
  return null;
}

function countTextLines(text) {
  return text === '' ? 0 : String(text).split('\n').length;
}

function lineDiffStats(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return { added: 0, removed: 0 };
  if (m * n > 500000) {
    return {
      added: Math.max(0, n - m),
      removed: Math.max(0, m - n),
    };
  }
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = curr[j - 1] > prev[j] ? curr[j - 1] : prev[j];
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  const lcs = prev[n];
  return { added: n - lcs, removed: m - lcs };
}

function localDayKey(iso) {
  const d = iso ? new Date(iso) : new Date();
  const t = d.getTime();
  const x = Number.isNaN(t) ? new Date() : d;
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function countEditActivity(parser, item) {
  if (!item || !item.id || parser.editCounted.has(item.id)) return;
  parser.editCounted.set(item.id, item);
  parser.editSums.added += item.added || 0;
  parser.editSums.removed += item.removed || 0;
  parser.editSums.edits += 1;
  parser.editVersion += 1;
  parser.persistDirty = true;
  const key = item.day || localDayKey(item.ts);
  let day = parser.editDays.get(key);
  if (!day) {
    day = { day: key, added: 0, removed: 0, edits: 0 };
    parser.editDays.set(key, day);
  }
  day.added += item.added || 0;
  day.removed += item.removed || 0;
  day.edits += 1;
}

function payloadHistoryEntry(parser, id) {
  const { usage, ts } = parser.byRequest.get(id);
  const c = totalContextTokens(usage);
  return {
    ts,
    ctx: c,
    hit: c > 0 ? (usage.cache_read_input_tokens || 0) / c : 0,
    input: usage.input_tokens || 0,
    cw: usage.cache_creation_input_tokens || 0,
    cr: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  };
}

// Aggregate `parser.order` into <= HISTORY_MAX_BUCKETS contiguous,
// non-overlapping buckets that together cover every request exactly
// once (so Σ bucket sums == global sums, exactly). Each bucket also
// keeps min/max/last hit + the lowest point's ctx/ts so the webview can
// redraw a peak-preserving line and the low/latest markers without the
// raw per-request stream. `c === 1` buckets are single requests.
function payloadHistoryBuckets(parser) {
  const ids = parser.order;
  const n = ids.length;
  if (!n) return [];
  const k = Math.min(HISTORY_MAX_BUCKETS, n);
  const out = [];
  for (let b = 0; b < k; b++) {
    const start = Math.floor((b * n) / k);
    const end = Math.floor(((b + 1) * n) / k); // exclusive
    let cnt = 0, f = 0, w = 0, r = 0, o = 0, hs = 0;
    let lo = Infinity, hi = -Infinity, loCtx = 0, loTs = '';
    let lastHit = 0, lastCtx = 0, lastTs = '', firstTs = '';
    for (let i = start; i < end; i++) {
      const rec = parser.byRequest.get(ids[i]);
      if (!rec) continue;
      const u = rec.usage;
      const ctx = totalContextTokens(u);
      const hit = ctx > 0 ? (u.cache_read_input_tokens || 0) / ctx : 0;
      if (!firstTs) firstTs = rec.ts || '';
      cnt += 1;
      f += u.input_tokens || 0;
      w += u.cache_creation_input_tokens || 0;
      r += u.cache_read_input_tokens || 0;
      o += u.output_tokens || 0;
      hs += hit;
      if (hit < lo) { lo = hit; loCtx = ctx; loTs = rec.ts || ''; }
      if (hit > hi) hi = hit;
      lastHit = hit; lastCtx = ctx; lastTs = rec.ts || '';
    }
    if (!cnt) continue;
    out.push({
      c: cnt,
      ts: lastTs,
      t0: firstTs,
      hit: lastHit,
      ctx: lastCtx,
      lo: lo === Infinity ? lastHit : lo,
      loC: loCtx,
      loT: loTs || lastTs,
      hi: hi === -Infinity ? lastHit : hi,
      f, w, r, o,
      hs,
    });
  }
  return out;
}

function buildPayload(parser, includeHistory) {
  if (!parser.order.length) return null;
  const lastId = parser.latestUsageId && parser.byRequest.has(parser.latestUsageId)
    ? parser.latestUsageId
    : parser.order[parser.order.length - 1];
  const lastUsage = parser.byRequest.get(lastId).usage;
  const ctx = totalContextTokens(lastUsage);
  const totalContext = parser.sums.fresh + parser.sums.cw + parser.sums.cr;
  const totals = {
    requests: parser.order.length,
    fresh: parser.sums.fresh,
    cw: parser.sums.cw,
    cr: parser.sums.cr,
    out: parser.sums.out,
    hitOverall: totalContext > 0 ? parser.sums.cr / totalContext : 0,
    durationMs: 0,
  };
  if (parser.order.length >= 2) {
    const firstTs = parser.byRequest.get(parser.order[0]).ts;
    const lastTs  = parser.byRequest.get(lastId).ts;
    const a = Date.parse(firstTs);
    const b = Date.parse(lastTs);
    if (!Number.isNaN(a) && !Number.isNaN(b)) totals.durationMs = b - a;
  }
  const recent = parser.order.slice(-5).map(id => payloadHistoryEntry(parser, id));
  const payload = {
    ctx,
    hit: ctx > 0 ? (lastUsage.cache_read_input_tokens || 0) / ctx : 0,
    input: lastUsage.input_tokens || 0,
    cc: lastUsage.cache_creation_input_tokens || 0,
    cr: lastUsage.cache_read_input_tokens || 0,
    out: lastUsage.output_tokens || 0,
    ts: Date.now(),
    src: parser.path,
    recent,
    totals,
  };
  if (includeHistory) payload.history = payloadHistoryBuckets(parser);
  return payload;
}

function buildEditActivityPayload(parser) {
  if (!parser) return emptyEditActivityPayload(null, null);
  const projectDir = parser.path ? path.dirname(parser.path) : null;
  const projectName = projectDisplayName(projectDir, parser.projectCwd);
  const days = Array.from(parser.editDays.values())
    .sort((a, b) => a.day < b.day ? -1 : (a.day > b.day ? 1 : 0))
    .map(day => ({
      day: day.day,
      added: day.added || 0,
      removed: day.removed || 0,
      edits: day.edits || 0,
    }));
  return {
    empty: parser.editSums.edits <= 0,
    sessionId: path.basename(parser.path, JSONL_SUFFIX),
    src: parser.path,
    cwd: parser.projectCwd || null,
    projectName,
    ts: Date.now(),
    totals: {
      added: parser.editSums.added || 0,
      removed: parser.editSums.removed || 0,
      edits: parser.editSums.edits || 0,
      activeDays: days.length,
    },
    days,
  };
}

function buildProjectEditActivityResponse(state, target, comm, sessionId) {
  const indexing = scheduleGlobalIndexJob(state, comm, sessionId);
  return buildEditActivityPopupPayload(state, target, indexing ? 'indexing' : 'ready');
}

function buildEditActivityPopupPayload(state, target, status) {
  const projectDir = target ? path.dirname(target) : null;
  const currentIndex = projectDir ? loadProjectEditActivityIndex(state, projectDir) : null;
  return {
    scope: 'popup',
    status: status || 'ready',
    ts: Date.now(),
    currentProject: currentIndex ? buildProjectEditActivityPayload(currentIndex, 'ready') : null,
    global: buildGlobalEditActivityPayload(loadAllProjectEditActivityIndexes(state), status || 'ready'),
  };
}

function persistProjectEditActivitySession(state, target, parser, stat) {
  if (!target || !parser) return null;
  const payload = buildEditActivityPayload(parser);
  const projectDir = path.dirname(target);
  const index = loadProjectEditActivityIndex(state, projectDir);
  const changed = upsertProjectIndexSession(
    index,
    payload,
    target,
    stat || null,
    parser.editVersion || 0
  );
  if (changed) saveProjectEditActivityIndex(index);
  return index;
}

function projectKeyForDir(projectDir) {
  const normalized = path.resolve(projectDir || '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

function projectIndexPath(projectKey) {
  return path.join(EDIT_ACTIVITY_INDEX_DIR, projectKey + '.json');
}

function projectDisplayName(projectDir, cwd) {
  if (typeof cwd === 'string' && cwd) {
    const normalized = cwd.replace(/[\\/]+$/, '');
    const base = path.basename(normalized);
    if (base && base !== normalized) return base;
    if (base) return base;
  }
  const dirName = path.basename(projectDir || '');
  return dirName || 'Current project';
}

function createProjectEditActivityIndex(projectDir) {
  const projectKey = projectKeyForDir(projectDir);
  return {
    schemaVersion: EDIT_ACTIVITY_SCHEMA_VERSION,
    projectKey,
    projectDir,
    projectName: projectDisplayName(projectDir, null),
    cwd: null,
    updatedAt: Date.now(),
    sessions: {},
  };
}

function loadProjectEditActivityIndex(state, projectDir) {
  const projectKey = projectKeyForDir(projectDir);
  const cached = state.editProjectIndexes.get(projectKey);
  if (cached) return cached;
  const filePath = projectIndexPath(projectKey);
  let index = null;
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.schemaVersion === EDIT_ACTIVITY_SCHEMA_VERSION && parsed.projectKey === projectKey) {
        index = parsed;
      }
    }
  } catch (_) {
    index = null;
  }
  if (!index || typeof index !== 'object') index = createProjectEditActivityIndex(projectDir);
  if (!index.sessions || typeof index.sessions !== 'object') index.sessions = {};
  index.projectDir = projectDir;
  index.projectKey = projectKey;
  if (!index.projectName) index.projectName = projectDisplayName(projectDir, index.cwd || null);
  state.editProjectIndexes.set(projectKey, index);
  return index;
}

function saveProjectEditActivityIndex(index) {
  if (!index || !index.projectKey) return;
  try {
    fs.mkdirSync(EDIT_ACTIVITY_INDEX_DIR, { recursive: true });
    index.updatedAt = Date.now();
    const finalPath = projectIndexPath(index.projectKey);
    const tmpPath = finalPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(index));
    fs.renameSync(tmpPath, finalPath);
  } catch (_) {}
}

function upsertProjectIndexSession(index, payload, filePath, stat, editVersion) {
  if (!index || !payload || !payload.sessionId) return false;
  const sessionId = payload.sessionId;
  const hasEdits = payload.totals && (payload.totals.edits || 0) > 0;
  if (!hasEdits) {
    if (index.sessions[sessionId]) {
      delete index.sessions[sessionId];
      return true;
    }
    return false;
  }
  const days = {};
  let metaChanged = false;
  if (payload.cwd && index.cwd !== payload.cwd) {
    index.cwd = payload.cwd;
    metaChanged = true;
  }
  if (payload.projectName && index.projectName !== payload.projectName) {
    index.projectName = payload.projectName;
    metaChanged = true;
  }
  const dayRows = Array.isArray(payload.days) ? payload.days : [];
  for (const day of dayRows) {
    if (!day || !day.day) continue;
    days[day.day] = {
      added: day.added || 0,
      removed: day.removed || 0,
      edits: day.edits || 0,
    };
  }
  const next = {
    sessionId,
    src: filePath ? path.basename(filePath) : null,
    cwd: payload.cwd || null,
    projectName: payload.projectName || projectDisplayName(index.projectDir, payload.cwd || index.cwd || null),
    size: stat && Number.isFinite(stat.size) ? stat.size : null,
    mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null,
    editVersion: Number.isFinite(editVersion) ? editVersion : null,
    indexedAt: Date.now(),
    totals: {
      added: payload.totals.added || 0,
      removed: payload.totals.removed || 0,
      edits: payload.totals.edits || 0,
      activeDays: payload.totals.activeDays || Object.keys(days).length,
    },
    days,
  };
  const old = index.sessions[sessionId];
  if (old &&
      old.size === next.size &&
      old.mtimeMs === next.mtimeMs &&
      old.editVersion === next.editVersion &&
      old.totals &&
      old.totals.added === next.totals.added &&
      old.totals.removed === next.totals.removed &&
      old.totals.edits === next.totals.edits) {
    return metaChanged;
  }
  index.sessions[sessionId] = next;
  return true;
}

function projectJsonlFiles(projectDir) {
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (_) { return []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(JSONL_SUFFIX)) continue;
    const filePath = path.join(projectDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      files.push({ filePath, stat, sessionId: path.basename(entry.name, JSONL_SUFFIX) });
    } catch (_) {}
  }
  files.sort((a, b) => (b.stat.mtimeMs || 0) - (a.stat.mtimeMs || 0));
  return files;
}

function claudeProjectDirs() {
  let entries = [];
  try { entries = fs.readdirSync(projectsRoot(), { withFileTypes: true }); } catch (_) { return []; }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsRoot(), entry.name);
    let stat = null;
    try { stat = fs.statSync(dir); } catch (_) {}
    dirs.push({ projectDir: dir, mtimeMs: stat ? stat.mtimeMs : 0 });
  }
  dirs.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return dirs.map(item => item.projectDir);
}

function projectIndexNeedsFile(index, file) {
  if (!index || !file || !file.sessionId) return false;
  const old = index.sessions[file.sessionId];
  if (!old) return true;
  return old.size !== file.stat.size || old.mtimeMs !== file.stat.mtimeMs;
}

function scheduleProjectIndexJob(state, projectDir, comm, sessionId) {
  const index = loadProjectEditActivityIndex(state, projectDir);
  const projectKey = index.projectKey;
  let job = state.editProjectJobs.get(projectKey);
  const now = Date.now();
  const lastScanAt = state.editProjectScanAt.get(projectKey) || 0;
  const shouldScan = !job || now - lastScanAt >= PROJECT_INDEX_SCAN_MIN_INTERVAL_MS;
  const files = shouldScan
    ? projectJsonlFiles(projectDir).filter(file => projectIndexNeedsFile(index, file))
    : [];
  if (shouldScan) state.editProjectScanAt.set(projectKey, now);
  if (!files.length && !job) return false;
  if (!job) {
    job = {
      projectKey,
      projectDir,
      index,
      files,
      cursor: 0,
      subscribers: new Map(),
      scheduled: false,
    };
    state.editProjectJobs.set(projectKey, job);
  } else if (files.length) {
    const seen = new Set(job.files.slice(job.cursor).map(file => file.filePath));
    for (const file of files) {
      if (!seen.has(file.filePath)) job.files.push(file);
    }
  }
  if (comm && sessionId) job.subscribers.set(comm, { comm, sessionId });
  if (!job.scheduled) {
    job.scheduled = true;
    setTimeout(() => runProjectIndexJob(state, projectKey), 0);
  }
  return job.cursor < job.files.length;
}

function loadAllProjectEditActivityIndexes(state) {
  const indexes = new Map();
  for (const index of state.editProjectIndexes.values()) {
    if (index && index.projectKey) indexes.set(index.projectKey, index);
  }
  let entries = [];
  try { entries = fs.readdirSync(EDIT_ACTIVITY_INDEX_DIR, { withFileTypes: true }); } catch (_) { entries = []; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(EDIT_ACTIVITY_INDEX_DIR, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.schemaVersion !== EDIT_ACTIVITY_SCHEMA_VERSION || !parsed.projectKey) continue;
      if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};
      state.editProjectIndexes.set(parsed.projectKey, parsed);
      indexes.set(parsed.projectKey, parsed);
    } catch (_) {}
  }
  return Array.from(indexes.values());
}

function scheduleGlobalIndexJob(state, comm, sessionId) {
  let job = state.editGlobalJob;
  if (comm && sessionId && job) job.subscribers.set(comm, { comm, sessionId });
  if (job) return true;

  const now = Date.now();
  if (state.editGlobalScanAt && now - state.editGlobalScanAt < GLOBAL_INDEX_SCAN_MIN_INTERVAL_MS) {
    return false;
  }
  const projectDirs = claudeProjectDirs();
  if (!projectDirs.length) {
    state.editGlobalScanAt = now;
    return false;
  }
  job = {
    projectDirs,
    dirCursor: 0,
    fileQueue: [],
    subscribers: new Map(),
    scheduled: false,
  };
  if (comm && sessionId) job.subscribers.set(comm, { comm, sessionId });
  state.editGlobalJob = job;
  job.scheduled = true;
  setTimeout(() => runGlobalIndexJob(state), 0);
  return true;
}

function runGlobalIndexJob(state) {
  const job = state.editGlobalJob;
  if (!job) return;
  job.scheduled = false;
  let processed = 0;
  let bytes = 0;
  let scannedDirs = 0;
  const changedIndexes = new Set();

  while (processed < PROJECT_INDEX_BATCH_FILES &&
         bytes < PROJECT_INDEX_BATCH_BYTES &&
         (job.fileQueue.length || job.dirCursor < job.projectDirs.length)) {
    if (!job.fileQueue.length) {
      const projectDir = job.projectDirs[job.dirCursor++];
      scannedDirs++;
      const index = loadProjectEditActivityIndex(state, projectDir);
      const files = projectJsonlFiles(projectDir).filter(file => projectIndexNeedsFile(index, file));
      for (const file of files) job.fileQueue.push({ ...file, index });
      if (!job.fileQueue.length && scannedDirs < 4) continue;
      if (!job.fileQueue.length) break;
    }

    const file = job.fileQueue.shift();
    if (!file || !file.index) continue;
    bytes += file.stat.size || 0;
    processed++;
    if (!projectIndexNeedsFile(file.index, file)) continue;
    let payload = null;
    try {
      payload = parseEditActivityFile(file.filePath, file.stat);
    } catch (error) {
      try {
        state.log(`global edit activity index skip ${file.filePath}: ${error && error.message ? error.message : error}`);
      } catch (_) {}
      continue;
    }
    if (upsertProjectIndexSession(file.index, payload, file.filePath, file.stat, null)) {
      changedIndexes.add(file.index);
    }
  }

  for (const index of changedIndexes) saveProjectEditActivityIndex(index);
  const done = !job.fileQueue.length && job.dirCursor >= job.projectDirs.length;
  notifyGlobalIndexSubscribers(state, job, done ? 'ready' : 'indexing');
  if (done) {
    state.editGlobalScanAt = Date.now();
    state.editGlobalJob = null;
    return;
  }
  job.scheduled = true;
  setTimeout(() => runGlobalIndexJob(state), PROJECT_INDEX_BATCH_DELAY_MS);
}

function notifyGlobalIndexSubscribers(state, job, status) {
  for (const [comm, sub] of job.subscribers) {
    if (!state.comms.has(comm)) {
      job.subscribers.delete(comm);
      continue;
    }
    const identity = state.commIdentities.get(comm);
    const target = identity && identity.target
      ? identity.target
      : resolveTargetFromIdentity(sub.sessionId, identity && identity.cwd);
    sendEditActivityPayload(comm, {
      projectOnly: true,
      sessionId: sub.sessionId || null,
      project: buildEditActivityPopupPayload(state, target, status),
    });
  }
}

function runProjectIndexJob(state, projectKey) {
  const job = state.editProjectJobs.get(projectKey);
  if (!job) return;
  job.scheduled = false;
  let processed = 0;
  let bytes = 0;
  let changed = false;
  while (job.cursor < job.files.length &&
         processed < PROJECT_INDEX_BATCH_FILES &&
         bytes < PROJECT_INDEX_BATCH_BYTES) {
    const file = job.files[job.cursor++];
    bytes += file.stat.size || 0;
    processed++;
    if (!projectIndexNeedsFile(job.index, file)) continue;
    let payload = null;
    try {
      payload = parseEditActivityFile(file.filePath, file.stat);
    } catch (error) {
      try {
        state.log(`edit activity index skip ${file.filePath}: ${error && error.message ? error.message : error}`);
      } catch (_) {}
      continue;
    }
    if (upsertProjectIndexSession(job.index, payload, file.filePath, file.stat, null)) changed = true;
  }
  if (changed) saveProjectEditActivityIndex(job.index);
  const done = job.cursor >= job.files.length;
  notifyProjectIndexSubscribers(state, job, done ? 'ready' : 'indexing');
  if (done) {
    state.editProjectJobs.delete(projectKey);
    return;
  }
  job.scheduled = true;
  setTimeout(() => runProjectIndexJob(state, projectKey), PROJECT_INDEX_BATCH_DELAY_MS);
}

function notifyProjectIndexSubscribers(state, job, status) {
  const project = buildProjectEditActivityPayload(job.index, status);
  for (const [comm, sub] of job.subscribers) {
    if (!state.comms.has(comm)) {
      job.subscribers.delete(comm);
      continue;
    }
    sendEditActivityPayload(comm, {
      projectOnly: true,
      sessionId: sub.sessionId || null,
      project,
    });
  }
}

function parseEditActivityFile(filePath, stat) {
  const parser = createParser(filePath, { editOnly: true });
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size || 1)));
    let pos = 0;
    while (pos < stat.size) {
      const len = Math.min(buffer.length, stat.size - pos);
      const read = fs.readSync(fd, buffer, 0, len, pos);
      if (read <= 0) break;
      pos += read;
      appendDecodedText(parser, parser.decoder.write(buffer.subarray(0, read)));
    }
    appendDecodedText(parser, parser.decoder.end());
    const tail = takePartialLine(parser);
    if (tail) processLine(parser, tail);
    parser.size = stat.size;
    parser.mtimeMs = stat.mtimeMs;
    return buildEditActivityPayload(parser);
  } finally {
    fs.closeSync(fd);
  }
}

function buildProjectEditActivityPayload(index, status) {
  const dayMap = new Map();
  let added = 0;
  let removed = 0;
  let edits = 0;
  let sessionCount = 0;
  for (const session of Object.values(index.sessions || {})) {
    if (!session || !session.totals || (session.totals.edits || 0) <= 0) continue;
    sessionCount++;
    added += session.totals.added || 0;
    removed += session.totals.removed || 0;
    edits += session.totals.edits || 0;
    const days = session.days || {};
    for (const [key, day] of Object.entries(days)) {
      if (!key || !day) continue;
      let out = dayMap.get(key);
      if (!out) {
        out = { day: key, added: 0, removed: 0, edits: 0 };
        dayMap.set(key, out);
      }
      out.added += day.added || 0;
      out.removed += day.removed || 0;
      out.edits += day.edits || 0;
    }
  }
  const days = Array.from(dayMap.values())
    .sort((a, b) => a.day < b.day ? -1 : (a.day > b.day ? 1 : 0));
  return {
    empty: edits <= 0,
    scope: 'project',
    status: status || 'ready',
    projectKey: index.projectKey,
    projectDir: index.projectDir,
    cwd: index.cwd || null,
    projectName: index.projectName || projectDisplayName(index.projectDir, index.cwd || null),
    ts: Date.now(),
    totals: {
      added,
      removed,
      edits,
      activeDays: days.length,
      sessions: sessionCount,
    },
    days,
  };
}

function buildGlobalEditActivityPayload(indexes, status) {
  const dayMap = new Map();
  let added = 0;
  let removed = 0;
  let edits = 0;
  let sessionCount = 0;
  let projectCount = 0;
  const list = Array.isArray(indexes) ? indexes : [];
  for (const index of list) {
    if (!index || !index.sessions) continue;
    let projectHasEdits = false;
    for (const session of Object.values(index.sessions || {})) {
      if (!session || !session.totals || (session.totals.edits || 0) <= 0) continue;
      projectHasEdits = true;
      sessionCount++;
      added += session.totals.added || 0;
      removed += session.totals.removed || 0;
      edits += session.totals.edits || 0;
      const days = session.days || {};
      for (const [key, day] of Object.entries(days)) {
        if (!key || !day) continue;
        let out = dayMap.get(key);
        if (!out) {
          out = { day: key, added: 0, removed: 0, edits: 0 };
          dayMap.set(key, out);
        }
        out.added += day.added || 0;
        out.removed += day.removed || 0;
        out.edits += day.edits || 0;
      }
    }
    if (projectHasEdits) projectCount++;
  }
  const days = Array.from(dayMap.values())
    .sort((a, b) => a.day < b.day ? -1 : (a.day > b.day ? 1 : 0));
  return {
    empty: edits <= 0,
    scope: 'global',
    label: 'Claude Code global',
    status: status || 'ready',
    ts: Date.now(),
    totals: {
      added,
      removed,
      edits,
      activeDays: days.length,
      sessions: sessionCount,
      projects: projectCount,
    },
    days,
  };
}

function totalContextTokens(usage) {
  return (
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  );
}

function broadcastTarget(state, target, payload) {
  for (const comm of state.comms) {
    const identity = state.commIdentities.get(comm);
    if (!identity || !identity.sessionId) continue;
    if (identity.target !== target) {
      if (!identity.target) identity.target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      if (identity.target !== target) continue;
    }
    sendPayload(comm, annotateBadgePayload(payload, identity.sessionId, target));
  }
}

function broadcastEditActivityTarget(state, target, payload) {
  for (const comm of state.comms) {
    const identity = state.commIdentities.get(comm);
    if (!identity || !identity.sessionId) continue;
    if (identity.target !== target) {
      if (!identity.target) identity.target = resolveTargetFromIdentity(identity.sessionId, identity.cwd);
      if (identity.target !== target) continue;
    }
    const conversation = annotateEditActivityPayload(payload, identity.sessionId, target);
    sendEditActivityPayload(comm, editActivityEnvelope(conversation, null));
  }
}

function sendPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __cceBadge: true, payload });
  } catch (_) {}
}

function sendEditActivityPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __incipitEditActivity: true, payload });
  } catch (_) {}
}

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

module.exports = { attachComm };

// Pure helpers exposed only for the offline equivalence test
// (tests/cache-history-buckets.test.js). No runtime behaviour change:
// these are referenced, not invoked, by the published code path.
module.exports.__test = {
  createParser,
  processUsageEntry,
  payloadHistoryEntry,
  payloadHistoryBuckets,
  totalContextTokens,
  HISTORY_MAX_BUCKETS,
  // Rerun teardown serializer invariants (tests/rerun-handoff.test.js):
  // exercised offline against a temp JSONL, never invoked by the
  // published path through this object.
  readTranscript,
  serializeTranscript,
  atomicWriteTranscript,
  applyTruncateFromUser,
  registerTruncateRollback,
  peekTruncateState,
};
