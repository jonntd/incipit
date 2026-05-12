# Incipit: Claude Selection Reference

Tiny VS Code companion extension proof for Claude Code.

When the active editor has a non-empty selection, it normally shows two clickable CodeLens actions above the selection's first line: `◆ 选中段` and `▣ 整文件`. Clicking either action opens Claude Code if needed and inserts a visible official `@file#x-y` or `@file` reference in the composer.

If incipit's experimental Workbench editor overlay is enabled in the CLI config, this extension hides CodeLens entirely. The overlay must then apply successfully and call `incipitClaudeReference.referenceActiveSelection` or `incipitClaudeReference.referenceActiveFile` directly; incipit no longer masks an overlay failure with a CodeLens fallback.

## Local Test

From the repository root:

```powershell
code --extensionDevelopmentPath="$PWD\companion\claude-selection-reference"
```

Or copy this folder into your VS Code extensions directory and reload VS Code:

```powershell
$dst = "$env:USERPROFILE\.vscode\extensions\incipit.claude-selection-reference-0.0.1"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item companion\claude-selection-reference\* $dst -Recurse -Force
```

Select text in an editor, then click `◆ 选中段` or `▣ 整文件`.

## Notes

- It does not write Claude Code transcripts.
- It does not call `session.send`.
- It reuses Claude Code's own `claude-vscode.editor.openLast` / `claude-vscode.insertAtMention` commands.
- The experimental overlay is installed by the incipit CLI, not by this companion extension.
