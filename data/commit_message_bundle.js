'use strict';

// Incipit SCM commit-message generator — host-side patch module.
//
// Registered into Claude Code's activate() by install.js (same pattern as
// hunkwise). Shows a sparkle button on the Source Control title bar; click
// builds a bounded git diff prompt, calls Claude via host-badge's shared
// completeClaudeText(), and streams the result into the SCM input box.
//
// No webview, no companion extension. Uses vscode.git + child_process git.

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const COMMAND_ID = 'incipit.generateCommitMessage';
const GIT_TIMEOUT_MS = 15000;
const DIFF_BYTE_BUDGET = 24 * 1024;
const MAX_EXAMPLE_COMMITS = 5;
const MAX_TOKENS = 512;
const GENERATING_PLACEHOLDER = 'Incipit is generating…';

const SYSTEM_PROMPT =
  'You write git commit messages that accurately and faithfully describe the ' +
  'actual code changes shown in the diff. Read the provided diff and status ' +
  'carefully; never invent, guess, or generalize beyond what the changes ' +
  'prove. Output ONLY the commit message text. ' +
  'Use Conventional Commits when it fits (feat/fix/refactor/docs/chore/style/test/perf). ' +
  'The subject line must state what the change does in imperative mood, ' +
  'be at most 72 chars, and have no trailing period. ' +
  'Add a short body only when the change genuinely needs explanation, ' +
  'and only describe behavior the diff actually contains. ' +
  'Use plain text with standard punctuation only: no emoji, no decorative ' +
  'symbols, no markdown fences, no quotes, no preamble, no explanation.';

let activated = false;

function activate(context) {
  if (activated) return;
  activated = true;

  let vscode;
  try {
    vscode = require('vscode');
  } catch (err) {
    console.error('[incipit] commit-message: vscode module unavailable', err);
    return;
  }

  const disposable = vscode.commands.registerCommand(COMMAND_ID, async (arg) => {
    await generateCommitMessage(vscode, arg);
  });

  if (context && context.subscriptions && typeof context.subscriptions.push === 'function') {
    context.subscriptions.push(disposable);
  }
}

async function generateCommitMessage(vscode, arg) {
  const repo = await resolveGitRepository(vscode, arg);
  if (!repo) {
    vscode.window.showInformationMessage('Incipit: no git repository found for commit message.');
    return;
  }

  const root = repo.rootUri && repo.rootUri.fsPath
    ? repo.rootUri.fsPath
    : null;
  if (!root) {
    vscode.window.showInformationMessage('Incipit: cannot resolve repository root.');
    return;
  }

  const previous = typeof repo.inputBox.value === 'string' ? repo.inputBox.value : '';
  repo.inputBox.value = GENERATING_PLACEHOLDER;

  try {
    const promptData = await collectCommitPromptData(root);
    if (!promptData.diff || !promptData.diff.trim()) {
      repo.inputBox.value = previous;
      vscode.window.showInformationMessage('Incipit: nothing to commit (empty diff).');
      return;
    }

    const userText = buildCommitUserPrompt(promptData);
    const complete = loadCompleteClaudeText();
    if (!complete) {
      repo.inputBox.value = previous;
      vscode.window.showErrorMessage(
        'Incipit: Claude complete API unavailable (host-badge not loaded). Re-apply the patch.',
      );
      return;
    }

    const log = (step) => {
      try { console.log(`[incipit][commit-message] ${step}`); } catch (_) { }
    };

    const raw = await complete({
      userText,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_TOKENS,
      cwd: root,
      log,
      postprocess: false,
      timeoutMs: 45000,
    });

    const message = sanitizeCommitMessage(raw);
    if (!message) {
      repo.inputBox.value = previous;
      vscode.window.showErrorMessage('Incipit: model returned an empty commit message.');
      return;
    }
    repo.inputBox.value = message;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    repo.inputBox.value = previous;
    vscode.window.showErrorMessage(`Incipit: commit message failed — ${msg}`);
    try { console.error('[incipit][commit-message]', err); } catch (_) { }
  }
}

