'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const GLOBAL_KEY = '__cceBadge';
const POLL_INTERVAL_MS = 1500;
const JSONL_SUFFIX = '.jsonl';
// Keep rollback tokens long enough to cover Claude Code's 5-minute
// launch/byte watchdog path, but cap entries because each one keeps
// the original transcript text in memory until send succeeds or fails.
const TRUNCATE_ROLLBACK_TTL_MS = 6 * 60 * 1000;
const TRUNCATE_ROLLBACK_MAX = 3;

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
  if (message.type === 'diff_line_info_request') {
    handleDiffLineInfoRequest(comm, state, message);
    return;
  }
  if (message.type === 'conversation_mutation_request') {
    handleConversationMutationRequest(comm, state, message);
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
  state.started = false;
}

function startPolling(state) {
  if (state.started) return;
  state.started = true;
  patchFs(state);
  state.tick = () => poll(state);
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
  fs[name] = function wrapped(filePath) {
    trackSessionFile(state, root, filePath);
    return original.apply(fs, arguments);
  };
}

function trackSessionFile(state, root, filePath) {
  if (!isSessionFilePath(root, filePath)) return;
  if (state.ourFile === filePath) return;
  state.ourFile = filePath;
  state.log(`ourFile=${filePath}`);
}

function isSessionFilePath(root, filePath) {
  return (
    typeof filePath === 'string' &&
    filePath.startsWith(root) &&
    filePath.toLowerCase().endsWith(JSONL_SUFFIX)
  );
}

function poll(state) {
  try {
    const targets = resolveTargetFiles(state);
    for (const target of targets) {
      if (!target || !fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (isCacheHit(state, target, stat.mtimeMs)) continue;
      const payload = buildCachedPayload(state, target, stat, false);
      broadcastTarget(state, target, payload);
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

function isCacheHit(state, filePath, mtimeMs) {
  const cached = state.targetCache.get(filePath);
  return (
    cached &&
    cached.mtimeMs === mtimeMs &&
    cached.payload
  );
}

function cachedBadgePayload(state, target, includeHistory) {
  const cached = target ? state.targetCache.get(target) : null;
  if (!cached) return null;
  return includeHistory ? (cached.historyPayload || null) : (cached.payload || null);
}

function buildCachedPayload(state, target, stat, includeHistory) {
  const cached = state.targetCache.get(target);
  const sameMtime = cached && cached.mtimeMs === stat.mtimeMs;
  if (sameMtime) {
    const hit = includeHistory ? cached.historyPayload : cached.payload;
    if (hit) return hit;
  }

  const parser = updateParser(state, target, stat);
  const next = sameMtime ? cached : { mtimeMs: stat.mtimeMs, payload: null, historyPayload: null };
  if (!next.payload) next.payload = buildPayload(parser, false) || emptyBadgePayload(null, target);
  if (includeHistory && !next.historyPayload) {
    next.historyPayload = buildPayload(parser, true) || emptyBadgePayload(null, target);
  }
  state.targetCache.set(target, next);
  return includeHistory ? next.historyPayload : next.payload;
}

function sendCurrentBadgePayload(state, comm, target, sessionId, includeHistory) {
  if (!target || !fs.existsSync(target)) {
    sendPayload(comm, emptyBadgePayload(sessionId, target || null));
    return;
  }
  try {
    const stat = fs.statSync(target);
    let payload = cachedBadgePayload(state, target, includeHistory);
    if (!payload || !isCacheHit(state, target, stat.mtimeMs)) {
      payload = buildCachedPayload(state, target, stat, includeHistory);
    }
    sendPayload(comm, annotateBadgePayload(payload, sessionId, target));
  } catch (_) {
    sendPayload(comm, emptyBadgePayload(sessionId, target));
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

function annotateBadgePayload(payload, sessionId, target) {
  if (!payload || typeof payload !== 'object') return emptyBadgePayload(sessionId, target);
  if (!sessionId || payload.sessionId === sessionId) return payload;
  return { ...payload, sessionId };
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
    parser = createParser(target);
    state.parsers.set(target, parser);
  }
  if (stat.size > parser.size) appendNewBytes(parser, target, stat.size);
  parser.mtimeMs = stat.mtimeMs;
  return parser;
}

function createParser(filePath) {
  return {
    path: filePath,
    size: 0,
    mtimeMs: 0,
    partialLine: '',
    decoder: new StringDecoder('utf8'),
    byRequest: new Map(),
    order: [],
    sums: { fresh: 0, cw: 0, cr: 0, out: 0 },
  };
}

function appendNewBytes(parser, filePath, newSize) {
  const length = newSize - parser.size;
  if (length <= 0) return;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, parser.size);
    const text = parser.partialLine + parser.decoder.write(buffer);
    parser.size = newSize;
    const lines = text.split('\n');
    parser.partialLine = lines.pop() || '';
    for (let i = 0; i < lines.length; i++) processLine(parser, lines[i]);
  } finally {
    fs.closeSync(fd);
  }
}

function processLine(parser, line) {
  if (!line) return;
  const entry = parseUsageEntry(line);
  if (!entry) return;
  const requestId = entry.requestId || `idx${parser.order.length}`;
  const usage = entry.message.usage;
  const ts = entry.timestamp || '';
  const old = parser.byRequest.get(requestId);
  if (old) {
    parser.sums.fresh -= old.usage.input_tokens || 0;
    parser.sums.cw    -= old.usage.cache_creation_input_tokens || 0;
    parser.sums.cr    -= old.usage.cache_read_input_tokens || 0;
    parser.sums.out   -= old.usage.output_tokens || 0;
  } else {
    parser.order.push(requestId);
  }
  parser.sums.fresh += usage.input_tokens || 0;
  parser.sums.cw    += usage.cache_creation_input_tokens || 0;
  parser.sums.cr    += usage.cache_read_input_tokens || 0;
  parser.sums.out   += usage.output_tokens || 0;
  parser.byRequest.set(requestId, { usage, ts });
}

function parseUsageEntry(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry || entry.type !== 'assistant') return null;
    if (!entry.message?.usage) return null;
    return entry;
  } catch (_) {
    return null;
  }
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

function buildPayload(parser, includeHistory) {
  if (!parser.order.length) return null;
  const lastUsage = parser.byRequest.get(parser.order[parser.order.length - 1]).usage;
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
    const lastTs  = parser.byRequest.get(parser.order[parser.order.length - 1]).ts;
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
  if (includeHistory) payload.history = parser.order.map(id => payloadHistoryEntry(parser, id));
  return payload;
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

function sendPayload(comm, payload) {
  try {
    if (!comm.webview || typeof comm.webview.postMessage !== 'function') {
      throw new Error('[cceBadge] attachComm expected a comm.webview.postMessage()');
    }
    comm.webview.postMessage({ __cceBadge: true, payload });
  } catch (_) {}
}

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

module.exports = { attachComm };
