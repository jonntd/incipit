'use strict';

// Incipit file/folder-reference companion.
//
// Claude Code's composer drop handler only accepts items whose dataTransfer
// kind is "file", so dragging a *folder* into the chat is silently
// ignored (and folder URIs carried in text/uri-list are stripped). This
// companion fills that gap for BOTH files and folders via the explorer
// context menu and a picker. It inserts the selection as an `@<path>`
// mention through the same `incipit.claudeCode.insertAtMention` bridge
// the selection-reference companion uses. Folders get a trailing slash to
// match Claude Code's own directory-reference shape (added by the `@`
// picker's directory branch), so the webview reads them as folder refs.

const vscode = require('vscode');
const fs = require('fs');

const CONFIG_SECTION = 'incipitClaudeFolderReference';
const COMMAND_ADD_FOLDER = 'incipitClaudeFolderReference.addFolder';
const COMMAND_ADD_FILE = 'incipitClaudeFolderReference.addFile';
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

// Explorer context menu passes the selected resource (a Uri-like object).
function resourceFromArg(arg) {
  if (!arg) return null;
  if (arg.fsPath || arg.path || arg.toString) return arg;
  return null;
}

async function addFromPicker() {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Reference in Claude Code',
    title: 'Incipit: Add File or Folder to Claude Code',
  });
  if (!uris || uris.length === 0) return;
  for (const uri of uris) {
    let isFolder = null;
    try { isFolder = fs.statSync(uri.fsPath).isDirectory(); } catch (_) { isFolder = false; }
    await insertMention(uri, isFolder);
  }
}

function activate(context) {
  if (!getConfig().enabled) return;

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ADD_FOLDER, async (resource) => {
      if (!getConfig().enabled) return;
      const target = resourceFromArg(resource);
      if (!target) {
        vscode.window.showWarningMessage('Incipit: invoke this action on a folder in the explorer.');
        return;
      }
      await insertMention(target, true);
    }),
    vscode.commands.registerCommand(COMMAND_ADD_FILE, async (resource) => {
      if (!getConfig().enabled) return;
      const target = resourceFromArg(resource);
      if (!target) {
        vscode.window.showWarningMessage('Incipit: invoke this action on a file in the explorer.');
        return;
      }
      await insertMention(target, false);
    }),
    vscode.commands.registerCommand(COMMAND_ADD_FROM_PICKER, async () => {
      if (!getConfig().enabled) return;
      await addFromPicker();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