async function resolveGitRepository(vscode, arg) {
  let gitExt;
  try {
    gitExt = vscode.extensions.getExtension('vscode.git');
  } catch (_) {
    return null;
  }
  if (!gitExt) return null;
  if (!gitExt.isActive) {
    try { await gitExt.activate(); } catch (_) { return null; }
  }
  const api = gitExt.exports && typeof gitExt.exports.getAPI === 'function'
    ? gitExt.exports.getAPI(1)
    : null;
  if (!api || !Array.isArray(api.repositories) || api.repositories.length === 0) {
    return null;
  }

  // scm/title may pass a SourceControl-like arg with rootUri, or (via
  // package.json args: ["${resourceUri}"]) a bare Uri / path string.
  const candidateUris = [];
  if (arg) {
    if (arg.rootUri) candidateUris.push(arg.rootUri);
    if (arg.resourceUri) candidateUris.push(arg.resourceUri);
    // `${resourceUri}` expands to a Uri object or its string form.
    if (arg.scheme && (arg.fsPath || arg.path)) candidateUris.push(arg);
    if (typeof arg === 'string' && arg) candidateUris.push(arg);
  }
  for (const cand of candidateUris) {
    const hit = api.repositories.find((r) => {
      try {
        if (!r.rootUri) return false;
        if (typeof cand === 'string') {
          const root = r.rootUri.fsPath || '';
          const pathStr = cand.startsWith('file:')
            ? (vscode.Uri.parse(cand).fsPath || cand)
            : cand;
          return pathStr === root || pathStr.startsWith(root + path.sep) || pathStr.startsWith(root + '/');
        }
        if (cand.toString && r.rootUri.toString() === cand.toString()) return true;
        const candPath = cand.fsPath || '';
        const root = r.rootUri.fsPath || '';
        return candPath && root && (candPath === root || candPath.startsWith(root + path.sep) || candPath.startsWith(root + '/'));
      } catch (_) {
        return false;
      }
    });
    if (hit) return hit;
  }

  // Prefer the repository for the active editor / workspace folder.
  try {
    const active = vscode.window.activeTextEditor;
    if (active && active.document && active.document.uri) {
      const docPath = active.document.uri.fsPath || '';
      const byDoc = api.repositories.find((r) => {
        const root = r.rootUri && r.rootUri.fsPath;
        return root && docPath.startsWith(root);
      });
      if (byDoc) return byDoc;
    }
  } catch (_) { }

  try {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (folder) {
      const byFolder = api.repositories.find((r) => {
        try {
          return r.rootUri && r.rootUri.toString() === folder.uri.toString();
        } catch (_) {
          return false;
        }
      });
      if (byFolder) return byFolder;
    }
  } catch (_) { }

  return api.repositories[0];
}

function loadCompleteClaudeText() {
  // Prefer sibling host-badge.cjs (same webview/ directory after apply).
  const candidates = [
    path.join(__dirname, 'host-badge.cjs'),
    path.join(__dirname, '..', 'host-badge.cjs'),
  ];
  for (const file of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(file);
      if (mod && typeof mod.completeClaudeText === 'function') {
        return mod.completeClaudeText;
      }
    } catch (_) { }
  }
  return null;
}

