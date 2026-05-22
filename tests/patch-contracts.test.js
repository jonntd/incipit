'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { __test } = require('../src/install');
const { patchContract: makePatchContract } = require('../src/patch-contract');

const DEFAULT_FEATURES = Object.freeze({
  math: true,
  sessionUsage: true,
  editorSelectionOverlay: false,
});

const DEFAULT_THEME = Object.freeze({
  bodyFontSize: 13,
  palette: 'warm-black',
  bodyBold: false,
  bodyFontFamily: {
    key: 'plex-hei',
    css: "'ReadingHei', 'IBM Plex Serif', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif",
    emphasisCss: "'EmphasisHei', var(--incipit-body-font)",
    paperFace: "'PaperReadingHei'",
  },
  codeFontFamily: {
    key: 'rec-mono',
    css: "'Rec Mono Linear', 'Noto Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', Consolas, Monaco, 'Courier New', monospace",
  },
});

function hasContractFiles(dir) {
  return fs.existsSync(path.join(dir, 'extension.js')) &&
    fs.existsSync(path.join(dir, 'webview', 'index.js'));
}

function collectRootsUnder(start, maxDepth, out = []) {
  if (!start || !fs.existsSync(start) || maxDepth < 0) return out;
  if (hasContractFiles(start)) {
    out.push(start);
    return out;
  }
  let entries;
  try {
    entries = fs.readdirSync(start, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    collectRootsUnder(path.join(start, entry.name), maxDepth - 1, out);
  }
  return out;
}

function collectFixtureRoots() {
  const roots = [];
  const explicit = process.env.INCIPIT_CONTRACT_FIXTURE;
  if (explicit) collectRootsUnder(path.resolve(explicit), 5, roots);

  const restoreRoot = path.join(os.homedir(), '.incipit', 'official-restore-points-v1');
  collectRootsUnder(restoreRoot, 4, roots);

  const seen = new Set();
  return roots.filter(root => {
    const key = path.resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assertNoGracefulDegradation(label, lines) {
  const degraded = lines.filter(line => /降级|degraded/i.test(String(line || '')));
  assert.deepStrictEqual(degraded, [], `${label} degraded:\n${degraded.join('\n')}`);
}

function assertWebviewSemanticShape(root, patched, statusLines) {
  assert(
    statusLines.some(line => /流式代码高亮/.test(line) && /ok/.test(line)),
    `${root}: render-time code highlight contract did not report ok`,
  );
  assert(
    patched.includes('window.__INCIPIT_HIGHLIGHT_CODE_HTML__&&window.__INCIPIT_HIGHLIGHT_CODE_HTML__('),
    `${root}: render-time highlighter call missing`,
  );
  assert(
    patched.includes('.indexOf("\\n")!==-1') && patched.includes('className:"hljs"'),
    `${root}: no-language fenced code render path missing`,
  );
  assert(
    statusLines.some(line => /宿主语义桥/.test(line) && /ok/.test(line)),
    `${root}: semantic host-state bridge contract did not report ok`,
  );
  assert(
    patched.includes('globalThis.__incipitPublishHostState=function') &&
      patched.includes('new CustomEvent("incipit:hostState"') &&
      patched.includes('__incipitPublishHostState(this,"signal")'),
    `${root}: semantic host-state bridge shape missing`,
  );
  assert(
    patched.includes('let ') && patched.includes('=!1;') && /\(\$\.selection\.value,[A-Za-z_$][\w$]*,/.test(patched),
    `${root}: implicit IDE selection send does not appear disabled`,
  );
  assert(
    statusLines.some(line => /未知流事件保护/.test(line) && /(已写入|已存在|上游已容错)/.test(line)),
    `${root}: unknown stream case safety contract did not report a guarded or upstream-tolerant state`,
  );
}

function versionFromFixtureRoot(root) {
  const parts = String(root || '').split(/[\\/]+/).reverse();
  for (const part of parts) {
    const match = part.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  }
  return 'unknown';
}

function parseInstallManifest(root, patched) {
  const match = patched.match(/globalThis\.__incipitInstallManifest = Object\.freeze\((\{[^\n]*\})\);/);
  assert(match, `${root}: install manifest preamble missing`);
  const manifest = JSON.parse(match[1]);
  assert.strictEqual(manifest.schemaVersion, 1, `${root}: install manifest schema version mismatch`);
  assert(Array.isArray(manifest.entries), `${root}: install manifest entries must be an array`);
  return manifest;
}

function assertInstallManifestShape(root, patched, contracts) {
  const manifest = parseInstallManifest(root, patched);
  const names = new Set(manifest.entries.map(entry => entry.name));
  for (const name of [
    'install.extensionCsp.style',
    'install.hostBadgeCommAttach',
    'install.extensionHtmlHead',
    'install.hostRoute',
    'install.webviewConfig',
    'install.hostStateBridge',
    'install.streamUnhandledCase',
    'install.monacoDiff.theme',
    'install.renderTimeCode',
    'install.enhanceImport',
    'install.webviewContract',
  ]) {
    assert(names.has(name), `${root}: install manifest missing ${name}`);
  }
  assert(
    manifest.entries.every(entry =>
      entry.schemaVersion === 1 &&
      entry.layer === 'install' &&
      typeof entry.status === 'string' &&
      typeof entry.priority === 'string' &&
      typeof entry.anchorReason === 'string' &&
      typeof entry.contractReason === 'string'),
    `${root}: install manifest entry shape mismatch`,
  );
  const byName = new Map(manifest.entries.map(entry => [entry.name, entry]));
  const route = byName.get('install.hostRoute');
  assert(route && route.priority === 'normal' && route.fingerprint && route.fingerprint.version,
    `${root}: install.hostRoute must include normal-priority version/content fingerprints`);
  assert.strictEqual(route.status, 'patched',
    `${root}: official restore fixture must match a known version/content route`);
  for (const highRiskName of ['install.hostStateBridge', 'install.streamUnhandledCase']) {
    const entry = byName.get(highRiskName);
    assert(entry, `${root}: install manifest missing high-risk ${highRiskName}`);
    assert.strictEqual(entry.priority, 'high', `${root}: ${highRiskName} must be high priority`);
    assert(entry.fingerprint && typeof entry.fingerprint === 'object',
      `${root}: ${highRiskName} must include a double-layer fingerprint payload`);
    assert.notStrictEqual(entry.anchorReason, entry.contractReason,
      `${root}: ${highRiskName} must distinguish anchorReason from contractReason`);
  }
  assert(
    Array.isArray(contracts) && contracts.length >= manifest.entries.length,
    `${root}: patchWebviewIndex must return the structured install contracts it injected`,
  );
}

function assertRuntimeSourceContracts() {
  const hostProbe = fs.readFileSync(path.join(__dirname, '..', 'data', 'host_probe.js'), 'utf8');
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'data', 'claude_code_enhance.js'), 'utf8');
  const markdownPreprocess = fs.readFileSync(path.join(__dirname, '..', 'data', 'markdown_preprocess.js'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_shared.js'), 'utf8');
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
  const typography = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_typography.js'), 'utf8');
  const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8');
  const capability = fs.readFileSync(path.join(__dirname, '..', 'data', 'capability.js'), 'utf8');
  const fiberFingerprint = fs.readFileSync(path.join(__dirname, '..', 'data', 'capability', 'fingerprints', 'fiber.js'), 'utf8');
  const install = fs.readFileSync(path.join(__dirname, '..', 'src', 'install.js'), 'utf8');
  const patchContractSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'patch-contract.js'), 'utf8');
  const cssWithoutComments = theme.replace(/\/\*[\s\S]*?\*\//g, '');

  assert(
    capability.includes("import { reportCapability, bumpPerfCounter } from './runtime_kernel.js'") &&
      capability.includes('export function defineCapability('),
    'runtime capability layer must export defineCapability on top of runtime_kernel reportCapability/bumpPerfCounter',
  );
  assert(
    patchContractSource.includes('function patchContract(') &&
      patchContractSource.includes('function buildInstallManifestPreamble(') &&
      patchContractSource.includes('INSTALL_MANIFEST_SCHEMA = 1'),
    'Node install patch contract layer must expose a schema-versioned manifest preamble builder',
  );
  assert(
      install.includes('buildInstallManifestPreamble(installContracts)') &&
      install.includes("name: 'install.webviewConfig'") &&
      install.includes('buildHostRouteContract(target, extJsOriginal, webviewOriginal)') &&
      install.includes("installContractFromAssessment(") &&
      install.includes("'install.streamUnhandledCase'") &&
      install.includes("'install.hostStateBridge'") &&
      install.includes("name: 'install.hostRoute'") &&
      install.includes('installContracts,'),
    'installer must collect structured install contracts including hostRoute/I1/I2, inject __incipitInstallManifest, and expose them in the apply report',
  );
  assert(
    install.includes("const LOCAL_ASSET_TREES = ['katex', 'hljs', 'fonts', 'effort-brain', 'capability', 'legacy']"),
    'installer must copy capability/ and legacy/ webview asset subtrees',
  );
  assert(
    capability.includes('__incipitInstallManifest') &&
      capability.includes('publishInstallManifestCapabilities') &&
      capability.includes("reportCapability(entry.name, status") &&
      capability.includes('priority: entry.priority') &&
      capability.includes('fingerprint: safeDetail(entry.fingerprint)'),
    'webview capability layer must publish install manifest entries into the health registry',
  );
  assert(
    install.includes("[path.join('data', 'capability.js'),") &&
      install.includes("'capability.js'"),
    'installer must copy data/capability.js into the webview root assets',
  );
  assert(
    install.includes("[path.join('data', 'markdown_preprocess.js'),") &&
      bootstrap.includes("import { preprocessMarkdown } from './markdown_preprocess.js'") &&
      bootstrap.includes('raw => preprocessMarkdown(raw, { math: CFG.math })') &&
      bootstrap.includes("links: 'enabled'") &&
      markdownPreprocess.includes('export function preprocessMarkdownBareUrls') &&
      markdownPreprocess.includes('preprocessMarkdownMath(next)') &&
      markdownPreprocess.includes('fencedCodeEnd(text, i)') &&
      markdownPreprocess.includes('inlineCodeEnd(text, i)'),
    'markdown preprocess must copy the URL-boundary normalizer and run it before the optional math pass without touching code spans',
  );
  assert(
    fiberFingerprint.includes("REACT_FIBER_KEY_PREFIX = '__reactFiber'") &&
      !shared.includes('__reactFiber') &&
      !legacy.includes('__reactFiber'),
    'React fiber host key literal must live only under data/capability/fingerprints/',
  );
  assert(
    !legacy.includes('noteToolFoldProbe') &&
      !legacy.includes('toolFoldProbe = {') &&
      !legacy.includes('legacy.toolFoldFiberProbe'),
    'legacy tool fold fiber probe health must be replaced by runtime.fiber.toolUseBlock capability',
  );
  assert(
    legacy.includes('toolUseBlockCap = defineCapability({') &&
      legacy.includes("name: 'runtime.fiber.toolUseBlock'") &&
      legacy.includes('const result = toolUseBlockCap.read(el)'),
    'readToolUseBlock must go through the runtime.fiber.toolUseBlock capability without changing its public return shape',
  );
  for (const name of [
    'runtime.fiber.connection',
    'runtime.fiber.sessionsManager',
    'runtime.fiber.activeSessionObject',
    'runtime.fiber.appContext',
    'runtime.fiber.transcriptRecord',
    'runtime.fiber.toolUseBlock',
    'runtime.fiber.toolResultSignal',
    'runtime.fiber.diffPayload',
    'runtime.fiber.fileOpener',
  ]) {
    assert(
      shared.includes(`name: '${name}'`) || legacy.includes(`name: '${name}'`),
      `runtime fiber capability missing: ${name}`,
    );
  }
  assert(
    shared.includes('connectionCap = defineCapability({') &&
      shared.includes("name: 'runtime.fiber.connection'") &&
      shared.includes('staleAfterMs: 800') &&
      shared.includes('const result = connectionCap.read()'),
    'enhance_shared locateClaudeConnection must be the single runtime.fiber.connection capability with the shared cache',
  );
  assert(
    legacy.includes('function locateConnection()') &&
      legacy.includes('return locateClaudeConnection();') &&
      !legacy.includes('legacyConnectionCap') &&
      !legacy.includes("name: 'runtime.fiber.connection.legacy'") &&
      !legacy.includes('let cachedConnection = null') &&
      !legacy.includes('function findConnectionInValue'),
    'legacy connection helper must delegate to shared locateClaudeConnection; batch 3 deletes the private legacy cache/finder',
  );
  for (const [cap, readCall] of [
    ['sessionsManagerCap', 'sessionsManagerCap.read()'],
    ['activeSessionObjectCap', 'activeSessionObjectCap.read()'],
    ['appContextCap', 'appContextCap.read()'],
    ['transcriptRecordCap', 'transcriptRecordCap.read(el)'],
    ['diffPayloadCap', 'diffPayloadCap.read(wrapper)'],
    ['toolResultSignalCap', 'toolResultSignalCap.read({ useBlock, el })'],
    ['fileOpenerCap', 'fileOpenerCap.read(el)'],
  ]) {
    assert(
      legacy.includes(`${cap} = defineCapability({`) && legacy.includes(`const result = ${readCall}`),
      `${cap} wrapper must preserve the original public helper signature through capability.read`,
    );
  }
  const legacyModules = {
    identity: 'initLegacyIdentity',
    transcript_actions: 'initLegacyTranscriptActions',
    tool_fold: 'initLegacyToolFold',
    diff_island: 'initLegacyDiffIsland',
    fork_rewind: 'initLegacyForkRewind',
    user_bubble: 'initLegacyUserBubble',
    deferred_next: 'initLegacyDeferredNext',
    ask_refinement: 'initLegacyAskRefinement',
  };
  for (const [moduleName, initName] of Object.entries(legacyModules)) {
    const modulePath = path.join(__dirname, '..', 'data', 'legacy', `${moduleName}.js`);
    const source = fs.readFileSync(modulePath, 'utf8');
    assert(
      source.includes("import { runLegacyInit } from './registry.js'") &&
        source.includes(`export function ${initName}`) &&
        source.includes(`runLegacyInit('${moduleName}'`),
      `legacy split module ${moduleName}.js must expose an independent init with legacy.${moduleName} health`,
    );
    assert(
      legacy.includes(`./legacy/${moduleName}.js`) && legacy.includes(`${initName}(legacyContext)`),
      `enhance_legacy must import and call ${initName}`,
    );
  }
  assert(
    /initLegacyAskRefinement\(legacyContext\);\r?\n\s*initLegacyTranscriptActionDebug\(legacyContext\);/.test(legacy),
    'legacy split must preserve the old init order by running transcript debug tools after ask refinement setup',
  );
  assert(
    capability.includes('const MISS_REASONS = new Set([') &&
      capability.includes("reason: 'error'") &&
      capability.includes("reason: 'shapeMiss'") &&
      legacy.includes("return { ok: false, value: null, reason: 'notMounted' }") &&
      legacy.includes("return { ok: false, value: null, reason: 'noFiber' }") &&
      legacy.includes("return { ok: false, value: null, reason: 'shapeMiss' }") &&
      legacy.includes("return { ok: true, value: { block: outer, status: p.status }, reason: 'ok' }"),
    'runtime capability probes must return explicit ProbeResult objects with classified reasons',
  );

  assert(
    hostProbe.includes('function isUserTextContentNode') &&
      hostProbe.includes('container.querySelectorAll(\'[class*="expandableContainer"] [class*="content_"]\')'),
    'user bubble host probe must tag only the official expandable text content node',
  );
  assert(
    !hostProbe.includes('container.querySelectorAll(\'[class*="content_"]\').forEach'),
    'user bubble host probe must not tag every content_ node in the user container',
  );
  assert(
    legacy.includes('USER_TEXT_CONTENT_SELECTOR') &&
      legacy.includes('[class*="expandableContainer"] [class*="content_"]'),
    'user bubble classifier must measure the official expandable text content node',
  );
  assert(
    !legacy.includes('textLen * 10 + (el.scrollHeight || 0)'),
    'user bubble content-node selection must not force layout while scoring candidates',
  );
  assert(
    theme.includes('[data-incipit-user-bubble]:not(:has([data-incipit-interrupted-message])) [class*="expandableContainer"] [class*="content_"]') &&
      theme.includes('[data-incipit-user-bubble][data-claude-length="long"]:not([data-claude-expanded="1"]) [class*="expandableContainer"] [class*="content_"]'),
    'user bubble CSS must override the host 60px clip and preserve incipit long-message clipping',
  );
  assert(
    typography.includes('function isStreamingMountWorthScanning') &&
      typography.includes("cls.indexOf('userMessage_')") &&
      typography.includes("cls.indexOf('root_')"),
    'streaming childList gate must keep new user bubbles and markdown roots on the fast mint path via cheap className checks',
  );
  assert(
    !typography.includes('function scanUserBubbleUi'),
    'scanUserBubbleUi fast path must remain removed — it ran matches/closest/querySelectorAll on every streaming added node, almost always missing user bubbles entirely',
  );
  assert(
    !typography.includes('pendingRoots.add(document.body)'),
    'highlight.js readiness must not trigger a second document-wide copy/action sweep',
  );

  const kernel = fs.readFileSync(path.join(__dirname, '..', 'data', 'runtime_kernel.js'), 'utf8');
  assert(
    bootstrap.includes('initRuntimeKernel();') &&
      !/^\s*initRuntimeKernel\(\);\s*$/m.test(kernel),
    'runtime kernel must initialize from bootstrap, not at module evaluation time; enhance_shared now owns a fiber capability and module-level auto-init re-enters it before ESM initialization finishes',
  );
  assert(
    kernel.includes("reportCapability('runtime.hostState.semanticBridge'") &&
      !kernel.includes("reportCapability('hostState.semanticBridge'") &&
      kernel.includes('getActiveClaudeSessionId({ allowStaleState: true, skipFiber: true })') &&
      !kernel.includes("import { SEL } from './host_probe.js'"),
    'host-state semantic bridge must report as runtime.hostState.semanticBridge and must not use the fiber connection fallback internally',
  );
  assert(
    !kernel.includes('setupMutationBus') &&
      !kernel.includes('emitAddedNodeEvents') &&
      !kernel.includes('handleMutationBusRecords'),
    'runtime kernel must not run a body-subtree mutationBus — every added node paying for 6 selector tests was the streaming CPU regression',
  );
  assert(
    !kernel.includes("emit('toolUseMounted'") &&
      !kernel.includes("emit('assistantMarkdownMounted'") &&
      !kernel.includes("emit('messagesDomChanged'"),
    'runtime kernel must not emit per-node mutation events — feature modules keep their own filtered observers',
  );
  assert(
    !kernel.includes('walkFiberAnchors') &&
      !kernel.includes('locateActiveSessionState') &&
      !kernel.includes('locateSessionsManager'),
    'runtime kernel must not run its own fiber walk — bridge-less mode should fall through to consumer-local probes, not pile on a second walker',
  );
  assert(
    hostProbe.includes('const CSS_CAPABILITIES = Object.freeze([') &&
      hostProbe.includes("name: 'runtime.cssClass.userBubble'") &&
      hostProbe.includes("presence: 'whileVisible'") &&
      hostProbe.includes('CSS_ALWAYS_WARMUP_MS = 5000') &&
      hostProbe.includes('function runAlwaysCssCapabilityCheck') &&
      hostProbe.includes('function scheduleVisibleCssCapabilityCheck') &&
      hostProbe.includes("health.set('capability.' + def.name"),
    'host_probe must expose runtime.cssClass capabilities with presence-gated health reporting',
  );
  assert.strictEqual(
    (hostProbe.match(/new MutationObserver/g) || []).length,
    1,
    'CSS capability reporting must reuse the existing host_probe MutationObserver',
  );

  const hostBadge = fs.readFileSync(path.join(__dirname, '..', 'data', 'host-badge.cjs'), 'utf8');
  assert(
    !hostBadge.includes('stream.write = function wrappedWrite'),
    'host-badge must not overwrite createWriteStream `stream.write` — that mutates host object identity; only `finish`/`close`/`end` events are subscribed',
  );
  assert(
    legacy.includes("label.textContent = 'Open Containing Folder'") &&
      !legacy.includes("label.textContent = 'Open in VS Code'") &&
      legacy.includes('file links in assistant markdown should') &&
      legacy.includes('opener.open(info.filePath, info.location || undefined)') &&
      legacy.includes("type: 'file_reveal_request'") &&
      legacy.includes('function sessionIdForFileAction()') &&
      legacy.includes('sessionId: sessionIdForFileAction()'),
    'link tooltip More menu must stay single-purpose: reveal the file in its containing folder, while markdown file-link clicks use host fileOpener.open',
  );
  assert(
    legacy.includes('function eventTargetElement(node)') &&
      legacy.includes('function closestBodyLink(node)') &&
      legacy.includes('function bodyLinkFromPoint(node, evt)') &&
      legacy.includes('function resolveTipFast(node, evt)') &&
      legacy.includes('function armTipShow(hit, snapshot)') &&
      legacy.includes('document.elementFromPoint(evt.clientX, evt.clientY)') &&
      legacy.includes('assistantMarkdownFallback') &&
      legacy.includes('!!findAssistantActionHost(scope)') &&
      legacy.includes("document.body.addEventListener('mousemove', handleTipHover, { capture: true, passive: true })") &&
      legacy.includes('stable hover over the') &&
      legacy.includes('visible link still arms the dwell timer') &&
      legacy.includes('mousemove hot path: arm one dwell probe') &&
      legacy.includes('no-hit mousemove means the pointer is') &&
      legacy.includes('TIP_HIDE_GRACE = 60') &&
      legacy.includes('setTimeout(hideTip, TIP_HIDE_GRACE)') &&
      legacy.includes('if (tipHideTimer) return') &&
      legacy.includes('tipEl.addEventListener(\'mouseenter\', cancelScheduledHide)') &&
      legacy.includes('tipEl.addEventListener(\'mouseleave\', scheduleHide)') &&
      legacy.includes("tipEl.style.top = (above ? rect.top - h - 4 : rect.bottom + 4) + 'px'") &&
      legacy.includes('const resolved = hit || (tipPendingProbe ? resolveTip(tipPendingProbe.target, tipPendingProbe) : null)'),
    'assistant body link tooltip must use pointer-coordinate hit testing, but full link scans must run after dwell instead of on every mousemove',
  );
  const hoverStart = legacy.indexOf('function handleTipHover(evt)');
  const hoverEnd = legacy.indexOf('function positionTip()', hoverStart);
  const hoverBlock = hoverStart >= 0 && hoverEnd > hoverStart ? legacy.slice(hoverStart, hoverEnd) : '';
  assert(
    hoverBlock.includes('resolveTipFast(evt.target, evt)') &&
      hoverBlock.includes('if (tipTarget)') &&
      hoverBlock.includes('tipEl.contains(targetEl)') &&
      hoverBlock.includes('scheduleHide()') &&
      !hoverBlock.includes('resolveTip(evt.target, evt)') &&
      !hoverBlock.includes("querySelectorAll('a[href]')") &&
      !hoverBlock.includes('getClientRects()'),
    'mousemove hover handler must stay cheap and use a short non-resetting hide grace; full body-link coordinate scans belong behind the hover-intent timer',
  );
  assert(
    !/::[-\w]*scrollbar/.test(cssWithoutComments),
    'theme.css must not contain live ::-webkit-scrollbar rules; those put the main chat scroller back on the non-composited autoscroll-jitter path',
  );
  assert(
    hostBadge.includes("message.type === 'file_reveal_request'") &&
      hostBadge.includes("type: 'file_reveal_response'") &&
      hostBadge.includes("require('vscode')") &&
      hostBadge.includes('FILE_REVEAL_CWD_SCAN_BYTES = 512 * 1024') &&
      hostBadge.includes('function resolveFileRevealCwd(state, comm, message)') &&
      hostBadge.includes('revealIdentityForMessage(state, comm, message || {})') &&
      hostBadge.includes('readTranscriptCwd(target)') &&
      hostBadge.includes('Relative file path has no Claude project cwd.') &&
      hostBadge.includes("vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved))") &&
      hostBadge.includes('vscode.env.openExternal(vscode.Uri.file(directoryPath))') &&
      hostBadge.includes('selected: true') &&
      hostBadge.includes('selected: false') &&
      hostBadge.includes('File path is outside the active workspace.'),
    'host-badge must handle link-popover folder reveal through a real VS Code extension-host OS reveal path with openExternal fallback and workspace validation',
  );
}

function testFixture(root) {
  const extensionPath = path.join(root, 'extension.js');
  const webviewPath = path.join(root, 'webview', 'index.js');
  const extensionSource = fs.readFileSync(extensionPath, 'utf8');
  const webviewSource = fs.readFileSync(webviewPath, 'utf8');

  const [extensionPatched, extensionLines, extensionContracts] = __test.patchExtensionJs(extensionSource);
  assertNoGracefulDegradation(`${root} extension.js`, extensionLines);
  extensionContracts.unshift(__test.buildHostRouteContract(
    { version: versionFromFixtureRoot(root) },
    extensionSource,
    webviewSource,
  ));
  const [, extensionHeadLine] = __test.patchExtensionHtmlHead(extensionPatched, DEFAULT_THEME);
  extensionContracts.push(makePatchContract({
    name: 'install.extensionHtmlHead',
    line: extensionHeadLine,
    detail: { palette: DEFAULT_THEME.palette },
  }));
  const [extensionPatchedAgain] = __test.patchExtensionJs(extensionPatched);
  assert.strictEqual(extensionPatchedAgain, extensionPatched, `${root}: extension patch is not idempotent`);

  const [webviewPatched, webviewLines, webviewContracts] = __test.patchWebviewIndex(
    webviewSource,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    extensionContracts,
  );
  assert.doesNotThrow(
    () => new vm.Script(webviewPatched, { filename: `${root}/webview/index.js` }),
    `${root}: patched webview/index.js has invalid JavaScript syntax`,
  );
  assertNoGracefulDegradation(`${root} webview/index.js`, webviewLines);
  assertWebviewSemanticShape(root, webviewPatched, webviewLines);
  assertInstallManifestShape(root, webviewPatched, webviewContracts);

  const [webviewPatchedAgain, webviewLinesAgain, webviewContractsAgain] = __test.patchWebviewIndex(
    webviewPatched,
    DEFAULT_FEATURES,
    DEFAULT_THEME,
    'en',
    extensionContracts,
  );
  assert.doesNotThrow(
    () => new vm.Script(webviewPatchedAgain, { filename: `${root}/webview/index.js second pass` }),
    `${root}: patched webview/index.js second pass has invalid JavaScript syntax`,
  );
  assert.strictEqual(webviewPatchedAgain, webviewPatched, `${root}: webview patch is not idempotent`);
  assertNoGracefulDegradation(`${root} webview/index.js second pass`, webviewLinesAgain);
  assertWebviewSemanticShape(root, webviewPatchedAgain, webviewLinesAgain);
  assertInstallManifestShape(root, webviewPatchedAgain, webviewContractsAgain);
}

assertRuntimeSourceContracts();

const fixtures = collectFixtureRoots();
if (!fixtures.length) {
  console.log('patch-contracts: skipped (no Claude Code official restore fixture found)');
  process.exit(0);
}

for (const fixture of fixtures) {
  testFixture(fixture);
  console.log(`patch-contracts: ok ${fixture}`);
}
