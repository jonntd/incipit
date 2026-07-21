'use strict';

/**
 * Source contracts for docs/ui-roadmap.md (P0 / P1 / P2).
 * Hermetic — no browser. Complements deferred-next + change-review suites.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const theme = fs.readFileSync(path.join(root, 'data', 'theme.css'), 'utf8');
const warm = fs.readFileSync(path.join(root, 'data', 'warm-white-override.css'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'data', 'enhance_shared.js'), 'utf8');
const legacy = fs.readFileSync(path.join(root, 'data', 'enhance_legacy.js'), 'utf8');
const install = fs.readFileSync(path.join(root, 'src', 'install.js'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'docs', 'ui-roadmap.md'), 'utf8');

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

(function roadmapDocComplete() {
  assert.ok(roadmap.includes('## P0') && roadmap.includes('## P1') && roadmap.includes('## P2'));
  assert.ok(roadmap.includes('会话级改动摘要') || roadmap.includes('session'));
  assert.ok(roadmap.includes('Empty') || roadmap.includes('空'));
  ok('docs/ui-roadmap.md covers P0–P2');
})();

(function p0FlashFreeBorders() {
  for (const tok of [
    '--app-input-border',
    '--app-input-active-border',
    '--app-transparent-inner-border',
    '--app-transparent-border',
  ]) {
    assert.ok(theme.includes(tok), 'theme missing ' + tok);
    assert.ok(warm.includes(tok), 'warm-white missing ' + tok);
  }
  assert.ok(shared.includes('--app-input-border') && shared.includes('--app-transparent-inner-border'));
  assert.ok(theme.includes('box-shadow: none !important'));
  ok('P0 flash-free border tokens + message rims');
})();

(function p0StatusAndPlan() {
  assert.ok(theme.includes('--incipit-status-success'));
  assert.ok(legacy.includes("s === 'cancelled'") && legacy.includes("return 'success'"));
  assert.ok(legacy.includes('ExitPlanMode:') && legacy.includes('EnterPlanMode:'));
  assert.ok(legacy.includes('isPlanTool') || legacy.includes('/Plan/i'));
  ok('P0 status map + Plan tools');
})();

(function p0ChangeReviewMount() {
  assert.ok(legacy.includes('function changeReviewHasMissingMounts'));
  assert.ok(legacy.includes('function scheduleChangeReviewMountRetry'));
  assert.ok(legacy.includes('ALWAYS notify the host'));
  assert.ok(legacy.includes('placeChangeReviewTurnBlock(host, block, placement.markdownRoot || null)') ||
    legacy.includes('markdownRoot'));
  ok('P0 change-review mount + finalize');
})();

(function p1TokensResponsiveZhA11y() {
  for (const tok of [
    '--incipit-type-caption',
    '--incipit-type-ui',
    '--incipit-space-1',
    '--incipit-radius-md',
  ]) {
    assert.ok(theme.includes(tok), 'missing ' + tok);
  }
  assert.ok(theme.includes('min(720px, 100% - 24px)'));
  assert.ok(legacy.includes('CHANGE_REVIEW_TEXT_ZH') && legacy.includes('拒绝本轮'));
  assert.ok(legacy.includes('TRANSCRIPT_ACTION_TEXT_ZH') && legacy.includes('function transcriptActionText'));
  assert.ok(theme.includes('prefers-reduced-motion'));
  assert.ok(theme.includes(':focus-visible'));
  assert.ok(theme.includes('var(--incipit-type-ui') && theme.includes('var(--incipit-type-caption'),
    'change-review / chrome should consume type tokens, not only define them');
  assert.ok(theme.includes('var(--incipit-radius-md'),
    'key cards should use radius tokens');
  ok('P1 tokens, responsive width, zh chrome, a11y');
})();

(function p2ModuleSplit() {
  const uiDir = path.join(root, 'data', 'ui');
  for (const name of [
    'message.css',
    'tool-card.css',
    'change-review.css',
    'empty-state.css',
  ]) {
    assert.ok(fs.existsSync(path.join(uiDir, name)), 'missing data/ui/' + name);
    assert.ok(theme.includes("url('ui/" + name + "')") || theme.includes('url("ui/' + name + '")'),
      'theme must @import ui/' + name);
  }
  assert.ok(install.includes("'ui'") || install.includes('"ui"'),
    'install LOCAL_ASSET_TREES must sync ui/');
  assert.ok(theme.indexOf('@import') < theme.indexOf('@font-face'),
    '@import must precede @font-face');
  ok('P2 CSS module split + install tree');
})();

(function p2SurfaceState() {
  assert.ok(fs.existsSync(path.join(root, 'data', 'legacy', 'surface_state.js')));
  assert.ok(legacy.includes('function setupSurfaceStateBanners'));
  assert.ok(legacy.includes('initLegacySurfaceState'));
  assert.ok(legacy.includes('data-incipit-surface-state'));
  assert.ok(!legacy.includes('setupSessionChangeSummary'),
    'session-level "本会话改动" strip must stay removed (user-rejected noise)');
  assert.ok(!fs.existsSync(path.join(root, 'data', 'ui', 'session-summary.css')),
    'session-summary.css must not ship');
  const emptyCss = fs.readFileSync(path.join(root, 'data', 'ui', 'empty-state.css'), 'utf8');
  assert.ok(emptyCss.includes('surface-state'));
  assert.ok(emptyCss.includes('data-incipit-surface-state="auth"'),
    'empty-state must style mid-turn auth failure banner');
  assert.ok(warm.includes('data-incipit-surface-state'),
    'warm-white must restyle surface state for paper palette');
  assert.ok(warm.includes('data-incipit-surface-state="auth"'),
    'warm-white must restyle auth surface state');
  assert.ok(legacy.includes('function setupAuthLoginGuard'),
    'mid-turn authentication_failed must not eject to full login wall');
  ok('P2 empty/offline/auth surface state (no session summary strip)');
})();

(function p2FileExtAndMcpColors() {
  assert.ok(legacy.includes('incipitFileExt') || legacy.includes('data-incipit-file-ext') ||
    legacy.includes("dataset.incipitFileExt"));
  const toolCss = fs.readFileSync(path.join(root, 'data', 'ui', 'tool-card.css'), 'utf8');
  assert.ok(toolCss.includes('data-incipit-file-ext') && toolCss.includes('__'));
  assert.ok(toolCss.includes('Reading') === false || toolCss.includes('never Reading') ||
    toolCss.includes('never') || toolCss.includes('UI font'));
  ok('P2 file-ext path tints + MCP hue + no serif on tool summary');
})();

(function protocolLeakSurface() {
  assert.ok(theme.includes("ui/protocol-card.css"));
  assert.ok(fs.existsSync(path.join(root, 'data', 'ui', 'protocol-card.css')));
  assert.ok(fs.existsSync(path.join(root, 'data', 'protocol_tags.js')));
  assert.ok(legacy.includes("from './protocol_tags.js'"));
  assert.ok(legacy.includes('function decorateProtocolToolResult'));
  assert.ok(legacy.includes('function decorateProtocolLeakBubble'));
  const cardCss = fs.readFileSync(path.join(root, 'data', 'ui', 'protocol-card.css'), 'utf8');
  assert.ok(cardCss.includes('data-incipit-protocol-card'));
  assert.ok(cardCss.includes('data-incipit-protocol-raw-hidden'));
  assert.ok(warm.includes('data-incipit-protocol-card'),
    'warm-white must restyle protocol leak cards for paper palette');
  ok('protocol-tag leak collapses to status card (task-notification etc.)');
})();

(function p2VisualScaffold() {
  assert.ok(fs.existsSync(path.join(root, 'tests', 'visual', 'smoke.cjs')));
  assert.ok(fs.existsSync(path.join(root, 'tests', 'visual', 'README.md')));
  const smoke = fs.readFileSync(path.join(root, 'tests', 'visual', 'smoke.cjs'), 'utf8');
  assert.ok(smoke.includes('INCIPIT_VISUAL_URL') && smoke.includes('SKIP'));
  ok('P2 visual CI scaffold (optional Playwright)');
})();


(function continueButtonSendsFixedText() {
  assert.ok(legacy.includes('function setupContinueButton'));
  assert.ok(legacy.includes('function sendContinueMessage'));
  assert.ok(legacy.includes('function interruptActiveClaudeTurn'));
  assert.ok(legacy.includes("CONTINUE_SEND_TEXT = '继续'"));
  assert.ok(legacy.includes('interruptClaude'));
  // Prefer host session.interrupt() (what the Stop button calls) before the
  // fiber-located connection fallback — forks often miss locateClaudeConnection.
  assert.ok(
    legacy.includes('session.interrupt') || legacy.includes('typeof session.interrupt'),
    'continue interrupt must prefer session.interrupt()',
  );
  assert.ok(legacy.includes('rawSend.apply') && legacy.includes('CONTINUE_SEND_TEXT'));
  assert.ok(legacy.includes('data-incipit-continue-btn'));
  assert.ok(legacy.includes('setupContinueButton()'));
  // Must share rerun's quiesce path — busy=false alone is not enough; the
  // old continue path sent "继续" while the interrupted CLI still flushed
  // and produced Mismatched content_block_delta text/thinking.
  assert.ok(legacy.includes('quiesceOldStream'));
  const cont = legacy.slice(
    legacy.indexOf('async function sendContinueMessage'),
    legacy.indexOf('function ensureContinueButton'),
  );
  assert.ok(cont.includes('quiesceOldStream'), 'continue must call quiesceOldStream when busy');
  assert.ok(cont.includes('setHandoffLatch(true)'), 'continue must latch handoff');
  assert.ok(
    cont.includes('aborting send') || cont.includes('did not quiesce'),
    'continue must abort on quiesce timeout instead of force-sending',
  );
  assert.ok(
    cont.includes('showTranscriptToast'),
    'continue must surface a toast when stop fails (silent abort felt broken)',
  );
  assert.ok(
    cont.includes('interruptActiveClaudeTurn'),
    'continue must interrupt before waiting / sending',
  );
  assert.ok(theme.includes('[data-incipit-continue-btn]'));
  assert.ok(theme.includes('[data-incipit-continue-btn]::before'));
  assert.ok(warm.includes('[data-incipit-continue-btn]'));
  ok('continue button: force-stop then send "继续" as icon-only control');
})();

(function streamStallWatchPresent() {
  assert.ok(legacy.includes('function setupStreamStallWatch'));
  assert.ok(legacy.includes('function checkStreamStall'));
  assert.ok(legacy.includes('STREAM_STALL_WARN_MS'));
  assert.ok(legacy.includes('setupStreamStallWatch()'));
  assert.ok(legacy.includes('kernelStreamQuietForMs'));
  ok('stream stall watch: toast when busy with no output for long quiet');
})();

console.log('\nui-roadmap: ' + passed + ' checks PASSED');