async function collectCommitPromptData(root) {
  const [status, stagedDiff, unstagedDiff, recentLog] = await Promise.all([
    git(root, ['status', '--porcelain']),
    git(root, ['diff', '--staged', '--no-color', '--find-renames']),
    git(root, ['diff', '--no-color', '--find-renames']),
    git(root, ['log', '-n', String(MAX_EXAMPLE_COMMITS), '--pretty=format:%s']),
  ]);

  let diff = '';
  if (stagedDiff && stagedDiff.trim()) {
    diff += stagedDiff;
  }
  if (unstagedDiff && unstagedDiff.trim()) {
    if (diff) diff += '\n';
    // Prefer staged; still include unstaged so unstaged-only workflows work
    // (matches Augment onlyUseStagedChanges:false default).
    if (!stagedDiff || !stagedDiff.trim()) {
      diff += unstagedDiff;
    } else {
      // Staged exists — keep unstaged as a short name list only if room left.
      const names = await git(root, ['diff', '--name-only']);
      if (names && names.trim()) {
        const note = `\n# also unstaged:\n${names.trim()}\n`;
        if (diff.length + note.length < DIFF_BYTE_BUDGET) diff += note;
      }
    }
  }

  diff = truncateDiff(diff, DIFF_BYTE_BUDGET);

  const examples = (recentLog || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_EXAMPLE_COMMITS);

  return {
    status: (status || '').trim(),
    diff,
    examples,
  };
}

function truncateDiff(diff, budget) {
  if (!diff) return '';
  if (diff.length <= budget) return diff;
  // Prefer keeping the head of each file hunk by cutting mid-body.
  return `${diff.slice(0, budget)}\n\n…[diff truncated ${diff.length - budget} bytes]…`;
}

function buildCommitUserPrompt(data) {
  const parts = [];
  parts.push('Write a commit message that strictly reflects the git changes below.');
  parts.push('Base it ONLY on the Status and Diff provided; describe what the code actually does.');
  parts.push('Do not invent changes, files, or behavior not present in the diff.');
  if (data.status) {
    parts.push('');
    parts.push('## Status');
    parts.push('```');
    parts.push(data.status);
    parts.push('```');
  }
  if (data.examples && data.examples.length) {
    parts.push('');
    parts.push('## Recent commit subjects (style reference)');
    for (const ex of data.examples) parts.push(`- ${ex}`);
  }
  parts.push('');
  parts.push('## Diff');
  parts.push('```diff');
  parts.push(data.diff);
  parts.push('```');
  parts.push('');
  parts.push('Respond with the commit message only.');
  return parts.join('\n');
}

function sanitizeCommitMessage(raw) {
  if (raw == null) return '';
  let text = String(raw).replace(/^﻿/, '').trim();
  // Strip common model wrappers.
  text = text.replace(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/m, '$1').trim();
  text = text.replace(/^["'`]|["'`]$/g, '').trim();
  // Drop a leading "Commit message:" label if the model adds one.
  text = text.replace(/^(?:commit\s*message\s*[:：-]\s*)/i, '').trim();
  // Strip emoji / dingbats / other decorative symbols. Keep letters (any
  // script), digits, whitespace, and common punctuation.
  text = text.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{So}|\p{Sk}/gu, '').trim();
  // Collapse spaces left by stripped symbols.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n');
  // Normalize line endings; cap runaway length.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (text.length > 2000) text = text.slice(0, 2000).trim();
  return text;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
    });
    return typeof stdout === 'string' ? stdout : String(stdout || '');
  } catch (err) {
    // Empty repo / no commits / not a repo — surface a clear error only for
    // hard failures; soft empties return ''.
    if (err && (err.code === 'ENOENT')) {
      throw new Error('git binary not found on PATH');
    }
    const stderr = err && err.stderr ? String(err.stderr) : '';
    const msg = err && err.message ? err.message : String(err);
    // "does not have any commits yet" etc. — treat as empty output.
    if (/does not have any commits|unknown revision|bad revision|no names found/i.test(stderr + msg)) {
      return '';
    }
    // status/diff on empty worktree is fine; other nonzero exits bubble.
    if (Array.isArray(args) && (args[0] === 'diff' || args[0] === 'status' || args[0] === 'log')) {
      return '';
    }
    throw new Error(stderr.trim() || msg);
  }
}

module.exports = {
  activate,
  // Test surface
  __test: {
    COMMAND_ID,
    SYSTEM_PROMPT,
    DIFF_BYTE_BUDGET,
    sanitizeCommitMessage,
    buildCommitUserPrompt,
    truncateDiff,
    collectCommitPromptData,
    GENERATING_PLACEHOLDER,
  },
};
