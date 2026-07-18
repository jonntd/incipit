'use strict';

// Incipit file/folder-reference companion.
//
// Claude Code's composer drop handler only accepts items whose dataTransfer
// kind is "file", so dragging a *folder* into the chat is silently
// ignored (and folder URIs carried in text/uri-list are stripped). This
// companion fills that gap for BOTH files and folders via one explorer
// context menu entry and a picker. It inserts the selection as an `@<path>`
// mention through the same `incipit.claudeCode.insertAtMention` bridge
// the selection-reference companion uses. Folders get a trailing slash to
// match Claude Code's own directory-reference shape (added by the `@`
// picker's directory branch), so the webview reads them as folder refs.

const vscode = require('vscode');
const fs = require('fs');

const CONFIG_SECTION = 'incipitClaudeFolderReference';
const COMMAND_ADD = 'incipitClaudeFolderReference.add';
const COMMAND_ADD_FROM_PICKER = 'incipitClaudeFolderReference.addFromPicker';
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_INSERT_COMMAND = 'incipit.claudeCode.insertAtMention';

function getConfig() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get('enabled', true),
  };
}

// Build the `@<path>` mention. Directories get a trailing slash so
// Claude Code treats them as a folder reference; files do not.
function mentionFor(resource, isFolder) {
  let fsPath = null;
  if (resource && typeof resource.fsPath === 'string') {
    fsPath = resource.fsPath;
  } else if (typeof resource === 'string') {
    fsPath = resource.startsWith('file://')
      ? vscode.Uri.parse(resource).fsPath
      : resource;
  }
  if (!fsPath) return null;
  // A selected Uri has no reliable isDirectory flag from the menu alone,
  // so stat the path when the caller did not tell us.
  let folder = isFolder;
  if (folder === null || folder === undefined) {
    try { folder = fs.statSync(fsPath).isDirectory(); } catch (_) { folder = false; }
  }
  if (folder && !fsPath.endsWith('/') && !fsPath.endsWith('\\')) {
    return `@${fsPath}/`;
  }
  return `@${fsPath}`;
}

async function insertMention(resource, isFolder) {
  const mention = mentionFor(resource, isFolder);
  if (!mention) {
    vscode.window.showWarningMessage('Incipit: no path was available to reference.');
    return;
  }

  if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    vscode.window.showWarningMessage('Claude Code for VS Code is not installed.');
    return;
  }

  try {
    await vscode.commands.executeCommand(CLAUDE_INSERT_COMMAND, mention);
  } catch (error) {
    vscode.window.showWarningMessage(
      'Could not insert the reference in Claude Code. Run incipit apply, reload your IDE, and try again.',
    );
    throw error;
  }
}

// Explorer context menu passes the clicked resource, and (when multi-
// selecting) the full selected-resource array as the second argument.
function collectResources(arg, selected) {
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item) return;
    let key = null;
    if (typeof item === 'string') key = item;
    else if (item.fsPath) key = item.fsPath;
    else if (item.path) key = item.path;
    else if (typeof item.toString === 'function') key = item.toString();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  if (Array.isArray(selected) && selected.length) {
    for (const item of selected) push(item);
  } else {
    push(arg);
  }
  return out;
}

function resourceIsFolder(resource) {
  const fsPath = resource && resource.fsPath
    ? resource.fsPath
    : (typeof resource === 'string' ? resource : null);
  if (!fsPath) return false;
  try { return fs.statSync(fsPath).isDirectory(); } catch (_) { return false; }
}

async function addResources(arg, selected) {
  const resources = collectResources(arg, selected);
  if (!resources.length) {
    vscode.window.showWarningMessage('Incipit: invoke this action on a file or folder in the explorer.');
    return;
  }
  for (const resource of resources) {
    await insertMention(resource, resourceIsFolder(resource));
  }
}

async function addFromPicker() {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Add to Claude Code',
    title: 'Incipit: Add to Claude Code',
  });
  if (!uris || uris.length === 0) return;
  for (const uri of uris) {
    await insertMention(uri, resourceIsFolder(uri));
  }
}

function activate(context) {
  if (!getConfig().enabled) return;

  context.subscriptions.push(
    // Unified entry: works for both files and folders (and multi-select).
    vscode.commands.registerCommand(COMMAND_ADD, async (resource, selected) => {
      if (!getConfig().enabled) return;
      await addResources(resource, selected);
    }),
    vscode.commands.registerCommand(COMMAND_ADD_FROM_PICKER, async () => {
      if (!getConfig().enabled) return;
      await addFromPicker();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
