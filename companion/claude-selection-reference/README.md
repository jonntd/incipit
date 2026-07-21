# Incipit: Claude Selection Reference

Tiny VS Code companion extension proof for Claude Code.

When the active editor has a non-empty selection, it normally shows two clickable CodeLens actions above the selection's first line: `◆ Selection` and `▣ File`. Clicking either action opens Claude Code if needed and inserts a visible official `@file#x-y` or `@file` reference in the composer.

If incipit's experimental Workbench editor overlay is enabled in the CLI config, this extension hides CodeLens entirely. The overlay must then apply successfully and call `incipitClaudeReference.referenceActiveSelection` or `incipitClaudeReference.referenceActiveFile` directly; incipit no longer masks an overlay failure with a CodeLens fallback.

## Local Test

From the repository root:

```powershell
code --extensionDevelopmentPath="$PWD\companion\claude-selection-reference"
```

Or copy this folder into your VS Code extensions directory and reload VS Code:

```powershell
$dst = "$env:USERPROFILE\.vscode\extensions\incipit.claude-selection-reference-0.0.3"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item companion\claude-selection-reference\* $dst -Recurse -Force
```

Select text in an editor, then click `◆ Selection` or `▣ File`.

## Notes

- Package uses VS Code convention: `publisher: "incipit"` + short `name: "claude-selection-reference"` → full id `incipit.claude-selection-reference`. Older installs used a bare registry id or a double-prefixed ghost (`incipit.incipit.*`); `incipit apply` / restore prune those.
- It does not write Claude Code transcripts.
- It does not call `session.send`.
- It reuses the incipit-patched Claude command bridge (`incipit.claudeCode.insertAtMention`), so it does not depend on Claude Code's own `insertAtMention` callback accepting arguments.
- The experimental overlay is installed by the incipit CLI, not by this companion extension. Overlay host-identity written by this extension only *locates* an official VS Code Workbench — reshaped forks (Trae / Antigravity / Cursor / …) are never patched via that path.
