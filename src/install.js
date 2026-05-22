// Core installer for `incipit`.
//
// This module locates the local Claude Code extension, patches
// `extension.js` and `webview/index.js`, syncs webview assets, installs
// system fonts, and writes webview-side theme assets. The regex anchors
// target the minified bundle shape and may need to move when the extension
// updates.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const { HOST_BADGE_COMM_ATTACH } = require('./badge-iife');
const {
  buildInstallManifestPreamble,
  patchContract,
} = require('./patch-contract');

// ============================================================
// constants
// ============================================================

const {
  getFeatures,
  getTheme,
  getLanguage,
  pruneRetiredConfigKeys,
} = require('./config');
const {
  applyWorkbenchOverlayForTarget,
  preflightWorkbenchOverlayForTarget,
} = require('./workbench-overlay');

const CLAUDE_CODE_EXTENSION_PREFIX = 'anthropic.claude-code-';
const ENHANCE_TARGET_NAME = 'enhance.js';
const THEME_TARGET_NAME = 'theme.css';

// Root-level webview files as `[sourceRelativePath, targetFileName]`.
// `theme.css` stays separate from the JS template string so CSS comments and
// backticks cannot terminate the template by accident.
const ROOT_WEBVIEW_FILES = [
  [path.join('data', 'claude_code_enhance.js'), ENHANCE_TARGET_NAME],
  [path.join('data', 'enhance_shared.js'),      'enhance_shared.js'],
  [path.join('data', 'runtime_kernel.js'),      'runtime_kernel.js'],
  [path.join('data', 'capability.js'),          'capability.js'],
  [path.join('data', 'enhance_footer_badge.js'), 'enhance_footer_badge.js'],
  [path.join('data', 'enhance_thinking.js'),    'enhance_thinking.js'],
  [path.join('data', 'enhance_typography.js'),  'enhance_typography.js'],
  [path.join('data', 'enhance_legacy.js'),      'enhance_legacy.js'],
  [path.join('data', 'host_probe.js'),           'host_probe.js'],
  [path.join('data', 'host-badge.cjs'),          'host-badge.cjs'],
  [path.join('data', 'markdown_preprocess.js'),  'markdown_preprocess.js'],
  [path.join('data', 'math_tokens.js'),         'math_tokens.js'],
  [path.join('data', 'math_rewriter.js'),       'math_rewriter.js'],
  [path.join('data', 'theme.css'),              THEME_TARGET_NAME],
  // Warm-white palette overrides. Always copied so users can flip the
  // setting without re-running apply just to ship the CSS file. enhance.js
  // only loads this stylesheet when `theme.palette === 'warm-white'`.
  [path.join('data', 'warm-white-override.css'), 'warm-white-override.css'],
];

const CDN_HOST = 'https://cdnjs.cloudflare.com';
const IMPORT_MARKER =
  'import("./enhance.js").catch(e=>console.error("[incipit] enhance.js import failed",e));';
// Local asset subtrees copied from `data/<name>/` to `webview/<name>/`.
// Sync the whole subtree so math, highlighting, and fonts work offline.
const LOCAL_ASSET_TREES = ['katex', 'hljs', 'fonts', 'effort-brain', 'capability', 'legacy'];
// Asset subtrees we used to ship but no longer need. `apply` wipes these on
// sight so upgrades never leave dead bytes behind in the host webview folder.
const LEGACY_ASSET_TREES = ['mathjax'];

// Files copied into the user font directory. Only the Latin serif family is
// installed here. CJK faces are left to the system fallback stack.
const SYSTEM_FONT_FILES = [
  ['IBMPlexSerif-Regular.ttf',  'ibm-plex-serif', 'IBM Plex Serif Regular (TrueType)'],
  ['IBMPlexSerif-SemiBold.ttf', 'ibm-plex-serif', 'IBM Plex Serif SemiBold (TrueType)'],
];

const HOST_CONTACT_ROUTE_SCHEMA = 1;
const HOST_CONTACT_ROUTE_CATALOG = Object.freeze([
  {
    version: '2.1.121',
    extensionSha256: 'c980466139fdcd080ac152dc4ee7788ea952269a257d4a998128abe28537baa7',
    webviewSha256: '3d31890fdaf6652321c364a5487dcc06cf562f8a01075205c5f94adf8142598c',
  },
  {
    version: '2.1.138',
    extensionSha256: '2eb0e3330338ab8bf4e5da55a0735af8381d11f027475c96ab75f8145b24cd3e',
    webviewSha256: '355bc0126b0996b520cc59b1cadff20e6d28398130710822d5c9cfe88004da4e',
  },
  {
    version: '2.1.141',
    extensionSha256: '23f19a6044439e67c5f2532c3fd02bb63397ee7835040a51ba114474367abd1e',
    webviewSha256: 'd756d1d369cfb41ad0ec620506c7c7e11b2fbf4528516b62e0375a5e658e3b13',
  },
  {
    version: '2.1.142',
    extensionSha256: '3a56333fa3b4741d745ec73eee24bf265136e7515be5af6856c238d09553c5c7',
    webviewSha256: '2727800f6031127b5a19990ff06d0e808e059db3a34eb71d796c8c7e9b721594',
  },
  {
    version: '2.1.143',
    extensionSha256: '2872829b556b4a8cdf90aabaadaa7707414db77f898bb6a9334f007331b8a39f',
    webviewSha256: '99f00381e05d64f0556e00e72cb4d5407cbd0f27527024c99f73865b22bff5b9',
  },
  {
    version: '2.1.145',
    extensionSha256: '875f3cbefa2eae50ad6e4c33fafeee497157b90fa51c0ff8081ec067850f146d',
    webviewSha256: '4859359df2997722b41ed109cb0217b6b4bfa88646a1c4036f08f1ab130dc687',
  },
]);

function sanitizeFontFamilyValue(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Reject characters that can terminate or corrupt the generated CSS
  // variable block.
  if (/[;{}\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

// ============================================================
// regexes
// ============================================================

const VERSION_RE = /anthropic\.claude-code-(\d+(?:\.\d+)+)/;

const STYLE_CSP_PATTERN =
  /style-src \$\{[^}]+\} 'unsafe-inline'(?! https:\/\/cdnjs\.cloudflare\.com)/;
const STYLE_CSP_PATCHED_RE =
  /style-src \$\{[^}]+\} 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/;

const SCRIPT_CSP_PATTERN =
  /script-src 'nonce-\$\{[^}]+\}'(?! https:\/\/cdnjs\.cloudflare\.com)/;
const SCRIPT_CSP_PATCHED_RE =
  /script-src 'nonce-\$\{[^}]+\}' https:\/\/cdnjs\.cloudflare\.com/;

const FONT_CSP_PATTERN =
  /font-src \$\{[^}]+\}(?! https:\/\/cdnjs\.cloudflare\.com data:)/;
const FONT_CSP_PATCHED_RE =
  /font-src \$\{[^}]+\} https:\/\/cdnjs\.cloudflare\.com data:/;

