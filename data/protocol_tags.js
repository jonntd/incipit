/**
 * Host / CLI internal protocol tags that occasionally leak into the
 * transcript as raw XML (tool results, injected user rows, local-command
 * bookkeeping). Pure parse + label helpers — no DOM, no host deps — so
 * unit tests and the webview share one implementation.
 *
 * Known families:
 *   <task-notification>…</task-notification>
 *   <system-reminder>…</system-reminder>
 *   <local-command-caveat>…</local-command-caveat>
 *   <command-name>/<command-message>/<command-args>/<local-command-*>
 */

const TASK_NOTIFICATION_RE =
  /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification\s*>/i;
const SYSTEM_REMINDER_RE =
  /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder\s*>/i;
const LOCAL_COMMAND_CAVEAT_RE =
  /<local-command-caveat\b[^>]*>([\s\S]*?)<\/local-command-caveat\s*>/i;
const COMMAND_CLUSTER_PREFIX_RE = /^\s*<\/?(?:local-)?command-[a-z]+\b/i;
const TAG_FIELD_RE = /<([a-z][\w-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

const EXIT_CODE_RE = /\bexit(?:\s+code)?\s*[:=]?\s*(\d+)\b/i;
const QUOTED_TITLE_RE = /"([^"\n]{1,160})"/;
const MONITOR_TITLE_RE = /Monitor\s+"([^"]+)"/i;

/**
 * True when `text` is dominated by a known internal protocol payload
 * (starts with a known open/close tag, or is a command-cluster prefix).
 * Used as the edit/rerun non-prose gate and as the decorate predicate.
 */
export function isProtocolLeakText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  if (COMMAND_CLUSTER_PREFIX_RE.test(t)) return true;
  if (/^<\/?(?:task-notification|system-reminder|local-command-caveat)\b/i.test(t)) {
    return true;
  }
  // Embedded whole-tag payload that still fills most of the body
  // (e.g. a tool result that only wraps the XML).
  const parsed = parseProtocolText(t);
  return !!(parsed && parsed.dominant);
}

/**
 * Parse a protocol payload into a display-ready card model, or null.
 *
 * Shape:
 *   {
 *     kind: 'task-notification' | 'system-reminder' | 'local-command-caveat' | 'command',
 *     status: 'error' | 'success' | 'pending' | 'cancelled' | 'info',
 *     title: string,          // short kind label (language-agnostic keys resolved later)
 *     summary: string,        // one-line human summary
 *     fields: Object,         // raw field map when available
 *     raw: string,            // original text
 *     dominant: boolean,      // true when the protocol occupies the whole body
 *   }
 */
export function parseProtocolText(text) {
  if (typeof text !== 'string') return null;
  const raw = text;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const task = matchTag(trimmed, TASK_NOTIFICATION_RE);
  if (task) {
    const fields = extractFields(task.inner);
    const status = normalizeStatus(fields.status || fields.state || '');
    const summary =
      cleanField(fields.summary) ||
      cleanField(fields.message) ||
      defaultTaskSummary(fields, status);
    return {
      kind: 'task-notification',
      status,
      titleKey: 'taskNotification',
      summary,
      fields,
      raw,
      dominant: isDominant(trimmed, task.full),
      exitCode: extractExitCode(summary) || extractExitCode(fields.summary) || null,
      taskId: cleanField(fields['task-id'] || fields.taskId || fields.id) || null,
      toolUseId: cleanField(fields['tool-use-id'] || fields.toolUseId) || null,
    };
  }

  const reminder = matchTag(trimmed, SYSTEM_REMINDER_RE);
  if (reminder) {
    const body = collapseWs(reminder.inner);
    return {
      kind: 'system-reminder',
      status: 'info',
      titleKey: 'systemReminder',
      summary: body || 'System reminder',
      fields: {},
      raw,
      dominant: isDominant(trimmed, reminder.full),
      exitCode: null,
      taskId: null,
      toolUseId: null,
    };
  }

  const caveat = matchTag(trimmed, LOCAL_COMMAND_CAVEAT_RE);
  if (caveat) {
    const body = collapseWs(caveat.inner);
    return {
      kind: 'local-command-caveat',
      status: 'info',
      titleKey: 'localCommandCaveat',
      summary: body || 'Local command note',
      fields: {},
      raw,
      dominant: isDominant(trimmed, caveat.full),
      exitCode: null,
      taskId: null,
      toolUseId: null,
    };
  }

  if (COMMAND_CLUSTER_PREFIX_RE.test(trimmed)) {
    const fields = extractFields(trimmed);
    const name = cleanField(fields['command-name'] || fields['command-message']) || '';
    const args = cleanField(fields['command-args']) || '';
    const stdout = cleanField(fields['local-command-stdout']) || '';
    const stderr = cleanField(fields['local-command-stderr']) || '';
    const summary = stdout || stderr ||
      (name ? (args ? `${name} ${args}` : name) : 'Slash command');
    return {
      kind: 'command',
      status: stderr ? 'error' : 'success',
      titleKey: 'command',
      summary: collapseWs(summary),
      fields,
      raw,
      dominant: true,
      exitCode: null,
      taskId: null,
      toolUseId: null,
      commandName: name,
      commandArgs: args,
    };
  }

  return null;
}