const STATIC_IMPORT_RE = /(?:\r?\n)?import\s+['"]\.\/enhance\.js['"];?(?:\r?\n)?/;
const DYNAMIC_IMPORT_RE =
  /(?:\r?\n)?import\(\s*['"]\.\/enhance\.js['"]\s*\)(?:\.catch\([^)]*\))?;?(?:\r?\n)?/;

// Patch the final "markdown string -> file.value" handoff in the bundled
// `react-markdown` wrapper instead of relying on the exact compiled children
// initializer (`$.children || ""`), which is more volatile across builds.
const MARKDOWN_ASSIGN_PATTERN =
  /if\(typeof ([A-Za-z_$][\w$]*)==="string"\)([A-Za-z_$][\w$]*)\.value=\1;else ([A-Za-z_$][\w$]*)\("Unexpected value `"\+\1\+"` for `children` prop, expected `string`"\)/g;
const MARKDOWN_LEGACY_CHILDREN_RE =
  /([A-Za-z_$][\w$]*)=window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\?window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\(\$\.children\|\|""\):\(\$\.children\|\|""\)/g;
const MARKDOWN_ASSIGN_PATCHED_RE =
  /if\(typeof [A-Za-z_$][\w$]*==="string"\)\{if\(window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\)[A-Za-z_$][\w$]*=window\.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__\([A-Za-z_$][\w$]*\);[A-Za-z_$][\w$]*\.value=[A-Za-z_$][\w$]*;\}else [A-Za-z_$][\w$]*\("Unexpected value `"\+[A-Za-z_$][\w$]*\+"` for `children` prop, expected `string`"\)/;
const MARKDOWN_CODE_COMPONENT_PATTERN =
  /code:\(\{children:([A-Za-z_$][\w$]*),className:([A-Za-z_$][\w$]*)\}\)=>\{if\(\2\)return ([A-Za-z_$][\w$]*)\.default\.createElement\("code",\{className:\2\},\1\);let ([A-Za-z_$][\w$]*)=String\(\1\);/g;
const MARKDOWN_CODE_COMPONENT_PATCHED_RE =
  /code:\(\{children:[A-Za-z_$][\w$]*,className:[A-Za-z_$][\w$]*\}\)=>\{let [A-Za-z_$][\w$]*=String\([A-Za-z_$][\w$]*\),__incipitHtml;if\([A-Za-z_$][\w$]*\)\{__incipitHtml=window\.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window\.__INCIPIT_HIGHLIGHT_CODE_HTML__\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\);if\(__incipitHtml!==null&&__incipitHtml!==void 0\)return [A-Za-z_$][\w$]*\.default\.createElement\("code",\{className:[A-Za-z_$][\w$]*\+" hljs",dangerouslySetInnerHTML:\{__html:__incipitHtml\}\}\);return [A-Za-z_$][\w$]*\.default\.createElement\("code",\{className:[A-Za-z_$][\w$]*\},[A-Za-z_$][\w$]*\)\}if\([A-Za-z_$][\w$]*\.indexOf\("\\n"\)!==-1\)\{__incipitHtml=window\.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window\.__INCIPIT_HIGHLIGHT_CODE_HTML__\([A-Za-z_$][\w$]*,""\);if\(__incipitHtml!==null&&__incipitHtml!==void 0\)return [A-Za-z_$][\w$]*\.default\.createElement\("code",\{className:"hljs",dangerouslySetInnerHTML:\{__html:__incipitHtml\}\}\)\}/;
const MARKDOWN_CODE_COMPONENT_V1_PATCHED_PATTERN =
  /code:\(\{children:([A-Za-z_$][\w$]*),className:([A-Za-z_$][\w$]*)\}\)=>\{if\(\2\)\{let ([A-Za-z_$][\w$]*)=String\(\1\),__incipitHtml=window\.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window\.__INCIPIT_HIGHLIGHT_CODE_HTML__\(\3,\2\);if\(__incipitHtml!==null&&__incipitHtml!==void 0\)return ([A-Za-z_$][\w$]*)\.default\.createElement\("code",\{className:\2\+" hljs",dangerouslySetInnerHTML:\{__html:__incipitHtml\}\}\);return \4\.default\.createElement\("code",\{className:\2\},\1\)\}let \3=String\(\1\);/g;
const AT_MENTION_COMMAND_PATTERN =
  /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{\1\.push\(([A-Za-z_$][\w$]*)\.commands\.registerCommand\("claude-vscode\.insertAtMention",async\(\)=>\{(?=let [A-Za-z_$][\w$]*=\4\.window\.activeTextEditor;[\s\S]{0,700}?\2\.fire\()/g;
const AT_MENTION_COMMAND_LEGACY_PATCHED_PATTERN =
  /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{\1\.push\(([A-Za-z_$][\w$]*)\.commands\.registerCommand\("claude-vscode\.insertAtMention",async\(__incipitMention\)=>\{if\(typeof __incipitMention==="string"\)\{\2\.fire\(__incipitMention\);return\}(?=let [A-Za-z_$][\w$]*=\4\.window\.activeTextEditor;)/g;
const AT_MENTION_COMMAND_PATCHED_RE =
  /commands\.registerCommand\("claude-vscode\.insertAtMention",async\(__incipitMention\)=>\{if\(typeof __incipitMention==="string"\)\{if\(![A-Za-z_$][\w$]*\.hasVisibleWebview\(\)\)await [A-Za-z_$][\w$]*\.commands\.executeCommand\("claude-vscode\.editor\.openLast"\);let __incipitFire=\(\)=>[A-Za-z_$][\w$]*\.fire\(__incipitMention\);setTimeout\(__incipitFire,80\);setTimeout\(__incipitFire,360\);return\}/;
const CLAUDE_VISIBLE_COMMAND_PATTERN =
  /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{\1\.push\(([A-Za-z_$][\w$]*)\.commands\.registerCommand\("claude-vscode\.insertAtMention"/g;
const CLAUDE_VISIBLE_COMMAND_PATCHED_RE =
  /commands\.registerCommand\("incipit\.claudeCode\.hasVisibleWebview",\(\)=>[A-Za-z_$][\w$]*\.hasVisibleWebview\(\)\)/;
const IMPLICIT_SELECTION_SEND_PATTERN =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&![A-Za-z_$][\w$]*;([A-Za-z_$][\w$]*)\(\$\.selection\.value,\1,/g;
const IMPLICIT_SELECTION_SEND_PATCHED_RE =
  /let [A-Za-z_$][\w$]*=!1;[A-Za-z_$][\w$]*\(\$\.selection\.value,[A-Za-z_$][\w$]*,/;
const STREAM_UNHANDLED_CASE_PATTERN =
  /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{throw Error\(\3\?\?`Unhandled case: \$\{\2\}`\)\}/g;
const STREAM_UNHANDLED_CASE_PATCHED_RE =
  /function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{try\{var __incipitCase=[\s\S]{0,500}ignored unknown Claude stream case/;
const STREAM_DELTA_SWITCH_PATTERN =
  /function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{let [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.delta;switch\([A-Za-z_$][\w$]*\.type\)\{/g;
const HOST_STATE_BRIDGE_PATTERN =
  /(j4\(\(\)=>\{if\(\(this\.config\.value\?\.claudeSettings\?\.errors\?\?\[\]\)\.length===0&&this\.dismissedSettingsErrorsKey\.value\)this\.dismissedSettingsErrorsKey\.value=null\}\))\}/g;
const HOST_STATE_BRIDGE_PATCHED_RE =
  /,j4\(\(\)=>\{globalThis\.__incipitPublishHostState&&globalThis\.__incipitPublishHostState\(this,"signal"\)\}\)\}isOffline/;
const HOST_STATE_BRIDGE_BROKEN_RE =
  /(j4\(\(\)=>\{if\(\(this\.config\.value\?\.claudeSettings\?\.errors\?\?\[\]\)\.length===0&&this\.dismissedSettingsErrorsKey\.value\)this\.dismissedSettingsErrorsKey\.value=null\}\))\},j4\(\(\)=>\{globalThis\.__incipitPublishHostState&&globalThis\.__incipitPublishHostState\(this,"signal"\)\}\)(?=isOffline)/g;

const ENHANCE_SCRIPT_TAG_RE =
  /<script nonce="\$\{[^}]+\}" src="\$\{[^}]*enhance\.js[^}]*\}"(?: type="module")?><\/script>/g;

// Remove any previous badge IIFE from the old view/panel paths before
// reinjecting at the centralized `Z5` comm constructor.
const BADGE_STRIP_VIEW_RE =
  /(resolveWebviewView\(K,V,B\)\{let j=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(j\),)\(\(\)=>\{[\s\S]*?__cceBadge[\s\S]*?\}\)\(\),(?=K\.webview\.options=)/;
const BADGE_STRIP_PANEL_RE =
  /(setupPanel\(K,V,B,j\)\{let G=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(G\);)\(\(\)=>\{[\s\S]*?__cceBadge[\s\S]*?\}\)\(\);/;
const BADGE_REQUIRE_VIEW_RE =
  /(resolveWebviewView\(K,V,B\)\{let j=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(j\),)require\("\.\/webview\/host-badge\.cjs"\)\.attach\(K(?:,P0)?\),/;
const BADGE_REQUIRE_PANEL_RE =
  /(setupPanel\(K,V,B,j\)\{let G=\{isVisible:\(\)=>K\.visible\};this\.webviews\.add\(G\);)require\("\.\/webview\/host-badge\.cjs"\)\.attach\(K(?:,P0)?\);/;
const BADGE_COMM_ATTACH_PATTERN = /this\.webview=[A-Za-z_$][\w$]*;/g;
const BADGE_COMM_ATTACH_PATCHED_RE =
  /this\.webview=[A-Za-z_$][\w$]*;require\("\.\/webview\/host-badge\.cjs"\)\.attachComm\(this\);/;
const INCIPIT_MESSAGE_GUARD_PATTERN =
  /\.webview\.onDidReceiveMessage\(\(([A-Za-z_$][\w$]*)\)=>\{this\.output\.info\(`Received message from webview: \$\{JSON\.stringify\(\1\)\}`\),([A-Za-z_$][\w$]*)\?\.fromClient\(\1\)\},null,this\.disposables\)/g;
const INCIPIT_MESSAGE_GUARD_PATCHED_RE =
  /\.webview\.onDidReceiveMessage\(\(([A-Za-z_$][\w$]*)\)=>\{if\(\1&&\1\.__incipit===true\)return;this\.output\.info\(`Received message from webview: \$\{JSON\.stringify\(\1\)\}`\),[A-Za-z_$][\w$]*\?\.fromClient\(\1\)\},null,this\.disposables\)/g;

// Give the host's Monaco diff editor an incipit-owned theme, font, and gutter.
// Claude Code 2.1.x hard-codes both inline and expanded Edit diff editors to
// `theme:"vs-dark"` and `fontSize:12`, which makes warm-white render a dark
// Monaco island using the default editor font, and `lineNumbers:"off"`, which
// leaves inline diff rows with `--` placeholders instead of a useful gutter.
// We patch those options to use a bundled GitHub-like Monaco theme, Rec Mono
// Linear, Monaco's native line-number geometry, and a zero-width
// `lineDecorationsWidth` lane. That last option removes the 10px +/- glyph
// column Monaco keeps between the line numbers and code; with incipit's own
// diff gutter overlay, leaving the lane in place creates an uncolored seam in
// changed rows. The theme helper is installed in the generated webview preamble
// and falls back to Monaco's built-in `vs` / `vs-dark` themes if the private
// bundle shape changes.
const WEBVIEW_CONFIG_RE =
  /^\/\/ incipit webview config \(generated at apply; do not edit\)\r?\n[\s\S]*?\r?\n\r?\n/;
const INSTALL_MANIFEST_RE =
  /globalThis\.__incipitInstallManifest = Object\.freeze\([\s\S]*?\);\r?\n/;
const MONACO_DIFF_LIGHT_THEME = 'incipit-github-light';
const MONACO_DIFF_DARK_THEME = 'incipit-github-dark';
const MONACO_DIFF_THEME_FALLBACK_EXPR =
  '(globalThis.__incipitConfig&&globalThis.__incipitConfig.theme&&globalThis.__incipitConfig.theme.palette==="warm-white"?"vs":"vs-dark")';
const MONACO_DIFF_THEME_EXPR =
  `(globalThis.__incipitPickMonacoDiffTheme?globalThis.__incipitPickMonacoDiffTheme(m$):${MONACO_DIFF_THEME_FALLBACK_EXPR})`;
const MONACO_DIFF_THEME_HARDCODED_RE = /theme:"vs-dark"/g;
const MONACO_DIFF_THEME_LEGACY_PATCHED_RE =
  /theme:\(globalThis\.__incipitConfig&&globalThis\.__incipitConfig\.theme&&globalThis\.__incipitConfig\.theme\.palette==="warm-white"\?"vs":"vs-dark"\)/g;
const MONACO_DIFF_THEME_PATCHED_RE =
  /theme:\(globalThis\.__incipitPickMonacoDiffTheme\?globalThis\.__incipitPickMonacoDiffTheme\(m\$\):\(globalThis\.__incipitConfig&&globalThis\.__incipitConfig\.theme&&globalThis\.__incipitConfig\.theme\.palette==="warm-white"\?"vs":"vs-dark"\)\)/g;
const MONACO_DIFF_FONT_OPTIONS =
  'fontSize:12,fontFamily:"\'Rec Mono Linear\', Consolas, Monaco, \'Courier New\', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0"';
const MONACO_DIFF_FONT_LAYOUT_OPTIONS =
  `${MONACO_DIFF_FONT_OPTIONS},lineNumbers:"on",lineDecorationsWidth:0`;
const MONACO_DIFF_FONT_HARDCODED_RE = /fontSize:12,lineNumbers:"off"/g;
const MONACO_DIFF_FONT_LEGACY_PATCHED_RE =
  /fontSize:12,fontFamily:"'Rec Mono Linear', Consolas, Monaco, 'Courier New', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",lineNumbers:"off"/g;
const MONACO_DIFF_FONT_OLD_PATCHED_RE =
  /fontSize:12,fontFamily:"'Rec Mono Linear', Consolas, Monaco, 'Courier New', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",lineNumbers:"on"(?!,lineDecorationsWidth:0)/g;
const MONACO_DIFF_FONT_PATCHED_RE =
  /fontSize:12,fontFamily:"'Rec Mono Linear', Consolas, Monaco, 'Courier New', monospace",fontLigatures:false,fontVariations:"\\"MONO\\" 1, \\"CASL\\" 0, \\"slnt\\" 0",lineNumbers:"on",lineDecorationsWidth:0/g;
const MONACO_DIFF_WORD_WRAP_HARDCODED_RE = /wordWrap:"on",wrappingIndent:"same"/g;
const MONACO_DIFF_WORD_WRAP_PATCHED_RE = /wordWrap:"off",wrappingIndent:"same"/g;
const MONACO_DIFF_OVERVIEW_HARDCODED_RE =
  /readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!0/g;
const MONACO_DIFF_OVERVIEW_PATCHED_RE =
  /readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!1/g;
const MONACO_DIFF_OVERVIEW_INLINE_LAYOUT_PATCHED_RE =
  /readOnly:!0,renderSideBySide:!1,renderOverviewRuler:!1/g;
const MONACO_DIFF_INLINE_LAYOUT_HARDCODED_RE =
  /([\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,)renderSideBySide:!0(,renderOverviewRuler:!1,[\s\S]{0,1800}?lightbulb:\{enabled:[\w$]+\.ShowLightbulbIconMode\.Off\})/g;
const MONACO_DIFF_INLINE_LAYOUT_PATCHED_RE =
  /[\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,renderSideBySide:!1,renderOverviewRuler:!1,[\s\S]{0,1800}?lightbulb:\{enabled:[\w$]+\.ShowLightbulbIconMode\.Off\}/g;
const MONACO_DIFF_INLINE_RESIZE_HARDCODED_RE =
  /([\w$]+)\(!([\w$]+)\),([\w$]+)\.updateOptions\(\{renderSideBySide:\2\}\)/g;
const MONACO_DIFF_INLINE_RESIZE_PATCHED_RE =
  /[\w$]+\(!0\),[\w$]+\.updateOptions\(\{renderSideBySide:!1\}\)/g;
const MONACO_DIFF_MODAL_LAYOUT_HARDCODED_RE =
  /([\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,)renderSideBySide:!0(,renderOverviewRuler:!1,[\s\S]{0,1800}?scrollbar:\{vertical:"auto",horizontal:"(?:auto|hidden)"\})/g;
const MONACO_DIFF_MODAL_LAYOUT_PATCHED_RE =
  /[\w$]+\.createDiffEditor\([^,]+,\{readOnly:!0,renderSideBySide:!1,renderOverviewRuler:!1,[\s\S]{0,1800}?scrollbar:\{vertical:"auto",horizontal:"(?:auto|hidden)"\}/g;
const MONACO_DIFF_MODAL_SCROLLBAR_HARDCODED_RE =
  /scrollbar:\{vertical:"auto",horizontal:"auto"\}/g;
const MONACO_DIFF_MODAL_SCROLLBAR_LEGACY_HIDDEN_RE =
  /scrollbar:\{vertical:"auto",horizontal:"hidden"\}/g;
const MONACO_DIFF_THEMES = Object.freeze({
  [MONACO_DIFF_LIGHT_THEME]: {
    base: 'vs',
    inherit: true,
    rules: [
      // Syntax foregrounds mirror highlight.js `vs.min.css`; diff line and
      // char backgrounds below intentionally stay GitHub-like. Do not use
      // pure #ff0000 for attributes here: it collapses on removed-char red.
      { token: '', foreground: '000000' },
      // Monaco's built-in `vs` theme styles Markdown `strong` as bold and
      // `emphasis` as italic. Diff editors show source text, not rendered
      // Markdown, so reset typographic token styles to regular weight/slant.
      { token: 'strong', fontStyle: '' },
      { token: 'emphasis', fontStyle: '' },
      { token: 'bold', fontStyle: '' },
      { token: 'italic', fontStyle: '' },
      { token: 'markup.bold', fontStyle: '' },
      { token: 'markup.italic', fontStyle: '' },
      { token: 'markup.heading', fontStyle: '' },
      { token: 'heading', fontStyle: '' },
      { token: 'comment', foreground: '008000' },
      { token: 'quote', foreground: '008000' },
      { token: 'variable', foreground: '008000' },
      { token: 'variable.predefined', foreground: '008000' },
      { token: 'keyword', foreground: '0000ff' },
      { token: 'operator', foreground: '0000ff' },
      { token: 'name', foreground: '0000ff' },
      { token: 'tag', foreground: '0000ff' },
      { token: 'selector', foreground: '0000ff' },
      { token: 'constant', foreground: 'a31515' },
      { token: 'literal', foreground: 'a31515' },
      { token: 'number', foreground: 'a31515' },
      { token: 'string', foreground: 'a31515' },
      { token: 'type', foreground: 'a31515' },
      { token: 'class', foreground: 'a31515' },
      { token: 'interface', foreground: 'a31515' },
      { token: 'namespace', foreground: 'a31515' },
      { token: 'function', foreground: 'a31515' },
      { token: 'attribute.name', foreground: 'a31515' },
      { token: 'attribute.value', foreground: 'a31515' },
      { token: 'regexp', foreground: 'a31515' },
      { token: 'meta', foreground: '2b91af' },
      { token: 'delimiter', foreground: '000000' },
    ],
    colors: {
      'editor.background': '#fafaf5',
      'editor.foreground': '#1f2328',
      'editorGutter.background': '#fafaf5',
      'editorLineNumber.foreground': '#6e7781',
      'editorLineNumber.activeForeground': '#24292f',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#0969da30',
      'editor.inactiveSelectionBackground': '#0969da20',
      'editorIndentGuide.background1': '#00000000',
      'editorIndentGuide.activeBackground1': '#00000000',
      'editorWhitespace.foreground': '#6e778155',
      'diffEditor.insertedLineBackground': '#dafbe180',
      'diffEditor.removedLineBackground': '#ffebe980',
      'diffEditor.insertedTextBackground': '#aceebb99',
      'diffEditor.removedTextBackground': '#ff818266',
      'diffEditor.border': '#d0d7de',
      'diffEditor.diagonalFill': '#d0d7de33',
      'scrollbarSlider.background': '#b0b0ae80',
      'scrollbarSlider.hoverBackground': '#8a8a8880',
      'scrollbarSlider.activeBackground': '#6f6f6d99',
    },
  },
  [MONACO_DIFF_DARK_THEME]: {
    base: 'vs-dark',
    inherit: true,
    rules: [
      // Syntax foregrounds mirror highlight.js `vs2015.min.css`; diff line
      // and char backgrounds below intentionally stay GitHub-like.
      { token: '', foreground: 'dcdcdc' },
      // Monaco's built-in `vs-dark` theme styles Markdown `strong` as bold
      // and `emphasis` as italic. Diff editors show source text, not rendered
      // Markdown, so reset typographic token styles to regular weight/slant.
      { token: 'strong', fontStyle: '' },
      { token: 'emphasis', fontStyle: '' },
      { token: 'bold', fontStyle: '' },
      { token: 'italic', fontStyle: '' },
      { token: 'markup.bold', fontStyle: '' },
      { token: 'markup.italic', fontStyle: '' },
      { token: 'markup.heading', fontStyle: '' },
      { token: 'heading', fontStyle: '' },
      { token: 'comment', foreground: '57a64a' },
      { token: 'quote', foreground: '57a64a' },
      { token: 'doctag', foreground: '608b4e' },
      { token: 'keyword', foreground: '569cd6' },
      { token: 'operator', foreground: '569cd6' },
      { token: 'literal', foreground: '569cd6' },
      { token: 'name', foreground: '569cd6' },
      { token: 'symbol', foreground: '569cd6' },
      { token: 'link', foreground: '569cd6' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'type.identifier', foreground: '4ec9b0' },
      { token: 'number', foreground: 'b8d7a3' },
      { token: 'class', foreground: 'b8d7a3' },
      { token: 'interface', foreground: 'b8d7a3' },
      { token: 'namespace', foreground: 'b8d7a3' },
      { token: 'string', foreground: 'd69d85' },
      { token: 'regexp', foreground: '9a5334' },
      { token: 'tag', foreground: '9b9b9b' },
      { token: 'meta', foreground: '9b9b9b' },
      { token: 'attribute.name', foreground: '9cdcfe' },
      { token: 'attribute.value', foreground: 'd69d85' },
      { token: 'variable', foreground: 'bd63c5' },
      { token: 'variable.predefined', foreground: 'bd63c5' },
      { token: 'function', foreground: 'dcdcdc' },
      { token: 'delimiter', foreground: 'dcdcdc' },
    ],
    colors: {
      'editor.background': '#1f1f1e',
      'editor.foreground': '#e6edf3',
      'editorGutter.background': '#1f1f1e',
      'editorLineNumber.foreground': '#8b949e',
      'editorLineNumber.activeForeground': '#e6edf3',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#2f81f766',
      'editor.inactiveSelectionBackground': '#2f81f733',
      'editorIndentGuide.background1': '#00000000',
      'editorIndentGuide.activeBackground1': '#00000000',
      'editorWhitespace.foreground': '#8b949e55',
      'diffEditor.insertedLineBackground': '#23863633',
      'diffEditor.removedLineBackground': '#da363333',
      'diffEditor.insertedTextBackground': '#2ea04366',
      'diffEditor.removedTextBackground': '#f8514966',
      'diffEditor.border': '#30363d',
      'diffEditor.diagonalFill': '#30363d66',
      'scrollbarSlider.background': '#3c3c3c80',
      'scrollbarSlider.hoverBackground': '#5a5a5a80',
      'scrollbarSlider.activeBackground': '#6a6a6a99',
    },
  },
});

// Remove the legacy module-load diagnostic probe.
const LEGACY_MODLOAD_RE =
  /try\{require\('fs'\)\.appendFileSync\([^)]*MODULE LOADED[^)]*\)\}catch\(e\)\{\};/g;

// ============================================================
// platform paths
// ============================================================

function extensionRoot(home) {
  return path.join(home || os.homedir(), '.vscode', 'extensions');
}

// Default location of the host's user settings.json — used only as a
// fallback when no explicit `settingsPath` is threaded through. With the
// new multi-target system the explicit path is the norm; this default
// remains as a backstop for early callers and for the legacy
// "single host, default VS Code" detection path.
function vscodeUserSettingsPath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || home;
    return path.join(appdata, 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  // Linux, FreeBSD, and other XDG-style platforms.
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, 'Code', 'User', 'settings.json');
}

function inferSettingsPathFromExtensionsDir(extensionsDir) {
  if (!extensionsDir) return null;
  try {
    const { deriveSettingsPathFromExtensionsDir } = require('./host-detect');
    return deriveSettingsPathFromExtensionsDir(extensionsDir);
  } catch (_) {
    return null;
  }
}

function userFontDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const lad = process.env.LOCALAPPDATA || home;
    return path.join(lad, 'Microsoft', 'Windows', 'Fonts');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Fonts');
  }
  return path.join(home, '.local', 'share', 'fonts');
}

// ============================================================
// extension discovery
// ============================================================

function parseVersion(dirName) {
  const m = dirName.match(VERSION_RE);
  if (!m) return [];
  return m[1].split('.').map(x => parseInt(x, 10));
}

function compareVersionTuples(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? 0 : a[i];
    const bv = b[i] === undefined ? 0 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

function buildTarget(extensionDir, settingsPath) {
  const extensionJsPath = path.join(extensionDir, 'extension.js');
  const webviewIndexJsPath = path.join(extensionDir, 'webview', 'index.js');
  if (!fs.existsSync(extensionJsPath)) {
    throw new Error(`未找到 Claude Code 扩展入口文件:${extensionJsPath}`);
  }
  if (!fs.existsSync(webviewIndexJsPath)) {
    throw new Error(`未找到 Claude Code WebView 入口文件:${webviewIndexJsPath}`);
  }
  const v = parseVersion(path.basename(extensionDir));
  return {
    extensionDir,
    extensionJsPath,
    webviewIndexJsPath,
    enhanceJsPath: path.join(extensionDir, 'webview', ENHANCE_TARGET_NAME),
    settingsPath: settingsPath || vscodeUserSettingsPath(),
    version: v.length ? v.join('.') : 'unknown',
  };
}

// Locate the latest Claude Code extension under a given extensions root.
//
// Accepts:
//   - a string (legacy positional `home` arg): treated as the user's HOME
//     directory; extensions are looked up under `<home>/.vscode/extensions`.
//   - an object `{ extensionsDir, settingsPath, home }`: explicit
//     extensions directory takes priority; `home` is the legacy fallback.
//
// The returned target carries `settingsPath` from the supplied options
// (or the platform-default `vscodeUserSettingsPath()` if absent), which
// is then threaded into apply / backup / restore.
function findLatestClaudeCodeExtension(arg) {
  let extensionsDir = null;
  let settingsPath = null;
  let home = null;
  if (typeof arg === 'string') {
    home = arg;
  } else if (arg && typeof arg === 'object') {
    extensionsDir = arg.extensionsDir || null;
    settingsPath = arg.settingsPath || null;
    home = arg.home || null;
  }
  const root = extensionsDir || extensionRoot(home);
  if (!fs.existsSync(root)) {
    throw new Error(`未找到扩展目录:${root}`);
  }
  const names = fs.readdirSync(root)
    .filter(n => n.startsWith(CLAUDE_CODE_EXTENSION_PREFIX));
  const candidates = [];
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (fs.statSync(p).isDirectory()) candidates.push(p);
    } catch (_) {}
  }
  if (!candidates.length) {
    throw new Error('未检测到 Claude Code 扩展。');
  }
  candidates.sort((a, b) => {
    const cmp = compareVersionTuples(
      parseVersion(path.basename(a)),
      parseVersion(path.basename(b)),
    );
    if (cmp !== 0) return cmp;
    return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
  });
  const inferredSettingsPath = settingsPath || inferSettingsPathFromExtensionsDir(root);
  return buildTarget(candidates[candidates.length - 1], inferredSettingsPath);
}

// ============================================================
// asset copying
// ============================================================

function resourceFilePath(resourceRoot, relativePath) {
  const p = path.join(resourceRoot, relativePath);
  if (!fs.existsSync(p)) {
    throw new Error(`未找到内置资源文件:${p}`);
  }
  return p;
}

// Copy by content. Preserve mtime and return whether a write occurred.
//
// Fast path: if the destination already exists with the same size and mtime
// as the source, skip reading both files entirely. Previously this function
// always read both files in full on every install, which multiplied the
// hundred-plus KaTeX / hljs / font bundle files into hundreds of megabytes
// of redundant I/O on the common "nothing changed" path.
function copyIfChanged(srcPath, dstPath) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  let srcStat;
  try { srcStat = fs.statSync(srcPath); } catch { srcStat = null; }
  if (srcStat && fs.existsSync(dstPath)) {
    try {
      const dstStat = fs.statSync(dstPath);
      // Use a 1-second tolerance. Windows NTFS stores timestamps at 100ns
      // resolution but Node's `utimesSync` rounds through floating-point
      // milliseconds, and FAT32/exFAT only have 2-second granularity.
      if (dstStat.size === srcStat.size &&
          Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1000) {
        return false;
      }
    } catch { /* fall through to byte compare */ }
  }
  const srcBytes = fs.readFileSync(srcPath);
  if (fs.existsSync(dstPath)) {
    try {
      const dstBytes = fs.readFileSync(dstPath);
      if (dstBytes.equals(srcBytes)) {
        // Content identical but stat differs — refresh mtime so the fast
        // path catches it next run.
        if (srcStat) {
          try { fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime); } catch (_) {}
        }
        return false;
      }
    } catch { /* fall through to write */ }
  }
  fs.writeFileSync(dstPath, srcBytes);
  if (srcStat) {
    try { fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime); } catch (_) {}
  }
  return true;
}

// Copy with a text transform. Used for enhance.js (prepends a frozen
// `globalThis.__incipitConfig` preamble) and theme.css (appends a `:root`
// block carrying the body font-size). Transforms are pure functions of
// source content + user config, so destination equality with the
// transformed string is a perfect idempotency check.
function copyWithTransform(srcPath, dstPath, transform) {
  const srcContent = fs.readFileSync(srcPath, 'utf8');
  const transformed = transform(srcContent);
  if (fs.existsSync(dstPath)) {
    try {
      const existing = fs.readFileSync(dstPath, 'utf8');
      if (existing === transformed) return false;
    } catch (_) { /* fall through to write */ }
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, transformed, 'utf8');
  return true;
}

function normalizeConfigLanguage(language) {
  return language === 'zh' ? 'zh' : 'en';
}

function buildIncipitConfigJSON(features, theme, language) {
  return JSON.stringify({
    features,
    theme: theme || {},
    language: normalizeConfigLanguage(language),
  });
}

function buildEnhancePreamble(features, theme, language) {
  // `theme` may be undefined for legacy callers that haven't been updated;
  // enhance.js reads `palette` defensively so missing fields fall back to
  // the dark default. Bundling theme into the same frozen config object
  // keeps a single read site in the webview.
  const json = buildIncipitConfigJSON(features, theme, language);
  return '// incipit user config (generated at apply; do not edit)\n' +
         `globalThis.__incipitConfig = Object.freeze(${json});\n\n`;
}

function buildHostStateBridgePreamble() {
  return [
    'globalThis.__incipitPublishHostState=function(session,reason){try{',
    'if(!session)return;',
    'var read=function(sig){try{return sig&&typeof sig==="object"&&"value"in sig?sig.value:void 0}catch(_){return void 0}};',
    'var messages=read(session.messages);',
    'var sessionId=read(session.sessionId)||null;',
    'var busy=read(session.busy)===true;',
    'var pendingInput=read(session.pendingInput)===true;',
    'var cwd=read(session.cwd)||null;',
    'var summary=read(session.summary)||null;',
    'var next={source:"semantic-bridge",reason:reason||"signal",sessionId:sessionId,sessionID:sessionId,busy:busy,pendingInput:pendingInput,cwd:cwd,summary:summary,messagesVersion:Array.isArray(messages)?messages.length:0,updatedAt:Date.now()};',
    'var prev=globalThis.__incipitHostState;',
    'globalThis.__incipitHostState=next;',
    'if(!prev||prev.sessionId!==next.sessionId||prev.busy!==next.busy||prev.messagesVersion!==next.messagesVersion||prev.cwd!==next.cwd){',
    'try{window.dispatchEvent(new CustomEvent("incipit:hostState",{detail:next}))}catch(_){}',
    '}',
    '}catch(_){}};\n',
  ].join('');
}

function buildWebviewConfigPreamble(features, theme, language, installContracts = []) {
  // Unlike enhance.js, the host bundle can create Monaco diff editors before
  // our dynamic import has finished. Put the same config at the top of
  // webview/index.js so the patched `createDiffEditor({ theme: ... })` sees
  // the palette synchronously during first render. The Monaco theme helper is
  // also defined here because the `m$` Monaco editor namespace is local to the
  // host bundle; the patched `theme:` option passes it in lazily.
  const json = buildIncipitConfigJSON(features, theme, language);
  const diffThemes = JSON.stringify(MONACO_DIFF_THEMES);
  return '// incipit webview config (generated at apply; do not edit)\n' +
         `globalThis.__incipitConfig = Object.freeze(${json});\n` +
         buildInstallManifestPreamble(installContracts) +
         `globalThis.__incipitMonacoDiffThemes = Object.freeze(${diffThemes});\n` +
         '(function(){try{var raw=globalThis.acquireVsCodeApi;if(typeof raw==="function"&&!globalThis.__incipitGetVsCodeApi){var cached=null;globalThis.__incipitGetVsCodeApi=function(){if(cached)return cached;cached=raw();return cached;};globalThis.acquireVsCodeApi=function(){return globalThis.__incipitGetVsCodeApi();};}}catch(_){}})();\n' +
         buildHostStateBridgePreamble() +
         'globalThis.__incipitEnsureMonacoDiffTheme = function(monaco){try{if(!monaco||typeof monaco.defineTheme!=="function")return false;if(globalThis.__incipitMonacoDiffThemesReady)return true;var themes=globalThis.__incipitMonacoDiffThemes||{};for(var name in themes)if(Object.prototype.hasOwnProperty.call(themes,name))monaco.defineTheme(name,themes[name]);globalThis.__incipitMonacoDiffThemesReady=true;if(!globalThis.__incipitMonacoDiffFontsReady&&typeof document!=="undefined"&&document.fonts&&document.fonts.ready){globalThis.__incipitMonacoDiffFontsReady=true;document.fonts.ready.then(function(){try{if(monaco&&typeof monaco.remeasureFonts==="function")monaco.remeasureFonts();}catch(_){}});}return true;}catch(e){try{console.warn("[incipit] Monaco diff theme setup failed",e);}catch(_){}return false;}};\n' +
         `globalThis.__incipitPickMonacoDiffTheme = function(monaco){var light=globalThis.__incipitConfig&&globalThis.__incipitConfig.theme&&globalThis.__incipitConfig.theme.palette==="warm-white";var ok=globalThis.__incipitEnsureMonacoDiffTheme&&globalThis.__incipitEnsureMonacoDiffTheme(monaco);return ok?(light?"${MONACO_DIFF_LIGHT_THEME}":"${MONACO_DIFF_DARK_THEME}"):(light?"vs":"vs-dark");};\n\n`;
}

function buildThemeOverrideBlock(theme) {
  const rawBody = theme.bodyFontFamily && theme.bodyFontFamily.css;
  const rawCode = theme.codeFontFamily && theme.codeFontFamily.css;
  const bodyFont = sanitizeFontFamilyValue(rawBody)
    || "'ReadingHei', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif";
  const codeFont = sanitizeFontFamilyValue(rawCode)
    || "'Rec Mono Linear', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace";
  // Emphasis (bold/heading) + warm-white bodyBold face follow the body
  // preset so a gothic body never gets kai bold runs. Only emitted for
  // presets that carry a face (config's BODY_FONT_FACE_BY_KEY); for a
  // custom body font these stay unset and theme.css's static `Emphasis`
  // / `PaperReading` defaults hold, matching pre-preset behaviour.
  const emphasisFont = sanitizeFontFamilyValue(
    theme.bodyFontFamily && theme.bodyFontFamily.emphasisCss);
  const paperFace = sanitizeFontFamilyValue(
    theme.bodyFontFamily && theme.bodyFontFamily.paperFace);
  return '\n\n/* incipit user theme overrides (generated at apply; do not edit) */\n' +
         ':root {\n' +
         `  --incipit-body-size: ${theme.bodyFontSize}px;\n` +
         `  --incipit-body-font: ${bodyFont};\n` +
         (emphasisFont ? `  --incipit-emphasis-font: ${emphasisFont};\n` : '') +
         (paperFace ? `  --incipit-paper-reading-font: ${paperFace};\n` : '') +
         `  --incipit-code-font: ${codeFont};\n` +
         '}\n';
}

// Recursively list all files relative to `root`.
function walkFiles(root) {
  const out = [];
  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.push(r);
    }
  }
  walk(root, '');
  return out;
}

function syncAssetTree(sourceRoot, targetRoot) {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`未找到内置资源目录:${sourceRoot}`);
  }
  const rels = walkFiles(sourceRoot);
  const wanted = new Set(rels.map(rel => rel.split(path.sep).join('/')));
  let written = 0;
  for (const rel of rels) {
    const src = path.join(sourceRoot, rel);
    const dst = path.join(targetRoot, rel);
    if (copyIfChanged(src, dst)) written++;
  }
  // Prune any file under `targetRoot` that is no longer in the source set.
  // This is how we cleanly remove bundle files that past versions shipped
  // but the current release does not (e.g. `tex-svg-full.js` after we
  // switched to `tex-chtml-full.js`).
  if (fs.existsSync(targetRoot)) {
    const existing = walkFiles(targetRoot);
    for (const rel of existing) {
      const key = rel.split(path.sep).join('/');
      if (!wanted.has(key)) {
        try { fs.unlinkSync(path.join(targetRoot, rel)); } catch { /* best-effort */ }
      }
    }
    pruneEmptyDirs(targetRoot);
  }
  return [written, rels.length];
}

function pruneEmptyDirs(root) {
  if (!fs.existsSync(root)) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = path.join(root, entry.name);
      pruneEmptyDirs(child);
      try {
        if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
      } catch { /* best-effort */ }
    }
  }
}

// ============================================================
// system font installation
// ============================================================

// Left-pad status labels to a shared width. Treat common CJK glyphs as double width.
function padLabel(label, width = 16) {
  let w = 0;
  for (const ch of label) {
    // Count BMP CJK blocks and common full-width punctuation as double width.
    const c = ch.codePointAt(0);
    if (
      (c >= 0x1100 && c <= 0x115F) ||
      (c >= 0x2E80 && c <= 0x9FFF) ||
      (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xF900 && c <= 0xFAFF) ||
      (c >= 0xFE30 && c <= 0xFE4F) ||
      (c >= 0xFF00 && c <= 0xFF60) ||
      (c >= 0xFFE0 && c <= 0xFFE6)
    ) w += 2;
    else w += 1;
  }
  if (w >= width) return label;
  return label + ' '.repeat(width - w);
}

function installSerifSystemFonts(resourceRoot) {
  const fontDir = userFontDir();
  try {
    fs.mkdirSync(fontDir, { recursive: true });
  } catch (_) {
    return 0;
  }

  let written = 0;
  const installedPaths = [];
  for (const [fileName, subdir, displayName] of SYSTEM_FONT_FILES) {
    const src = path.join(resourceRoot, 'data', 'system-fonts', subdir, fileName);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(fontDir, fileName);
    const srcBytes = fs.readFileSync(src);
    let same = false;
    if (fs.existsSync(dst)) {
      try {
        same = fs.readFileSync(dst).equals(srcBytes);
      } catch (_) {}
    }
    if (!same) {
      fs.writeFileSync(dst, srcBytes);
      written++;
    }
    installedPaths.push([displayName, dst]);

    // Register fonts under `HKCU\...\Fonts` so admin rights are not required.
    if (process.platform === 'win32') {
      try {
        cp.execFileSync(
          'reg',
          [
            'add',
            'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
            '/v', displayName,
            '/t', 'REG_SZ',
            '/d', dst,
            '/f',
          ],
          { stdio: 'ignore' },
        );
      } catch (_) {}
    }
  }

  // Refresh the Linux font cache when `fc-cache` is available.
  if (process.platform === 'linux' && written > 0) {
    try {
      cp.execFileSync('fc-cache', ['-f', fontDir], { stdio: 'ignore' });
    } catch (_) {
      // Missing `fc-cache` is acceptable. Most desktop environments will
      // rescan `~/.local/share/fonts/` later.
    }
  }

  // macOS does not require an explicit refresh.

  return written;
}

// ============================================================
// `extension.js` / `webview/index.js` patching
// ============================================================

function patchRequiredPattern(content, { pattern, alreadyPattern, label, replacementSuffix }) {
  if (pattern.test(content)) {
    const updated = content.replace(pattern, m => m + replacementSuffix);
    return [updated, `${padLabel(label)}: 已写入`];
  }
  if (alreadyPattern.test(content)) {
    return [content, `${padLabel(label)}: 已存在`];
  }
  throw new Error(`Claude Code 扩展结构已变化,未找到 ${label} 的可补丁位置。`);
}

function patchUniqueReplace(content, { pattern, alreadyPattern, label, replace }) {
  if (alreadyPattern.test(content)) {
    return [content, `${padLabel(label)}: 已存在`];
  }
  const matches = content.match(pattern) || [];
  if (matches.length !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 ${label} 可补丁位置。`);
  }
  const updated = replace(content);
  return [updated, `${padLabel(label)}: 已写入`];
}

function requirePatchContract(ok, label, detail = '') {
  if (ok) return;
  const suffix = detail ? ` (${detail})` : '';
  throw new Error(`Claude Code 扩展补丁契约失败: ${label}${suffix}`);
}

function requireHighRiskContract(contract, label) {
  if (!contract || contract.status === 'patched' || contract.status === 'preExisting' || contract.status === 'upstreamSafe') {
    return;
  }
  const reason = contract.contractReason || contract.anchorReason || contract.status || 'unknown';
  throw new Error(`Claude Code 扩展高风险接触面契约失败: ${label} (${reason})`);
}

function pushInstallContract(contracts, name, line, detail = null) {
  if (!Array.isArray(contracts)) return line;
  const extra = detail && typeof detail === 'object' ? detail : {};
  const payload = {
    name,
    line,
  };
  if (Object.keys(extra).length) payload.detail = extra;
  contracts.push(patchContract(payload));
  return line;
}

function installContractFromAssessment(name, line, assessment) {
  return patchContract({
    name,
    line,
    status: assessment.status,
    priority: assessment.priority || 'normal',
    anchorReason: assessment.anchorReason,
    contractReason: assessment.contractReason,
    fingerprint: assessment.fingerprint,
    detail: assessment.detail || null,
  });
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function shortSha(sha) {
  return String(sha || '').slice(0, 16);
}

function testRegexOnce(regex, text) {
  regex.lastIndex = 0;
  const ok = regex.test(text);
  regex.lastIndex = 0;
  return ok;
}

function hostRouteLooksAlreadyPatched(extensionText, webviewText) {
  const extensionPatched = (
    testRegexOnce(STYLE_CSP_PATCHED_RE, extensionText) ||
    testRegexOnce(SCRIPT_CSP_PATCHED_RE, extensionText) ||
    testRegexOnce(FONT_CSP_PATCHED_RE, extensionText) ||
    testRegexOnce(BADGE_COMM_ATTACH_PATCHED_RE, extensionText) ||
    testRegexOnce(INCIPIT_MESSAGE_GUARD_PATCHED_RE, extensionText)
  );
  const webviewPatched = (
    testRegexOnce(WEBVIEW_CONFIG_RE, webviewText) ||
    testRegexOnce(INSTALL_MANIFEST_RE, webviewText) ||
    testRegexOnce(DYNAMIC_IMPORT_RE, webviewText) ||
    testRegexOnce(STREAM_UNHANDLED_CASE_PATCHED_RE, webviewText) ||
    testRegexOnce(HOST_STATE_BRIDGE_PATCHED_RE, webviewText)
  );
  return extensionPatched || webviewPatched;
}

function buildHostRouteContract(target, extensionText, webviewText) {
  const version = String(target && target.version || 'unknown');
  const extensionSha256 = sha256Text(extensionText);
  const webviewSha256 = sha256Text(webviewText);
  const route = HOST_CONTACT_ROUTE_CATALOG.find(item =>
    item.version === version &&
    item.extensionSha256 === extensionSha256 &&
    item.webviewSha256 === webviewSha256
  );
  const alreadyPatched = !route && hostRouteLooksAlreadyPatched(extensionText, webviewText);
  return patchContract({
    name: 'install.hostRoute',
    status: route ? 'patched' : (alreadyPatched ? 'preExisting' : 'degraded'),
    priority: 'normal',
    anchorReason: route
      ? 'known-version-content'
      : (alreadyPatched ? 'already-patched-content' : 'unknown-version-or-content'),
    contractReason: 'semantic-contracts-required',
    fingerprint: {
      schema: HOST_CONTACT_ROUTE_SCHEMA,
      version,
      extensionSha256: shortSha(extensionSha256),
      webviewSha256: shortSha(webviewSha256),
      knownRoutes: HOST_CONTACT_ROUTE_CATALOG.length,
      alreadyPatched,
    },
  });
}

function renderHostRouteStatus(contract) {
  const status = contract && contract.status;
  let text = 'ok';
  if (status === 'preExisting') text = '已存在';
  else if (status === 'degraded') text = '降级 (未知版本/内容指纹)';
  else if (status === 'failed') text = '失败';
  return `${padLabel('宿主版本路由')}: ${text}`;
}

function stripWebviewGeneratedPreamble(content) {
  return String(content || '')
    .replace(WEBVIEW_CONFIG_RE, '')
    .replace(INSTALL_MANIFEST_RE, '');
}

function literalCount(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(needle, index);
    if (index < 0) return count;
    count++;
    index += needle.length;
  }
}

function findMatchingBrace(source, openIndex) {
  if (openIndex < 0 || source[openIndex] !== '{') return -1;
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractSwitchBody(content, switchIndex) {
  if (switchIndex < 0) return null;
  const open = content.indexOf('{', switchIndex);
  const close = findMatchingBrace(content, open);
  if (open < 0 || close < 0) return null;
  return content.slice(open + 1, close);
}

function hasTopLevelDefaultCase(switchBody) {
  if (!switchBody) return false;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < switchBody.length; i += 1) {
    const ch = switchBody[i];
    const next = switchBody[i + 1];
    if (quote) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = switchBody.indexOf('\n', i + 2);
      if (end < 0) return false;
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = switchBody.indexOf('*/', i + 2);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && switchBody.startsWith('default:', i)) return true;
  }
  return false;
}

function switchHasCases(switchBody, cases) {
  return Boolean(switchBody) && cases.every(item => switchBody.includes(`case"${item}"`));
}

function streamSwitchesIgnoreUnknownCases(content) {
  const eventStart = content.indexOf('processStreamEvent(');
  const eventSwitch = eventStart < 0 ? -1 : content.indexOf('switch(', eventStart);
  const eventBody = extractSwitchBody(content, eventSwitch);
  const eventOk = switchHasCases(eventBody, [
    'message_start',
    'message_delta',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_stop',
  ]) && !hasTopLevelDefaultCase(eventBody);

  const deltaMatch = STREAM_DELTA_SWITCH_PATTERN.exec(content);
  STREAM_DELTA_SWITCH_PATTERN.lastIndex = 0;
  const deltaBody = deltaMatch ? extractSwitchBody(content, content.indexOf('switch(', deltaMatch.index)) : null;
  const deltaOk = switchHasCases(deltaBody, [
    'text_delta',
    'citations_delta',
    'input_json_delta',
    'thinking_delta',
    'signature_delta',
    'compaction_delta',
  ]) && !hasTopLevelDefaultCase(deltaBody);

  return eventOk && deltaOk;
}

function streamUnhandledCaseIsSafe(content) {
  if (STREAM_UNHANDLED_CASE_PATCHED_RE.test(content)) return true;
  const unsafeHelpers = content.match(STREAM_UNHANDLED_CASE_PATTERN) || [];
  if (unsafeHelpers.length > 0) return false;
  return streamSwitchesIgnoreUnknownCases(content);
}

function assessStreamUnhandledCaseContact(content) {
  const patched = STREAM_UNHANDLED_CASE_PATCHED_RE.test(content);
  const unsafeHelperCount = (content.match(STREAM_UNHANDLED_CASE_PATTERN) || []).length;
  const semanticSwitchSafe = streamSwitchesIgnoreUnknownCases(content);
  const contractSafe = streamUnhandledCaseIsSafe(content);
  let anchorReason;
  if (patched) anchorReason = 'patched-helper';
  else if (unsafeHelperCount === 1) anchorReason = 'throw-helper-anchor';
  else if (unsafeHelperCount === 0 && semanticSwitchSafe) anchorReason = 'upstream-safe-switch';
  else if (unsafeHelperCount === 0) anchorReason = 'stream-switch-shape-miss';
  else anchorReason = 'ambiguous-throw-helper';
  let status = 'failed';
  if (contractSafe) status = semanticSwitchSafe && !patched ? 'upstreamSafe' : 'patched';
  return {
    status,
    priority: 'high',
    anchorReason,
    contractReason: contractSafe ? 'unknown-stream-cases-tolerated' : 'unknown-stream-cases-throw',
    fingerprint: {
      unsafeHelperCount,
      semanticSwitchSafe,
      patched,
    },
  };
}

function hostStateBridgeBusinessFingerprint(content) {
  const tokens = [
    'loadFromServer',
    'launchClaude',
    'session_states_update',
    'dismissedSettingsErrorsKey',
    'isOffline',
  ];
  const hits = {};
  for (const token of tokens) hits[token] = content.includes(token);
  return hits;
}

function assessHostStateBridgeContact(content) {
  const fingerprint = hostStateBridgeBusinessFingerprint(content);
  const businessOk = Object.values(fingerprint).every(Boolean);
  const patched = HOST_STATE_BRIDGE_PATCHED_RE.test(content);
  const brokenCount = (content.match(HOST_STATE_BRIDGE_BROKEN_RE) || []).length;
  const secondaryAnchorCount = (content.match(HOST_STATE_BRIDGE_PATTERN) || []).length;
  let anchorReason;
  if (!businessOk) anchorReason = 'session-state-business-fingerprint-miss';
  else if (patched) anchorReason = 'patched-semantic-bridge';
  else if (brokenCount === 1) anchorReason = 'repairable-broken-bridge-anchor';
  else if (secondaryAnchorCount === 1) anchorReason = 'signal-subscription-anchor';
  else anchorReason = 'signal-subscription-anchor-miss';
  const contractOk = businessOk && patched;
  return {
    status: contractOk ? 'patched' : 'failed',
    priority: 'high',
    anchorReason,
    contractReason: contractOk ? 'semantic-bridge-publishes-host-state' : 'semantic-bridge-contract-miss',
    fingerprint: {
      ...fingerprint,
      brokenCount,
      secondaryAnchorCount,
      patched,
    },
  };
}

function patchExtensionJs(content) {
  let updated = content;
  const statusLines = [];
  const contracts = [];
  const record = (name, line, detail = null) =>
    pushInstallContract(contracts, name, line, detail);

  // Remove any legacy `<script src="enhance.js">` injection residue.
  const legacyCount = (updated.match(ENHANCE_SCRIPT_TAG_RE) || []).length;
  updated = updated.replace(ENHANCE_SCRIPT_TAG_RE, '');
  statusLines.push(
    legacyCount > 0
      ? `${padLabel('旧脚本注入清理')}: 已移除`
      : `${padLabel('旧脚本注入清理')}: 未发现`,
  );

  // Extend `style-src`, `script-src`, and `font-src` with `cdnjs`.
  let status;
  [updated, status] = patchRequiredPattern(updated, {
    pattern: STYLE_CSP_PATTERN,
    alreadyPattern: STYLE_CSP_PATCHED_RE,
    label: 'style-src',
    replacementSuffix: ` ${CDN_HOST}`,
  });
  statusLines.push(record('install.extensionCsp.style', status));

  [updated, status] = patchRequiredPattern(updated, {
    pattern: SCRIPT_CSP_PATTERN,
    alreadyPattern: SCRIPT_CSP_PATCHED_RE,
    label: 'script-src',
    replacementSuffix: ` ${CDN_HOST}`,
  });
  statusLines.push(record('install.extensionCsp.script', status));

  [updated, status] = patchRequiredPattern(updated, {
    pattern: FONT_CSP_PATTERN,
    alreadyPattern: FONT_CSP_PATCHED_RE,
    label: 'font-src',
    replacementSuffix: ` ${CDN_HOST} data:`,
  });
  statusLines.push(record('install.extensionCsp.font', status));

  // Remove the legacy module-load diagnostic probe.
  updated = updated.replace(LEGACY_MODLOAD_RE, '');

  // Replace the cache badge IIFE on both injection paths.
  updated = updated.replace(BADGE_STRIP_VIEW_RE, '$1');
  updated = updated.replace(BADGE_STRIP_PANEL_RE, '$1');
  updated = updated.replace(BADGE_REQUIRE_VIEW_RE, '$1');
  updated = updated.replace(BADGE_REQUIRE_PANEL_RE, '$1');
  let statusBadge;
  [updated, statusBadge] = patchUniqueReplace(updated, {
    pattern: BADGE_COMM_ATTACH_PATTERN,
    alreadyPattern: BADGE_COMM_ATTACH_PATCHED_RE,
    label: '徽章注入(comm)',
    replace(text) {
      return text.replace(
        /this\.webview=([A-Za-z_$][\w$]*);/,
        match => match + HOST_BADGE_COMM_ATTACH,
      );
    },
  });
  statusLines.push(record('install.hostBadgeCommAttach', statusBadge));

  const guardedMessages = (updated.match(INCIPIT_MESSAGE_GUARD_PATCHED_RE) || []).length;
  const unguardedMessages = (updated.match(INCIPIT_MESSAGE_GUARD_PATTERN) || []).length;
  let privateMessageStatus;
  if (unguardedMessages > 0) {
    updated = updated.replace(
      INCIPIT_MESSAGE_GUARD_PATTERN,
      (match, message) => match.replace(`=>{this.output.info`, `=>{if(${message}&&${message}.__incipit===true)return;this.output.info`),
    );
    privateMessageStatus = `${padLabel('私有消息过滤')}: 已写入 (${unguardedMessages})`;
  } else if (guardedMessages > 0) {
    privateMessageStatus = `${padLabel('私有消息过滤')}: 已存在 (${guardedMessages})`;
  } else {
    throw new Error(`Claude Code 扩展结构已变化,未找到 私有消息过滤 的可补丁位置。`);
  }
  statusLines.push(record('install.privateMessageGuard', privateMessageStatus));

  let statusAtMention;
  [updated, statusAtMention] = patchAtMentionCommand(updated);
  statusLines.push(record('install.atMentionCommand', statusAtMention));
  let statusVisibleCommand;
  [updated, statusVisibleCommand] = patchClaudeVisibleCommand(updated);
  statusLines.push(record('install.claudeVisibleCommand', statusVisibleCommand));

  assertExtensionPatchContracts(updated);
  statusLines.push(record('install.extensionContract', `${padLabel('extension 契约')}: ok`));

  return [updated, statusLines, contracts];
}

// Render-blocking CSS at HTML-template level.
//
// Without this, theme.css is only injected after `enhance.js` finishes
// importing and runs `injectStyles()`. By that time the host has already
// painted with its own default theme, producing a 100 ms – 1.5 s flash
// of host-default styling on every webview open. Patching the HTML
// template adds head links that load in parallel with the host's
// own `index.css`, so the very first paint already wears incipit's
// colours.
//
// Anchor: the host template contains exactly one stylesheet link for
// `webview/index.css`, rendered as:
//   <link href="${X}" rel="stylesheet">
// where `X` is the minified variable that already points at the webview URI.
// We append our own links right after it and derive their hrefs from that
// captured expression. The important invariant is the HTML/resource shape,
// not the variable name: Claude Code 2.1.133 used `${H}`, while 2.1.138
// moved the visible link to `${L}` after splitting raw Uri and webview Uri.
//
// Strip-and-reinject pattern: a prior apply may have written one
// palette's links; if the user later switched palette and re-runs apply,
// we strip any prior `*.toString().replace(...)` link block back to the
// bare anchor before injecting the active palette's set. Idempotent
// when the active palette already matches.
function patchExtensionHtmlHead(content, theme) {
  const palette = (theme && theme.palette) === 'warm-white' ? 'warm-white' : 'warm-black';
  const wantWarmWhite = palette === 'warm-white';

  // Match the host stylesheet anchor by shape, but capture its actual
  // minified href variable instead of assuming a stable name.
  const ANCHOR_RE = /<link href="\$\{([A-Za-z_$][\w$]*)\}" rel="stylesheet">/g;
  // Match anchor + 1..N of our own injected links. Current links carry stable
  // ids; older in-flight builds are still stripped by the `toString().replace`
  // marker so palette switching remains idempotent.
  const STRIP_RE =
    /(<link href="\$\{[A-Za-z_$][\w$]*\}" rel="stylesheet">)(?:<link [^>]*(?:claude-enhance-styles-link|incipit-warm-white-link|\.toString\(\)\.replace\(\/index\\\.css)[^>]*>)+/g;
  // If the host stylesheet anchor drifts again, `HTML head 提速` should
  // degrade to runtime CSS injection instead of aborting the whole install.
  // Remove any old incipit head links by id/marker first so `enhance.js` can
  // safely append fresh links after the webview boots.
  const ORPHAN_INCIPIT_LINK_RE =
    /<link [^>]*(?:id="(?:claude-enhance-styles-link|incipit-warm-white-link)"|\.toString\(\)\.replace\(\/index\\\.css[^>]*(?:theme\.css|warm-white-override\.css))[^>]*>/g;

  // The replace regexes anchor to end-of-string (with optional `?` /
  // `#`) so we only match the filename segment, never a parent path
  // that happens to contain the literal "index.css".
  // Reuse the same ids that `enhance.js > injectStyles()` checks. Without
  // these ids, the first-paint head links work, but enhance.js later appends a
  // duplicate copy of the same stylesheet, forcing an avoidable CSS parse /
  // cascade pass right in the boot window.
  function stylesheetLink(id, hrefVar, fileName) {
    return '<link id="' + id + '" href="${' +
      hrefVar + ".toString().replace(/index\\.css(?=$|[?#])/,'" +
      fileName + '\')}" rel="stylesheet">';
  }
  // NOTE — `modulepreload` was tried as a third hint to start fetching
  // enhance.js in parallel with index.js, but webview CSP is
  // `script-src 'nonce-${D}' https://cdnjs.cloudflare.com` (no 'self'),
  // so a `<link rel="modulepreload">` without a nonce is blocked by
  // CSP. Chromium then poisons the module cache for that URL, and the
  // subsequent dynamic `import('./enhance.js')` from inside index.js
  // also fails — enhance.js never runs, host_probe never sets
  // `data-incipit-*` attributes, and theme.css's selectors fail to
  // match, leaving the page looking like the host default. Do not
  // re-add modulepreload here unless we also write the per-request
  // nonce into the link tag (currently we have no clean way to thread
  // `${D}` into the patched fragment without more parser surgery).

  // Always strip-and-reinject. Using `content.includes(desired)` as
  // the "already" check was wrong because `desired` could be a prefix
  // of the actual patched block (e.g., a previous apply added an
  // extra link after `desired`); `includes` would return true and
  // the stale extra link would be left in place. Strip first, then
  // compare the stripped text to "what would be patched fresh" — if
  // they're equivalent we report 已存在 without writing.
  const stripped = content
    .replace(STRIP_RE, '$1')
    .replace(ORPHAN_INCIPIT_LINK_RE, '');
  const baseMatches = Array.from(stripped.matchAll(ANCHOR_RE));
  if (baseMatches.length !== 1) {
    const status = stripped === content ? '已跳过' : '已清理并跳过';
    return [
      stripped,
      `${padLabel('HTML head 提速')}: ${status} (anchor ${baseMatches.length}; runtime CSS fallback)`,
    ];
  }

  const anchor = baseMatches[0][0];
  const hrefVar = baseMatches[0][1];
  const themeLink = stylesheetLink('claude-enhance-styles-link', hrefVar, 'theme.css');
  const wwLink = wantWarmWhite
    ? stylesheetLink('incipit-warm-white-link', hrefVar, 'warm-white-override.css')
    : '';
  const desired = anchor + themeLink + wwLink;

  const updated = stripped.replace(anchor, desired);
  if (updated === content) {
    return [content, `${padLabel('HTML head 提速')}: 已存在 (${palette})`];
  }
  return [updated, `${padLabel('HTML head 提速')}: 已写入 (${palette})`];
}

function patchMarkdownChildren(content) {
  const stripped = content.replace(
    MARKDOWN_LEGACY_CHILDREN_RE,
    '$1=$.children||""',
  );
  return patchUniqueReplace(stripped, {
    pattern: MARKDOWN_ASSIGN_PATTERN,
    alreadyPattern: MARKDOWN_ASSIGN_PATCHED_RE,
    label: 'markdown 预处理',
    replace(text) {
      return text.replace(
        MARKDOWN_ASSIGN_PATTERN,
        'if(typeof $1==="string"){if(window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__)$1=window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__($1);$2.value=$1;}else $3("Unexpected value `"+$1+"` for `children` prop, expected `string`")',
      );
    },
  });
}

function markdownCodeComponentReplacement(childrenVar, classNameVar, reactVar, codeVar) {
  return (
    `code:({children:${childrenVar},className:${classNameVar}})=>{` +
    `let ${codeVar}=String(${childrenVar}),__incipitHtml;` +
    `if(${classNameVar}){` +
    `__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(${codeVar},${classNameVar});` +
    `if(__incipitHtml!==null&&__incipitHtml!==void 0)return ${reactVar}.default.createElement("code",{className:${classNameVar}+" hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}});` +
    `return ${reactVar}.default.createElement("code",{className:${classNameVar}},${childrenVar})` +
    `}` +
    `if(${codeVar}.indexOf("\\n")!==-1){` +
    `__incipitHtml=window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(${codeVar},"");` +
    `if(__incipitHtml!==null&&__incipitHtml!==void 0)return ${reactVar}.default.createElement("code",{className:"hljs",dangerouslySetInnerHTML:{__html:__incipitHtml}})` +
    `}`
  );
}

function patchMarkdownCodeComponent(content) {
  if (MARKDOWN_CODE_COMPONENT_PATCHED_RE.test(content)) {
    return [content, `${padLabel('markdown 代码渲染')}: 已存在`];
  }

  const legacyMatches = content.match(MARKDOWN_CODE_COMPONENT_V1_PATCHED_PATTERN) || [];
  if (legacyMatches.length === 1) {
    return [
      content.replace(
        MARKDOWN_CODE_COMPONENT_V1_PATCHED_PATTERN,
        (_match, childrenVar, classNameVar, codeVar, reactVar) =>
          markdownCodeComponentReplacement(childrenVar, classNameVar, reactVar, codeVar),
      ),
      `${padLabel('markdown 代码渲染')}: 已升级`,
    ];
  }

  const matches = content.match(MARKDOWN_CODE_COMPONENT_PATTERN) || [];
  if (matches.length !== 1) {
    return [
      content,
      `${padLabel('markdown 代码渲染')}: 降级 (未找到渲染锚点; 流式结束后高亮)`,
    ];
  }
  return [
    content.replace(
      MARKDOWN_CODE_COMPONENT_PATTERN,
      (_match, childrenVar, classNameVar, reactVar, codeVar) =>
        markdownCodeComponentReplacement(childrenVar, classNameVar, reactVar, codeVar),
    ),
    `${padLabel('markdown 代码渲染')}: 已写入`,
  ];
}

function patchAtMentionCommand(content) {
  if (AT_MENTION_COMMAND_PATCHED_RE.test(content)) {
    return [content, `${padLabel('@引用命令参数')}: 已存在`];
  }

  const legacyMatches = content.match(AT_MENTION_COMMAND_LEGACY_PATCHED_PATTERN) || [];
  if (legacyMatches.length === 1) {
    return [
      content.replace(
        AT_MENTION_COMMAND_LEGACY_PATCHED_PATTERN,
        (match, _subscriptions, emitter, webviews, vscodeApi) =>
          match.replace(
            `if(typeof __incipitMention==="string"){${emitter}.fire(__incipitMention);return}`,
            `if(typeof __incipitMention==="string"){if(!${webviews}.hasVisibleWebview())await ${vscodeApi}.commands.executeCommand("claude-vscode.editor.openLast");let __incipitFire=()=>${emitter}.fire(__incipitMention);setTimeout(__incipitFire,80);setTimeout(__incipitFire,360);return}`,
          ),
      ),
      `${padLabel('@引用命令参数')}: 已升级`,
    ];
  }

  const matches = content.match(AT_MENTION_COMMAND_PATTERN) || [];
  if (matches.length !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 @引用命令参数 可补丁位置。`);
  }
  return [
    content.replace(AT_MENTION_COMMAND_PATTERN, (match, _subscriptions, emitter, webviews, vscodeApi) =>
      match.replace('async()=>{', 'async(__incipitMention)=>{') +
      `if(typeof __incipitMention==="string"){if(!${webviews}.hasVisibleWebview())await ${vscodeApi}.commands.executeCommand("claude-vscode.editor.openLast");let __incipitFire=()=>${emitter}.fire(__incipitMention);setTimeout(__incipitFire,80);setTimeout(__incipitFire,360);return}`,
    ),
    `${padLabel('@引用命令参数')}: 已写入`,
  ];
}

function patchClaudeVisibleCommand(content) {
  if (CLAUDE_VISIBLE_COMMAND_PATCHED_RE.test(content)) {
    return [content, `${padLabel('Claude 可见状态')}: 已存在`];
  }
  const matches = content.match(CLAUDE_VISIBLE_COMMAND_PATTERN) || [];
  if (matches.length !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 Claude 可见状态 可补丁位置。`);
  }
  return [
    content.replace(
      CLAUDE_VISIBLE_COMMAND_PATTERN,
      (match, subscriptions, _emitter, webviews, vscodeApi) =>
        match.replace(
          `${subscriptions}.push(${vscodeApi}.commands.registerCommand("claude-vscode.insertAtMention"`,
          `${subscriptions}.push(${vscodeApi}.commands.registerCommand("incipit.claudeCode.hasVisibleWebview",()=>${webviews}.hasVisibleWebview())),${subscriptions}.push(${vscodeApi}.commands.registerCommand("claude-vscode.insertAtMention"`,
        ),
    ),
    `${padLabel('Claude 可见状态')}: 已写入`,
  ];
}

function patchDisableImplicitSelectionSend(content) {
  // This is not tied to the experimental editor overlay. Official implicit
  // IDE selection sending conflicts with incipit's explicit visible @file
  // references, so ordinary composer sends always use includeSelection=false.
  return patchUniqueReplace(content, {
    pattern: IMPLICIT_SELECTION_SEND_PATTERN,
    alreadyPattern: IMPLICIT_SELECTION_SEND_PATCHED_RE,
    label: '自动选区发送',
    replace(text) {
      return text.replace(
        IMPLICIT_SELECTION_SEND_PATTERN,
        'let $1=!1;$3($.selection.value,$1,',
      );
    },
  });
}

function patchStreamUnhandledCase(content) {
  if (STREAM_UNHANDLED_CASE_PATCHED_RE.test(content)) {
    const assessment = assessStreamUnhandledCaseContact(content);
    requireHighRiskContract(
      installContractFromAssessment('install.streamUnhandledCase', '', assessment),
      '未知流事件保护',
    );
    return [content, `${padLabel('未知流事件保护')}: 已存在`, assessment];
  }
  const matches = content.match(STREAM_UNHANDLED_CASE_PATTERN) || [];
  if (matches.length === 1) {
    const updated = content.replace(
        STREAM_UNHANDLED_CASE_PATTERN,
        (_match, name, value, reason) =>
          `function ${name}(${value},${reason}){try{var __incipitCase=${value}&&typeof ${value}==="object"?{type:${value}.type||null,deltaType:${value}.delta&&${value}.delta.type||null,keys:Object.keys(${value}).slice(0,12),deltaKeys:${value}.delta&&typeof ${value}.delta==="object"?Object.keys(${value}.delta).slice(0,12):[]}:${value};console.warn("[incipit] ignored unknown Claude stream case",__incipitCase,${reason})}catch(_){}}`,
    );
    const assessment = assessStreamUnhandledCaseContact(updated);
    requireHighRiskContract(
      installContractFromAssessment('install.streamUnhandledCase', '', assessment),
      '未知流事件保护',
    );
    return [updated, `${padLabel('未知流事件保护')}: 已写入`, assessment];
  }
  if (matches.length === 0 && streamSwitchesIgnoreUnknownCases(content)) {
    const assessment = assessStreamUnhandledCaseContact(content);
    requireHighRiskContract(
      installContractFromAssessment('install.streamUnhandledCase', '', assessment),
      '未知流事件保护',
    );
    return [content, `${padLabel('未知流事件保护')}: 上游已容错`, assessment];
  }
  throw new Error('Claude Code 扩展结构已变化,未知流事件处理既没有可替换的抛错 helper,也未呈现上游容错 switch。');
}

function patchHostStateSemanticBridge(content) {
  content = content.replace(
    HOST_STATE_BRIDGE_BROKEN_RE,
    '$1,j4(()=>{globalThis.__incipitPublishHostState&&globalThis.__incipitPublishHostState(this,"signal")})}',
  );
  if (HOST_STATE_BRIDGE_PATCHED_RE.test(content)) {
    const assessment = assessHostStateBridgeContact(content);
    requireHighRiskContract(
      installContractFromAssessment('install.hostStateBridge', '', assessment),
      '宿主语义桥',
    );
    return [content, `${padLabel('宿主语义桥')}: ok`, assessment];
  }
  const matches = content.match(HOST_STATE_BRIDGE_PATTERN) || [];
  if (matches.length !== 1) {
    const assessment = assessHostStateBridgeContact(content);
    requireHighRiskContract(
      installContractFromAssessment('install.hostStateBridge', '', assessment),
      '宿主语义桥',
    );
    return [content, `${padLabel('宿主语义桥')}: 降级 (将使用 fiber/DOM fallback)`, assessment];
  }
  const updated = content.replace(
      HOST_STATE_BRIDGE_PATTERN,
      '$1,j4(()=>{globalThis.__incipitPublishHostState&&globalThis.__incipitPublishHostState(this,"signal")})}',
  );
  const assessment = assessHostStateBridgeContact(updated);
  requireHighRiskContract(
    installContractFromAssessment('install.hostStateBridge', '', assessment),
    '宿主语义桥',
  );
  return [updated, `${padLabel('宿主语义桥')}: ok`, assessment];
}

function assertExtensionPatchContracts(content) {
  requirePatchContract(STYLE_CSP_PATCHED_RE.test(content), 'extension style-src allows local incipit assets');
  requirePatchContract(SCRIPT_CSP_PATCHED_RE.test(content), 'extension script-src allows local incipit assets');
  requirePatchContract(FONT_CSP_PATCHED_RE.test(content), 'extension font-src allows incipit fonts');
  requirePatchContract(BADGE_COMM_ATTACH_PATCHED_RE.test(content), 'host badge bridge attached');
  requirePatchContract(INCIPIT_MESSAGE_GUARD_PATCHED_RE.test(content), 'incipit private messages filtered');
  requirePatchContract(AT_MENTION_COMMAND_PATCHED_RE.test(content), '@ mention command accepts explicit string');
  requirePatchContract(CLAUDE_VISIBLE_COMMAND_PATCHED_RE.test(content), 'Claude visible command registered');
}

function assessWebviewPatchContracts(content) {
  requirePatchContract(MARKDOWN_ASSIGN_PATCHED_RE.test(content), 'markdown source preprocess handoff');
  requirePatchContract(IMPLICIT_SELECTION_SEND_PATCHED_RE.test(content), 'implicit IDE selection send disabled');
  requirePatchContract(streamUnhandledCaseIsSafe(content), 'unknown stream cases are guarded or upstream-tolerant');

  const highlighterCalls = literalCount(
    content,
    'window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__(',
  );
  const renderTimeOk = (
    highlighterCalls >= 2 &&
    content.includes('.indexOf("\\n")!==-1') &&
    content.includes('className:"hljs"') &&
    content.includes('+" hljs"') &&
    content.includes('dangerouslySetInnerHTML:{__html:__incipitHtml}')
  );
  return {
    renderTimeCode: renderTimeOk
      ? `${padLabel('流式代码高亮')}: ok`
      : `${padLabel('流式代码高亮')}: 降级 (流式结束后高亮)`,
    semanticBridge: HOST_STATE_BRIDGE_PATCHED_RE.test(content)
      ? `${padLabel('宿主语义桥')}: ok`
      : `${padLabel('宿主语义桥')}: 降级 (将使用 fiber/DOM fallback)`,
    webview: `${padLabel('webview 契约')}: ${renderTimeOk ? 'ok' : 'degraded'}`,
  };
}

function patchWebviewConfig(content, features, theme, language, installContracts = []) {
  const preamble = buildWebviewConfigPreamble(features, theme, language, installContracts);
  const hadPreamble = WEBVIEW_CONFIG_RE.test(content) || INSTALL_MANIFEST_RE.test(content);
  const stripped = stripWebviewGeneratedPreamble(content);
  const updated = preamble + stripped;
  if (updated === content) {
    return [content, `${padLabel('webview config')}: 已存在`];
  }
  return [
    updated,
    `${padLabel('webview config')}: ${hadPreamble ? '已更新' : '已写入'}`,
  ];
}

function patchMonacoDiffTheme(content) {
  const hardcoded = (content.match(MONACO_DIFF_THEME_HARDCODED_RE) || []).length;
  const legacyPatched = (content.match(MONACO_DIFF_THEME_LEGACY_PATCHED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_THEME_PATCHED_RE) || []).length;
  if (hardcoded === 0 && legacyPatched === 0 && patched === 2) {
    return [content, `${padLabel('diff 主题')}: 已存在`];
  }
  if (hardcoded + legacyPatched + patched !== 2) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 主题可补丁位置。`);
  }
  const updated = content
    .replace(MONACO_DIFF_THEME_HARDCODED_RE, `theme:${MONACO_DIFF_THEME_EXPR}`)
    .replace(MONACO_DIFF_THEME_LEGACY_PATCHED_RE, `theme:${MONACO_DIFF_THEME_EXPR}`);
  return [
    updated,
    `${padLabel('diff 主题')}: 已写入`,
  ];
}

function patchMonacoDiffFont(content) {
  const hardcoded = (content.match(MONACO_DIFF_FONT_HARDCODED_RE) || []).length;
  const legacyPatched = (content.match(MONACO_DIFF_FONT_LEGACY_PATCHED_RE) || []).length;
  const oldPatched = (content.match(MONACO_DIFF_FONT_OLD_PATCHED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_FONT_PATCHED_RE) || []).length;
  if (hardcoded === 0 && legacyPatched === 0 && oldPatched === 0 && patched === 2) {
    return [content, `${padLabel('diff 字体/行号')}: 已存在`];
  }
  if (hardcoded + legacyPatched + oldPatched + patched !== 2) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 字体/行号可补丁位置。`);
  }
  return [
    content
      .replace(MONACO_DIFF_FONT_HARDCODED_RE, MONACO_DIFF_FONT_LAYOUT_OPTIONS)
      .replace(MONACO_DIFF_FONT_LEGACY_PATCHED_RE, MONACO_DIFF_FONT_LAYOUT_OPTIONS)
      .replace(MONACO_DIFF_FONT_OLD_PATCHED_RE, MONACO_DIFF_FONT_LAYOUT_OPTIONS),
    `${padLabel('diff 字体/行号')}: 已写入`,
  ];
}

function patchMonacoDiffWordWrap(content) {
  const hardcoded = (content.match(MONACO_DIFF_WORD_WRAP_HARDCODED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_WORD_WRAP_PATCHED_RE) || []).length;
  if (hardcoded === 0 && patched === 2) {
    return [content, `${padLabel('diff 换行')}: 已存在`];
  }
  if (hardcoded + patched !== 2) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 换行可补丁位置。`);
  }
  return [
    content.replace(MONACO_DIFF_WORD_WRAP_HARDCODED_RE, 'wordWrap:"off",wrappingIndent:"same"'),
    `${padLabel('diff 换行')}: 已写入`,
  ];
}

function patchMonacoDiffOverview(content) {
  const hardcoded = (content.match(MONACO_DIFF_OVERVIEW_HARDCODED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_OVERVIEW_PATCHED_RE) || []).length;
  const inlineLayoutPatched = (content.match(MONACO_DIFF_OVERVIEW_INLINE_LAYOUT_PATCHED_RE) || []).length;
  // The inline diff editor already ships with `renderOverviewRuler:!1`; the
  // expanded modal is the single `!0` we migrate. Therefore the final patched
  // state has two `!1` matches for this option prefix. The inline preview may
  // later be forced into single-column mode (`renderSideBySide:!1`), so accept
  // that as one of the two overview-patched diff editors.
  if (hardcoded === 0 && patched + inlineLayoutPatched === 2) {
    return [content, `${padLabel('diff 概览条')}: 已存在`];
  }
  if (hardcoded !== 1 || patched + inlineLayoutPatched !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 概览条可补丁位置。`);
  }
  return [
    content.replace(MONACO_DIFF_OVERVIEW_HARDCODED_RE, 'readOnly:!0,renderSideBySide:!0,renderOverviewRuler:!1'),
    `${padLabel('diff 概览条')}: 已写入`,
  ];
}

function patchMonacoDiffInlineLayout(content) {
  const layoutHardcoded = (content.match(MONACO_DIFF_INLINE_LAYOUT_HARDCODED_RE) || []).length;
  const layoutPatched = (content.match(MONACO_DIFF_INLINE_LAYOUT_PATCHED_RE) || []).length;
  const resizeHardcoded = (content.match(MONACO_DIFF_INLINE_RESIZE_HARDCODED_RE) || []).length;
  const resizePatched = (content.match(MONACO_DIFF_INLINE_RESIZE_PATCHED_RE) || []).length;

  if (layoutHardcoded === 0 && layoutPatched === 1 && resizeHardcoded === 0 && resizePatched === 1) {
    return [content, `${padLabel('diff inline 布局')}: 已存在`];
  }
  if (layoutHardcoded + layoutPatched !== 1 || resizeHardcoded + resizePatched !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 inline diff 布局可补丁位置。`);
  }

  const updated = content
    .replace(
      MONACO_DIFF_INLINE_LAYOUT_HARDCODED_RE,
      '$1renderSideBySide:!1$2',
    )
    .replace(
      MONACO_DIFF_INLINE_RESIZE_HARDCODED_RE,
      '$1(!0),$3.updateOptions({renderSideBySide:!1})',
    );
  return [
    updated,
    `${padLabel('diff inline 布局')}: 已写入`,
  ];
}

function patchMonacoDiffModalLayout(content) {
  const hardcoded = (content.match(MONACO_DIFF_MODAL_LAYOUT_HARDCODED_RE) || []).length;
  const patched = (content.match(MONACO_DIFF_MODAL_LAYOUT_PATCHED_RE) || []).length;

  if (hardcoded === 0 && patched === 1) {
    return [content, `${padLabel('diff modal 布局')}: 已存在`];
  }
  if (hardcoded + patched !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 modal diff 布局可补丁位置。`);
  }
  return [
    content.replace(
      MONACO_DIFF_MODAL_LAYOUT_HARDCODED_RE,
      '$1renderSideBySide:!1$2',
    ),
    `${padLabel('diff modal 布局')}: 已写入`,
  ];
}

function patchMonacoDiffModalScrollbar(content) {
  const hardcoded = (content.match(MONACO_DIFF_MODAL_SCROLLBAR_HARDCODED_RE) || []).length;
  const legacyHidden = (content.match(MONACO_DIFF_MODAL_SCROLLBAR_LEGACY_HIDDEN_RE) || []).length;
  if (hardcoded === 1 && legacyHidden === 0) {
    return [content, `${padLabel('diff 横向滚动')}: 已存在`];
  }
  if (hardcoded === 0 && legacyHidden === 1) {
    return [
      content.replace(MONACO_DIFF_MODAL_SCROLLBAR_LEGACY_HIDDEN_RE, 'scrollbar:{vertical:"auto",horizontal:"auto"}'),
      `${padLabel('diff 横向滚动')}: 已恢复`,
    ];
  }
  if (hardcoded + legacyHidden !== 1) {
    throw new Error(`Claude Code 扩展结构已变化,未找到唯一的 diff 横向滚动可补丁位置。`);
  }
  return [content, `${padLabel('diff 横向滚动')}: 已存在`];
}

function patchWebviewIndex(content, features, theme, language, installContracts = []) {
  let updated = stripWebviewGeneratedPreamble(content);
  const statusLines = [];
  const contracts = Array.isArray(installContracts) ? installContracts.slice() : [];
  const record = (name, line, detail = null) =>
    pushInstallContract(contracts, name, line, detail);

  let markdownStatus;
  [updated, markdownStatus] = patchMarkdownChildren(updated);
  statusLines.push(record('install.markdownPreprocess', markdownStatus));

  let markdownCodeStatus;
  [updated, markdownCodeStatus] = patchMarkdownCodeComponent(updated);
  statusLines.push(record('install.markdownCodeComponent', markdownCodeStatus));

  let implicitSelectionStatus;
  [updated, implicitSelectionStatus] = patchDisableImplicitSelectionSend(updated);
  statusLines.push(record('install.implicitSelectionSend', implicitSelectionStatus));

  let streamUnhandledStatus;
  let streamUnhandledAssessment;
  [updated, streamUnhandledStatus, streamUnhandledAssessment] = patchStreamUnhandledCase(updated);
  contracts.push(installContractFromAssessment(
    'install.streamUnhandledCase',
    streamUnhandledStatus,
    streamUnhandledAssessment,
  ));
  statusLines.push(streamUnhandledStatus);

  let hostStateBridgeStatus;
  let hostStateBridgeAssessment;
  [updated, hostStateBridgeStatus, hostStateBridgeAssessment] = patchHostStateSemanticBridge(updated);
  contracts.push(installContractFromAssessment(
    'install.hostStateBridge',
    hostStateBridgeStatus,
    hostStateBridgeAssessment,
  ));
  statusLines.push(hostStateBridgeStatus);

  // Remove the legacy `acquireVsCodeApi` idempotency wrapper that earlier
  // development builds prepended to this file. Its only consumer has been
  // removed, so the line is stripped if present.
  updated = updated.replace(
    /\(function\(\)\{if\(window\.__cceApiWrap\)[\s\S]*?\}\)\(\);\n/,
    '',
  );

  let diffThemeStatus;
  [updated, diffThemeStatus] = patchMonacoDiffTheme(updated);
  statusLines.push(record('install.monacoDiff.theme', diffThemeStatus));

  let diffFontStatus;
  [updated, diffFontStatus] = patchMonacoDiffFont(updated);
  statusLines.push(record('install.monacoDiff.font', diffFontStatus));

  let diffWrapStatus;
  [updated, diffWrapStatus] = patchMonacoDiffWordWrap(updated);
  statusLines.push(record('install.monacoDiff.wordWrap', diffWrapStatus));

  let diffOverviewStatus;
  [updated, diffOverviewStatus] = patchMonacoDiffOverview(updated);
  statusLines.push(record('install.monacoDiff.overview', diffOverviewStatus));

  let diffInlineLayoutStatus;
  [updated, diffInlineLayoutStatus] = patchMonacoDiffInlineLayout(updated);
  statusLines.push(record('install.monacoDiff.inlineLayout', diffInlineLayoutStatus));

  let diffModalLayoutStatus;
  [updated, diffModalLayoutStatus] = patchMonacoDiffModalLayout(updated);
  statusLines.push(record('install.monacoDiff.modalLayout', diffModalLayoutStatus));

  let diffScrollbarStatus;
  [updated, diffScrollbarStatus] = patchMonacoDiffModalScrollbar(updated);
  statusLines.push(record('install.monacoDiff.modalScrollbar', diffScrollbarStatus));

  const contractStatus = assessWebviewPatchContracts(updated);
  statusLines.push(record('install.renderTimeCode', contractStatus.renderTimeCode));
  if (!statusLines.some(line => /宿主语义桥/.test(line || ''))) {
    statusLines.push(record('install.hostStateBridge', contractStatus.semanticBridge));
  }
  statusLines.push(record('install.webviewContract', contractStatus.webview));

  const hasDynamicImport = DYNAMIC_IMPORT_RE.test(updated);
  const hasStaticImport = STATIC_IMPORT_RE.test(updated);

  if (hasStaticImport) {
    updated = updated.replace(STATIC_IMPORT_RE, '\n');
  }

  if (hasDynamicImport) {
    statusLines.push(record('install.enhanceImport', `${padLabel('enhance.js 注入')}: 已存在`));
  } else {
    updated = updated.replace(/\s+$/, '') + '\n' + IMPORT_MARKER + '\n';
    statusLines.push(record(
      'install.enhanceImport',
      `${padLabel('enhance.js 注入')}: ${hasStaticImport ? '已替换旧版' : '已写入'}`,
    ));
  }

  const configContract = patchContract({
    name: 'install.webviewConfig',
    status: 'patched',
  });
  const [finalUpdated] = patchWebviewConfig(
    updated,
    features,
    theme,
    language,
    [configContract, ...contracts],
  );
  const hadGeneratedPreamble = WEBVIEW_CONFIG_RE.test(content) || INSTALL_MANIFEST_RE.test(content);
  const configStatus = finalUpdated === content
    ? `${padLabel('webview config')}: 已存在`
    : `${padLabel('webview config')}: ${hadGeneratedPreamble ? '已更新' : '已写入'}`;
  statusLines.unshift(configStatus);
  return [finalUpdated, statusLines, [configContract, ...contracts]];
}

// ============================================================
// main install flow
// ============================================================

function installClaudeCodeVSCodeEnhance(resourceRoot, options = {}) {
  // Caller may supply a pre-resolved `target` (from the new multi-target
  // picker flow); otherwise we fall back to legacy "find the latest
  // ~/.vscode/extensions/anthropic.claude-code-*" detection. Either path
  // produces a target that already carries `settingsPath`.
  const { home = null, target: presetTarget = null, extensionsDir = null, settingsPath = null } = options;
  const target = presetTarget || findLatestClaudeCodeExtension({ home, extensionsDir, settingsPath });
  const webviewDir = path.dirname(target.webviewIndexJsPath);

  pruneRetiredConfigKeys();
  const features = getFeatures();
  const theme = getTheme();
  const language = getLanguage() || 'en';
  // Editor overlay is opt-in + experimental. If it is requested but the
  // editor's Workbench cannot be uniquely + safely confirmed, do NOT abort
  // the whole apply: degrade — apply everything else, skip only the overlay,
  // and surface a mandatory red notice downstream. The user's saved
  // `editorSelectionOverlay` setting is left untouched.
  const overlayRequested = features.editorSelectionOverlay === true;
  const overlayPreflight = preflightWorkbenchOverlayForTarget(target, overlayRequested);
  const overlayDegraded = overlayPreflight && overlayPreflight.status === 'degraded';
  const overlayEffective = overlayRequested && !overlayDegraded;
  const enhancePreamble = buildEnhancePreamble(features, theme, language);
  const themeOverrideBlock = buildThemeOverrideBlock(theme);

  const rootResourceStatuses = [];
  const rootWebviewFiles = [];
  let enhanceScriptWritten = false;
  for (const [relativePath, targetName] of ROOT_WEBVIEW_FILES) {
    const src = resourceFilePath(resourceRoot, relativePath);
    const dst = path.join(webviewDir, targetName);
    let written;
    if (targetName === ENHANCE_TARGET_NAME) {
      written = copyWithTransform(src, dst, content => enhancePreamble + content);
    } else if (targetName === THEME_TARGET_NAME) {
      written = copyWithTransform(src, dst, content => content + themeOverrideBlock);
    } else {
      written = copyIfChanged(src, dst);
    }
    if (targetName === ENHANCE_TARGET_NAME) enhanceScriptWritten = written;
    rootWebviewFiles.push({
      name: targetName,
      path: dst,
      written,
    });
    const label = `${targetName} 复制`;
    rootResourceStatuses.push(
      written
        ? `${padLabel(label)}: 已写入`
        : `${padLabel(label)}: 已存在`,
    );
  }

  // Prune any legacy asset subtrees that earlier versions used to ship.
  let legacyAssetTreesPruned = 0;
  for (const legacy of LEGACY_ASSET_TREES) {
    const legacyDir = path.join(webviewDir, legacy);
    if (fs.existsSync(legacyDir)) {
      fs.rmSync(legacyDir, { recursive: true, force: true });
      legacyAssetTreesPruned++;
    }
  }

  // Local asset subtrees: `mathjax`, `hljs`, and `fonts`.
  let assetWrittenTotal = 0;
  let assetTotal = 0;
  const assetStatusLines = [];
  const assetTrees = [];
  for (const treeName of LOCAL_ASSET_TREES) {
    const srcTree = path.join(resourceRoot, 'data', treeName);
    const dstTree = path.join(webviewDir, treeName);
    const [written, total] = syncAssetTree(srcTree, dstTree);
    assetWrittenTotal += written;
    assetTotal += total;
    assetTrees.push({
      name: treeName,
      path: dstTree,
      written,
      total,
    });
    const label = `${treeName} 资源`;
    assetStatusLines.push(
      written === 0
        ? `${padLabel(label)}: 已存在 (${total} 个)`
        : `${padLabel(label)}: 已写入 ${written}/${total}`,
    );
  }

  const extJsOriginal = fs.readFileSync(target.extensionJsPath, 'utf8');
  const webviewOriginal = fs.readFileSync(target.webviewIndexJsPath, 'utf8');
  const hostRouteContract = buildHostRouteContract(target, extJsOriginal, webviewOriginal);

  // `extension.js`
  let [extJsUpdatedText, extStatusLines, extContracts] = patchExtensionJs(extJsOriginal);
  extContracts.unshift(hostRouteContract);
  extStatusLines.unshift(renderHostRouteStatus(hostRouteContract));
  let extJsHeadStatus;
  [extJsUpdatedText, extJsHeadStatus] = patchExtensionHtmlHead(extJsUpdatedText, theme);
  extStatusLines.push(extJsHeadStatus);
  pushInstallContract(extContracts, 'install.extensionHtmlHead', extJsHeadStatus, {
    palette: theme && theme.palette === 'warm-white' ? 'warm-white' : 'warm-black',
  });
  const extJsUpdated = extJsUpdatedText !== extJsOriginal;
  if (extJsUpdated) {
    fs.writeFileSync(target.extensionJsPath, extJsUpdatedText, 'utf8');
  }

  // `webview/index.js`
  const [webviewUpdatedText, webviewStatusLines, installContracts] = patchWebviewIndex(
    webviewOriginal,
    features,
    theme,
    language,
    extContracts,
  );
  const webviewUpdated = webviewUpdatedText !== webviewOriginal;
  if (webviewUpdated) {
    fs.writeFileSync(target.webviewIndexJsPath, webviewUpdatedText, 'utf8');
  }

  // Install the bundled serif system fonts for hosts that resolve user font
  // names outside the webview font-face scope. The chat input now follows
  // the generated webview CSS variables, so apply no longer writes
  // `chat.fontFamily` / `chat.fontSize` into the host's global settings.
  const serifWritten = installSerifSystemFonts(resourceRoot);
  const serifStatus = serifWritten > 0
    ? `已写入 ${serifWritten}/${SYSTEM_FONT_FILES.length}`
    : `已存在 (${SYSTEM_FONT_FILES.length} 个)`;

  // The editor overlay is opt-in + experimental. Per the 2026-05-16 design
  // override, NO overlay failure mode may abort the user's whole apply:
  //   - preflight unconfirmable target  -> degrade (effective=false)
  //   - any apply-time throw while it was *requested* (sha drift, command
  //     bridge shape change, missing restore point, or a throwing cleanup
  //     of some *other* incipit-patched Workbench) -> caught and degraded
  // Everything else still applies; the degrade is surfaced as a mandatory
  // red notice; the user's saved `editorSelectionOverlay` is left intact.
  // Throws while overlay is NOT requested (the disable/cleanup path) keep
  // their original fail-closed behavior — out of this override's scope.
  let workbenchOverlay;
  let overlayDegradeReason = null;
  let overlayDegradeMessage = null;
  let overlayDegradeCandidates = [];
  if (overlayDegraded) {
    overlayDegradeReason = overlayPreflight.reason || 'unknown';
    overlayDegradeMessage = overlayPreflight.message || null;
    overlayDegradeCandidates = overlayPreflight.candidates || [];
  }
  try {
    workbenchOverlay = applyWorkbenchOverlayForTarget(target, overlayEffective, theme);
  } catch (exc) {
    if (!overlayRequested) throw exc;
    workbenchOverlay = { status: 'off', enabled: false };
    if (!overlayDegraded) {
      overlayDegradeReason = 'apply-error';
      overlayDegradeMessage = exc && exc.message ? exc.message : String(exc);
    }
  }
  if (overlayRequested && (overlayDegraded || overlayDegradeReason)) {
    workbenchOverlay.status = 'degraded';
    workbenchOverlay.requested = true;
    workbenchOverlay.degradeReason = overlayDegradeReason || 'unknown';
    workbenchOverlay.degradeMessage = overlayDegradeMessage;
    workbenchOverlay.degradeCandidates = overlayDegradeCandidates;
  }

  const statusLines = [
    ...rootResourceStatuses,
    ...assetStatusLines,
    ...extStatusLines,
    ...webviewStatusLines,
    `${padLabel('编辑器浮层')}: ${workbenchOverlay.status}`,
    `${padLabel('serif 系统字体')}: ${serifStatus}`,
  ];

  return {
    target,
    enhanceScriptWritten,
    extensionJsUpdated: extJsUpdated,
    webviewIndexUpdated: webviewUpdated,
    assetFilesWritten: assetWrittenTotal,
    assetFilesTotal: assetTotal,
    serifFontsInstalled: serifWritten,
    report: {
      webviewDir,
      rootWebviewFiles,
      assetTrees,
      extensionJs: {
        path: target.extensionJsPath,
        updated: extJsUpdated,
        statusLines: extStatusLines,
      },
      webviewIndex: {
        path: target.webviewIndexJsPath,
        updated: webviewUpdated,
        statusLines: webviewStatusLines,
      },
      systemFonts: {
        written: serifWritten,
        total: SYSTEM_FONT_FILES.length,
      },
      workbenchOverlay,
      legacyAssetTreesPruned,
      installContracts,
    },
    statusLines,
    features,
    theme,
  };
}

module.exports = {
  CLAUDE_CODE_EXTENSION_PREFIX,
  ROOT_WEBVIEW_FILES,
  LOCAL_ASSET_TREES,
  LEGACY_ASSET_TREES,
  SYSTEM_FONT_FILES,
  extensionRoot,
  vscodeUserSettingsPath,
  userFontDir,
  findLatestClaudeCodeExtension,
  installClaudeCodeVSCodeEnhance,
  padLabel,
  __test: {
    patchExtensionJs,
    patchExtensionHtmlHead,
    patchWebviewIndex,
    buildHostRouteContract,
    assertExtensionPatchContracts,
    assessWebviewPatchContracts,
  },
};