/**
 * Build the one-line card title for a parsed protocol model.
 * `lang` is 'zh' | anything-else (defaults to English).
 */
export function protocolCardTitle(parsed, lang) {
  if (!parsed) return '';
  const zh = lang === 'zh';
  switch (parsed.kind) {
    case 'task-notification':
      return zh ? '后台任务' : 'Background task';
    case 'system-reminder':
      return zh ? '系统提示' : 'System notice';
    case 'local-command-caveat':
      return zh ? '本地命令说明' : 'Local command note';
    case 'command': {
      const name = parsed.commandName || '';
      if (name) return zh ? `命令 ${name}` : `Command ${name}`;
      return zh ? '斜杠命令' : 'Slash command';
    }
    default:
      return zh ? '内部消息' : 'Internal message';
  }
}

/**
 * Build the one-line status chip label.
 */
export function protocolStatusLabel(status, lang) {
  const zh = lang === 'zh';
  switch (status) {
    case 'error': return zh ? '失败' : 'failed';
    case 'success': return zh ? '完成' : 'done';
    case 'pending': return zh ? '进行中' : 'running';
    case 'cancelled': return zh ? '已取消' : 'cancelled';
    default: return zh ? '提示' : 'info';
  }
}

/**
 * Full one-line headline shown next to the status chip.
 * Prefers the host summary, falls back to a structured reconstruction.
 */
export function protocolCardHeadline(parsed, lang) {
  if (!parsed) return '';
  if (parsed.kind === 'task-notification') {
    const base = collapseWs(parsed.summary || '');
    if (base) return base;
    const status = protocolStatusLabel(parsed.status, lang);
    const id = parsed.taskId ? ` · ${parsed.taskId.slice(0, 8)}` : '';
    return lang === 'zh'
      ? `后台任务${status}${id}`
      : `Background task ${status}${id}`;
  }
  return collapseWs(parsed.summary || protocolCardTitle(parsed, lang));
}

function matchTag(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  return { full: m[0], inner: m[1] == null ? '' : m[1] };
}

function extractFields(inner) {
  const fields = Object.create(null);
  if (typeof inner !== 'string' || !inner) return fields;
  TAG_FIELD_RE.lastIndex = 0;
  let m;
  while ((m = TAG_FIELD_RE.exec(inner)) !== null) {
    const key = String(m[1] || '').toLowerCase();
    if (!key) continue;
    // Keep first occurrence; nested re-parses aren't needed for our tags.
    if (fields[key] == null) fields[key] = m[2];
  }
  return fields;
}

function cleanField(value) {
  if (typeof value !== 'string') return '';
  return collapseWs(value);
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isDominant(full, matched) {
  if (!full || !matched) return false;
  // Protocol payload is the whole body, or fills most of it (allowing a
  // short host prefix like "Read …" wrappers that some tools prepend).
  if (full === matched) return true;
  if (full.startsWith(matched) || full.endsWith(matched)) {
    return matched.length / full.length >= 0.6;
  }
  return matched.length / full.length >= 0.85;
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'info';
  if (
    s === 'error' || s === 'failed' || s === 'failure' ||
    s === 'rejected' || s === 'fail'
  ) return 'error';
  if (
    s === 'success' || s === 'completed' || s === 'ok' ||
    s === 'done' || s === 'succeeded'
  ) return 'success';
  if (
    s === 'pending' || s === 'running' || s === 'in_progress' ||
    s === 'queued' || s === 'started'
  ) return 'pending';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'info';
}

function extractExitCode(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = EXIT_CODE_RE.exec(text);
  return m ? m[1] : null;
}

function defaultTaskSummary(fields, status) {
  const statusWord = status || 'info';
  const quoted =
    (typeof fields.summary === 'string' && QUOTED_TITLE_RE.exec(fields.summary)) ||
    (typeof fields.summary === 'string' && MONITOR_TITLE_RE.exec(fields.summary));
  if (quoted && quoted[1]) {
    return `${quoted[1]} · ${statusWord}`;
  }
  const id = cleanField(fields['task-id'] || fields.taskId || '');
  if (id) return `task ${id.slice(0, 8)} · ${statusWord}`;
  return `Background task · ${statusWord}`;
}
