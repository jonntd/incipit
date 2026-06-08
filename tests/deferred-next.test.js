'use strict';

// Regression fence for the "queue messages while streaming" composer layer.
//
// Contract (the design agreed with the user):
//   · a real ORDERED QUEUE (not one latest payload): mid-stream composer
//     submits APPEND; the card shows all of them, reorderable
//   · the card's per-row "Guide" still calls the original host send NOW
//   · AUTO-RELEASE fires only on a *natural* turn end. busy/finalized fire
//     identically for natural end, user Stop, and error — so release is
//     gated on the host "interrupted" marker + partial tail, behind a
//     sustained re-checked confirm window (an errored turn's marker can
//     lag busy=false — fail-closed: any doubt ⇒ do not send)
//   · only the HEAD is released; it does NOT chain — the next item waits
//     for the next natural end
//   · no floating toasts at all; errors surface inline in the card
//   · editing a row survives queue mutations / reorder (textarea + CJK IME
//     never torn down)
//   · the official composer text layer remains entirely host-owned: incipit
//     may feed host input foreground tokens, but not style messageInput/
//     mentionMirror text directly

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8');
const warm = fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8');
const shared = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_shared.js'), 'utf8');
const hostProbe = fs.readFileSync(path.join(__dirname, '..', 'data', 'host_probe.js'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname, '..', 'data', 'runtime_kernel.js'), 'utf8');
const typography = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_typography.js'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(__dirname, '..', 'data', 'legacy', 'deferred_next.js'), 'utf8');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
function functionBody(name, span = 1800) {
  const idx = legacy.indexOf('function ' + name);
  assert.ok(idx >= 0, 'missing function ' + name);
  return legacy.slice(idx, idx + span);
}
function cssRuleBody(selector) {
  const idx = theme.indexOf(selector);
  assert.ok(idx >= 0, 'missing CSS selector ' + selector);
  const open = theme.indexOf('{', idx);
  const close = theme.indexOf('}', open);
  assert.ok(open >= 0 && close > open, 'missing CSS block for ' + selector);
  return theme.slice(open + 1, close);
}

(function legacyModuleIsSplitAndRegistered() {
  assert.ok(
    moduleSrc.includes("runLegacyInit('deferred_next'") &&
      moduleSrc.includes('ctx.setupDeferredNextMessageQueue();'),
    'deferred_next legacy module must register an independent health init',
  );
  assert.ok(
    legacy.includes("import { initLegacyDeferredNext } from './legacy/deferred_next.js'") &&
      legacy.includes('initLegacyDeferredNext(legacyContext);'),
    'enhance_legacy must import and initialize deferred_next',
  );
  ok('legacy module split + init registration');
})();

(function changeReviewUiIsActiveForReleaseApply() {
  const initMatch = legacy.match(/\n  function init\(\) \{([\s\S]*?)\n  \}\n\n  whenDOMReady\(init\);/);
  assert.ok(initMatch, 'missing legacy root init() body');
  const init = initMatch[1];
  const setup = functionBody('setupChangeReviewFileReview', 2200);
  assert.ok(
    legacy.includes('function setupChangeReviewFileReview()') &&
      setup.includes("reportHealth('legacy.change_review', 'ok')") &&
      init.includes('setupChangeReviewFileReview,'),
    'change-review implementation must remain in source for continued development',
  );
  assert.ok(
    /^\s*setupChangeReviewFileReview\(\);/m.test(init),
    'release apply must activate the composer mini bar and transcript review blocks',
  );
  ok('change-review UI: source retained and release init active');
})();

(function sendWrapperKeepsOfficialPath() {
  const wrap = functionBody('wrapDeferredSendOnSession');
  assert.ok(legacy.includes('const deferredOriginalSendBySession = new WeakMap();'),
    'original SessionState.send must be preserved per session');
  assert.ok(wrap.includes('session.send = function incipitDeferredNextSendWrapper(...args)'),
    'SessionState.send wrapper must be installed');
  assert.ok(wrap.includes('shouldCaptureDeferredSend(this, args)') &&
    wrap.includes('captureDeferredNext(this, args);') &&
    wrap.includes('return Promise.resolve();'),
    'busy composer send must be captured without launching a second host send');
  assert.ok(wrap.includes('return original.apply(this, args);'),
    'non-captured sends must continue through the original host path');
  assert.ok(legacy.includes('deferredNextBypassDepth') &&
    legacy.includes('await rawSend.apply(session, [item.text, item.attachments, false])'),
    'Guide must bypass the wrapper and call the original host send immediately');
  ok('send wrapper: capture busy submit, preserve official send/Guide path');
})();

(function stateIsAnOrderedQueueAppended() {
  const capture = functionBody('captureDeferredNext', 1200);
  assert.ok(legacy.includes('let deferredQueue = [];'),
    'state must be an ordered queue, not one latest payload');
  assert.ok(!legacy.includes('let deferredNext = null;'),
    'the single-latest model must be gone');
  assert.ok(capture.includes('deferredQueue.push({') && !capture.includes('replacing'),
    'a mid-stream submit must APPEND to the queue, never replace');
  assert.ok(legacy.includes('function deferredHead') &&
    legacy.includes('function deferredRemoveById'),
    'queue needs head + remove-by-id helpers');
  ok('state model: ordered queue, capture appends');
})();

(function noFloatingToastsErrorsAreInline() {
  for (const key of ['sendFail', 'badType', 'tooLarge', 'readFail']) {
    assert.ok(!legacy.includes("showTranscriptToast(deferredText('" + key + "'"),
      'no status/error toast for ' + key + ' — the card is the feedback');
  }
  assert.ok(legacy.includes('function setDeferredInlineError'),
    'errors must be surfaced inline, not via a floating toast');
  const add = functionBody('addDeferredAttachmentFromFile', 1400);
  assert.ok(add.includes("setDeferredInlineError(deferredText('badType'))") &&
    add.includes("setDeferredInlineError(deferredText('readFail'))"),
    'image errors must be inline and NOT silently swallowed');
  ok('no floating toasts; errors inline, not swallowed');
})();

(function naturalEndGateRefusesInterruptedAndError() {
  const interrupted = functionBody('deferredLastTurnInterrupted', 900);
  const natural = functionBody('deferredTurnLooksNatural', 500);
  const arm = functionBody('armNaturalEndConfirm', 900);
  assert.ok(interrupted.includes('interruptedMessage') &&
    interrupted.includes('activeSessionHasPartialTail()'),
    'interruption = host interrupted marker (primary) + partial tail (secondary)');
  assert.ok(natural.includes('deferredConvBusySafe()') &&
    natural.includes('deferredLastTurnInterrupted()') &&
    natural.includes('askPanelIsActive()'),
    'a natural end requires: not busy, not interrupted, no Ask');
  assert.ok(legacy.includes('const DEFERRED_NEXT_NATURAL_CONFIRM_MS = 1500;'),
    'a deliberate sustained confirm window must exist (absorbs the lagging error marker)');
  assert.ok(arm.includes('DEFERRED_NEXT_NATURAL_CONFIRM_MS') &&
    arm.includes('if (!deferredTurnLooksNatural()) return;') &&
    arm.includes('flushDeferredNextIfReady();'),
    'the confirm window must re-check natural-ness before releasing');
  // bridge-unknown is treated as busy (fail-closed)
  assert.ok(/function deferredConvBusySafe[\s\S]*catch \(_\) \{ return true; \}/.test(legacy),
    'unknown host state must be treated as busy, never as a free pass to send');
  ok('natural-end gate: interrupted/error/partial freeze the queue');
})();

(function flushReleasesHeadOnlyAndDoesNotChain() {
  const fb = functionBody('flushDeferredNextIfReady', 1700);
  assert.ok(fb.includes('const item = deferredHead();'),
    'flush must target the queue head');
  assert.ok(fb.includes('if (!deferredTurnLooksNatural()) { scheduleDeferredNextRender(); return; }'),
    'flush must RE-CHECK natural-ness at fire time (marker can land late)');
  assert.ok(fb.includes('await rawSend.apply(active, [item.text, item.attachments, false])') &&
    fb.includes('deferredRemoveById(item.id);'),
    'flush sends via the original host send, then drops exactly that item');
  const afterSend = fb.indexOf('await rawSend.apply(active');
  assert.ok(afterSend >= 0 &&
    fb.indexOf('flushDeferredNextIfReady(', afterSend + 1) === -1,
    'flush must NOT chain-send the next item — it waits for the next natural end');
  ok('flush: head-only, gated, no burst/chain');
})();

(function setupArmsOnSettleNeverFlushesOnRawBusyFalse() {
  const setup = functionBody('setupDeferredNextMessageQueue', 1400);
  assert.ok(setup.includes("subscribeRuntime('streamSettled', () => { armNaturalEndConfirm(); })") &&
    setup.includes("subscribeRuntime('assistantTurnFinalized', () => { armNaturalEndConfirm(); })"),
    'settle/finalize only ARM the confirm window');
  assert.ok(setup.includes('if (evt && evt.busy === true) cancelNaturalEndConfirm();'),
    'a live turn must cancel any pending release');
  assert.ok(!setup.includes('evt.busy === false') && !legacy.includes('scheduleDeferredNextFlush'),
    'the naive "flush on busy=false" path must be gone (it mis-sent after a Stop)');
  ok('setup: arm-on-settle, cancel-on-busy, no raw busy-false flush');
})();

(function cardVisibilityAndKeyedReconciliation() {
  const hide = functionBody('deferredCardShouldHide', 600);
  const rowFor = functionBody('deferredRowFor', 900);
  const observer = functionBody('setupDeferredNextVisibilityObserver', 2400);
  assert.ok(hide.includes('deferredComposerIsVisible(mount.input)') &&
    hide.includes('askPanelIsActive()') &&
    hide.includes('deferredQueueSessionId()'),
    'card hides with the composer, when Ask is up, or off the queue session');
  assert.ok(observer.includes('!deferredQueue.length && !deferredNextEl && !changeReviewCardEl && !changeReviewActiveTurn()') &&
    observer.includes('deferredNodeTouchesComposerOrAsk') &&
    observer.includes('mutationInsideFocusedEditor(m)') &&
    observer.includes('armNaturalEndConfirm();'),
    'observer is cheap when idle, skips focused editor mutations, stays composer/Ask-scoped, and arms (not flushes) on touch');
  assert.ok(observer.includes('deferredNextVisibilityObserver.observe(document.body, { childList: true, subtree: true });') &&
    !observer.includes('attributes: true') &&
    !observer.includes('attributeFilter') &&
    !observer.includes("m.type === 'attributes'"),
    'deferred/change-review visibility must not observe body-wide class/style attributes');
  assert.ok(rowFor.includes('if (hasEditor) refreshDeferredEditorInPlace(row, item)'),
    'a row holding a live editor must be refreshed in place, never rebuilt');
  assert.ok(rowFor.includes('else { row.textContent = \'\'; renderDeferredNextEditor(row, item); }'),
    'the editor is built once (no live editor yet); summary stays stateless');
  ok('card: keyed reconciliation, editor row preserved, Ask-scoped observer');
})();

(function sharedComposerRailKeepsDeferredQueueClosestToInput() {
  const composerRoot = functionBody('currentComposerElement', 1400);
  const composerRootCheck = functionBody('isComposerRootElement', 900);
  const touches = functionBody('deferredNodeTouchesComposerOrAsk', 900);
  const rail = functionBody('ensureComposerRail', 1300);
  const mountPoint = functionBody('composerRailMountPoint', 500);
  const deferredMount = functionBody('deferredCardMountPoint', 500);
  const changeMount = functionBody('ensureChangeReviewCard', 1300);
  const inputRule = cssRuleBody('[data-incipit-input-container]');
  const railRule = cssRuleBody('[data-incipit-composer-rail]');
  assert.ok(legacy.includes('let composerRailEl = null') &&
    rail.includes("composerRailEl.setAttribute('data-incipit-composer-rail', '')"),
    'incipit composer attachments must share one rail above the official input');
  assert.ok(legacy.includes("const COMPOSER_INPUT_CONTAINER_SELECTOR =\n    'fieldset[class*=\"inputContainer_\"], [class*=\"inputContainer_\"]:has(> [class*=\"inputContainerBackground\"])';") &&
    legacy.includes('function nodeInsideFocusedEditor(node)') &&
    legacy.includes('function nodeInsideMessagesContainer(node)') &&
    composerRoot.includes('document.querySelectorAll(SEL.inputContainer)') &&
    composerRoot.includes("document.querySelectorAll('[class*=\"inputContainer_\"]')") &&
    composerRootCheck.includes("classes.includes('inputContainer_')") &&
    composerRootCheck.includes("classes.includes('inputContainerBackground')") &&
    composerRootCheck.includes("tag === 'fieldset' || hasDirectInputContainerBackground(node)") &&
    mountPoint.includes('const input = currentComposerElement();') &&
    touches.includes('nodeInsideFocusedEditor(node)') &&
    touches.includes('nodeTouchesPermissionRequest(node)') &&
    touches.includes('nodeInsideMessagesContainer(node)') &&
    touches.includes('isComposerRootElement(node)') &&
    touches.includes('closestComposerRoot(node)') &&
    touches.includes('queryComposerRoot(node)'),
    'composer rail must have a precise fallback while keeping input typing and message scrolling out of the hot composer scan');
  assert.ok(rail.includes('data-incipit-composer-rail-hidden') &&
    rail.includes('!deferredComposerIsVisible(mount.input) || askPanelIsActive()'),
    'AskUserQuestion / hidden composer must hide the whole composer rail');
  assert.ok(deferredMount.includes('return { parent: mount.rail, before: null, input: mount.input };'),
    'deferred-next must mount last in the rail, staying closest to the input');
  assert.ok(changeMount.includes('rail.rail.insertBefore(changeReviewCardEl, rail.rail.firstChild || null)') &&
    changeMount.includes('rail.rail.insertBefore(changeReviewCardEl, before)'),
    'change-review mini bar must stay above deferred-next inside the shared rail');
  assert.ok(theme.includes('[data-incipit-composer-rail]') &&
    theme.includes('flex-direction: column') &&
    theme.includes('[data-incipit-composer-rail-hidden]') &&
    inputRule.includes('box-sizing: border-box !important;') &&
    inputRule.includes('width: 100% !important;') &&
    inputRule.includes('max-width: 100% !important;') &&
    inputRule.includes('min-inline-size: 0 !important;') &&
    railRule.includes('max-width: 100% !important;') &&
    railRule.includes('min-width: 0 !important;') &&
    theme.includes('[data-incipit-deferred-next] {\n  box-sizing: border-box !important;\n  width: 100% !important;\n  margin: 0 !important;'),
    'rail/input sizing stays inside the official composer width; deferred-next keeps its full card instead of being compressed');
  ok('shared composer rail: Ask hides all, deferred queue remains closest to input');
})();

(function changeReviewMiniBarIsSingleLineUntilExpanded() {
  const state = functionBody('setupChangeReviewFileReview', 1800);
  const render = functionBody('renderChangeReviewCard', 2400);
  const active = functionBody('changeReviewActiveTurn', 600);
  const blocks = functionBody('renderChangeReviewTurnBlocks', 1500);
  const format = functionBody('formatChangeReviewSummary', 700);
  const row = functionBody('renderChangeReviewFileRow', 1800);
  assert.ok(legacy.includes('let changeReviewExpanded = false') &&
    state.includes('changeReviewExpanded = false'),
    'change-review mini bar defaults to collapsed on session change');
  assert.ok(render.includes("summary.setAttribute('data-incipit-change-review-summary', '')") &&
    render.includes("title.textContent = formatChangeReviewSummary(turn)") &&
    render.includes("summary.appendChild(changeReviewButton(changeReviewText('review')") &&
    render.includes("const reject = changeReviewButton(changeReviewText('rejectTurn')"),
    'collapsed mini bar must show only summary + Review + Reject turn');
  assert.ok(render.includes('if (changeReviewExpanded && files.length)') &&
    render.includes("list.setAttribute('data-incipit-change-review-files', '')"),
    'file rows inside the composer rail must render only after explicit expansion');
  assert.ok(active.includes('changeReviewPayload && changeReviewPayload.activeTurn') &&
    active.includes('changeReviewTurnFileCount(turn) > 0') &&
    !active.includes('changeReviewTurns()') &&
    !active.includes('latestTurn'),
    'mini bar must be driven only by the current active lifecycle, never by finalized history');
  assert.ok(format.includes('changeReviewTotalsHaveLineStats(turn)') &&
    format.includes(': label') &&
    row.includes('changeReviewFileHasLineStats(file)') &&
    row.includes(": ''"),
    'unknown line stats must not render as misleading +0/-0 counts');
  assert.ok(blocks.includes('placeChangeReviewTurnBlock(host, block)') &&
    !render.includes('renderChangeReviewTurnBlocks()'),
    'full per-turn review belongs in the transcript body, not expanded above the input');
  ok('change-review mini bar: single-line default, expands only on demand');
})();

(function changeReviewTranscriptBlocksWaitForFinalizedTurn() {
  const setup = functionBody('setupChangeReviewFileReview', 3000);
  const channel = functionBody('setupChangeReviewChannel', 1800);
  const schedule = functionBody('scheduleChangeReviewRender', 500);
  const startNotify = functionBody('notifyChangeReviewTurnStarted', 900);
  const notify = functionBody('notifyChangeReviewTurnFinalized', 1000);
  const lifecycle = functionBody('postChangeReviewTurnLifecycle', 1000);
  const key = functionBody('changeReviewTurnKeyForLastAssistant', 1200);
  const latestUser = functionBody('changeReviewTurnKeyForLatestRealUser', 1300);
  const findRecord = functionBody('findAssistantRecordForTurn', 900);
  const hasText = functionBody('transcriptHasText', 450);
  const renderBlocks = functionBody('renderChangeReviewTurnBlocks', 1500);
  const placement = functionBody('placeChangeReviewTurnBlock', 1200);
  const actionPlacement = functionBody('placeAssistantActionRow', 900);
  const conversationBusy = functionBody('conversationIsBusy', 1200);
  const legacyBusyProbe = functionBody('legacyCompositeBusyProbe', 1200);
  const reconcile = functionBody('reconcileAssistantTranscriptActions', 2300);
  const sweep = functionBody('sweepStreamingDisableState', 600);
  assert.ok(!schedule.includes('renderChangeReviewTurnBlocks()'),
    'ordinary mini-card render must not insert transcript review blocks');
  assert.ok(setup.includes("subscribeRuntime('messagesChanged'") &&
    !setup.slice(setup.indexOf("subscribeRuntime('messagesChanged'"), setup.indexOf("subscribeRuntime('busyChanged'")).includes('scheduleChangeReviewTurnBlocksRender'),
    'messagesChanged may refresh payload/mini bar but must not append transcript review blocks mid-stream');
  assert.ok(setup.includes("subscribeRuntime('assistantTurnFinalized'") &&
    setup.includes('if (changeReviewBusySafe())') &&
    setup.includes('removeCurrentBusyChangeReviewTurnBlocks();') &&
    setup.includes('notifyChangeReviewTurnFinalized();') &&
    setup.includes('scheduleChangeReviewTurnBlocksRender();'),
    'transcript review blocks are appended after assistantTurnFinalized only when composite busy is false');
  assert.ok(conversationBusy.includes('return kernelConversationIsBusy() === true;') &&
    !conversationBusy.includes('if (kernelConversationIsBusy()) return true;') &&
    !conversationBusy.includes('return !!kernelConversationIsBusy();') &&
    legacyBusyProbe.includes("if (domState === 'stop') return true") &&
    legacyBusyProbe.includes('activeSessionHasPartialTail()') &&
    legacy.includes("registerRuntimeBusyProbe('legacy.compositeBusy', legacyCompositeBusyProbe)") &&
    runtime.includes('function compositeBusyState(state = hostState)') &&
    runtime.includes("if (state && state.pendingInput === true) return true;") &&
    runtime.includes("if (state && state.partialTail === true) return true;") &&
    runtime.includes("emit('assistantTurnFinalized'"),
    'bridge busy=false must not by itself mark the assistant turn complete; kernel + legacy share composite stop/partial probes');
  assert.ok(typography.includes('conversationIsBusy as kernelConversationIsBusy') &&
    typography.includes('if (conversationIsBusy()) return; // streaming: settle event will re-trigger') &&
    typography.includes('if (conversationIsBusy()) return;') &&
    !typography.includes('return !!kernelConversationIsBusy();'),
    'typography/mermaid/table passes must be gated by the composite runtime busy state, not raw bridge false');
  assert.ok(notify.includes("change_review_turn_finalized") &&
    lifecycle.includes('type,') &&
    lifecycle.includes('turnKey') &&
    startNotify.includes("change_review_turn_started") &&
    latestUser.includes("m.type === 'user'") &&
    latestUser.includes("m.type === 'assistant'") &&
    latestUser.includes('transcriptHasText(m)') &&
    latestUser.includes("return ''") &&
    key.includes("m.type !== 'assistant'") &&
    key.includes('transcriptHasToolResult(prev)') &&
    key.includes('return recordUuid(prev)'),
    'stream start/finalized must notify host with the real user turn key, never the previous completed user');
  assert.ok(findRecord.includes("m.type === 'assistant' && transcriptHasText(m)") &&
    hasText.includes("content.trim().length > 0") &&
    hasText.includes("block.text.trim().length > 0"),
    'turn review placement must anchor to the final text assistant, never the thinking/tool sibling');
  assert.ok(setup.includes('if (evt && evt.busy === true) armChangeReviewTurnStarted();') &&
    setup.includes('if (changeReviewBusySafe()) scheduleChangeReviewTurnStarted(20);') &&
    !setup.includes('busy === true) notifyChangeReviewTurnStarted()'),
    'busy=true must arm a delayed current-user probe, not immediately unfinalize the previous completed turn');
  assert.ok(channel.includes('if (!changeReviewBusySafe()) scheduleChangeReviewTurnBlocksRender();'),
    'initial/historical payload can render transcript blocks only when the session is not busy');
  assert.ok(renderBlocks.includes('if (changeReviewBusySafe())') &&
    renderBlocks.includes('removeCurrentBusyChangeReviewTurnBlocks();') &&
    renderBlocks.includes('findAssistantReviewPlacement(record)') &&
    renderBlocks.includes('placeChangeReviewTurnBlock(host, block)') &&
    !renderBlocks.includes('host.insertBefore(block, actionRow || null)') &&
    placement.includes("host.querySelector(':scope > .incipit-assistant-action-row')") &&
    placement.includes('actionRow.nextSibling') &&
    placement.includes('host.insertBefore(block, actionRow.nextSibling)') &&
    !placement.includes('host.insertBefore(block, actionRow)') &&
    !placement.includes('host.appendChild(block)'),
    'transcript review blocks must wait for the incipit action row and sit after it');
  assert.ok(actionPlacement.includes('host.insertBefore(row, anchor.nextSibling)') &&
    actionPlacement.includes('changeReviewTurns().length && !changeReviewBusySafe()') &&
    !actionPlacement.includes("hasAttribute('data-incipit-change-review-turn')"),
    'assistant action row must stay directly after output, then trigger review block rendering after itself only when idle');
  assert.ok(sweep.includes('removeCurrentBusyAssistantTerminalDecorations();') &&
    reconcile.includes('recordBelongsToCurrentBusyTurn(existingRecord)') &&
    reconcile.includes('existingRow.remove();') &&
    legacy.includes('function removeCurrentBusyChangeReviewTurnBlocks()') &&
    legacy.includes("block.getAttribute('data-incipit-change-review-turn')") &&
    legacy.includes('latestRealUserTurnKey()'),
    'busy resuming after a false gap must remove current-turn assistant action rows and review blocks');
  ok('change-review transcript block: finalized/historical only, not stream-time');
})();

(function changeReviewDiffIsOnDemandAndReusesDiffIslandShell() {
  const request = functionBody('openChangeReviewDiff', 900);
  const modal = functionBody('openChangeReviewDiffModal', 1100);
  const fill = functionBody('fillChangeReviewDiffBody', 1400);
  assert.ok(request.includes("postChangeReviewRequest('change_review_diff_request', { fileId: file.id }, 12000)"),
    'diff text must be requested on demand per file, not shipped in the ordinary payload');
  assert.ok(modal.includes("island.setAttribute('data-incipit-diff-island', '')") &&
    modal.includes("island.setAttribute('data-incipit-write-diff', '')") &&
    modal.includes("body.setAttribute('data-incipit-diff-island-body', '')") &&
    modal.includes("body.setAttribute('data-incipit-write-diff-body', '')") &&
    modal.includes('island.appendChild(body)'),
    'change-review diff modal must reuse the existing diff island outer shell + body structure');
  assert.ok(fill.includes("rowEl.setAttribute('data-incipit-diff-island-row', row.kind)") &&
    fill.includes("pre.setAttribute('data-incipit-write-diff-pre', '')") &&
    fill.includes('code.textContent = row.text'),
    'diff rows must render as text/code nodes through the diff island hooks');
  ok('change-review diff: on-demand payload, shared diff island shell');
})();

(function reorderIsPointerDragNotNativeDnD() {
  const drag = functionBody('startDeferredRowDrag', 1100);
  const summary = functionBody('renderDeferredNextSummary', 2600);
  assert.ok(summary.includes("grip.addEventListener('pointerdown', evt => startDeferredRowDrag("),
    'reorder starts from a pointerdown on the grip');
  assert.ok(drag.includes("window.addEventListener('pointermove'") &&
    drag.includes("window.addEventListener('pointerup'") &&
    drag.includes('commitDeferredOrderFromDom(list)'),
    'reorder is pointer-driven and commits the new order back to the queue');
  assert.ok(drag.includes('if (item.sending || item.editing) return;'),
    'the in-flight / editing row is locked from dragging');
  assert.ok(!legacy.includes('.draggable = true'),
    'reorder must NOT use flaky native HTML5 drag-and-drop');
  ok('reorder: pointer-drag on grip, in-flight locked, no native DnD');
})();

(function perRowGuideAndDiscardById() {
  const guide = functionBody('guideDeferredNextNow', 1100);
  const discard = functionBody('discardDeferredNext', 400);
  assert.ok(legacy.includes('async function guideDeferredNextNow(item)') &&
    guide.includes('deferredRemoveById(item.id);') &&
    guide.includes('rawSend.apply(session, [item.text, item.attachments, false])'),
    'Guide sends THIS item now and removes only it; the rest stay queued');
  assert.ok(discard.includes('if (id == null) deferredQueue = [];') &&
    discard.includes('deferredRemoveById(id);'),
    'discard removes one row by id (or clears all)');
  ok('per-row Guide + discard by id; others keep queuing');
})();

(function editorTextAndImageStillEditableAndImeSafe() {
  const editor = functionBody('renderDeferredNextEditor', 4200);
  const strip = functionBody('renderDeferredAttachmentStrip', 4600);
  const add = functionBody('addDeferredAttachmentFromFile', 1400);
  // The image MIME allow-list / size cap are now SHARED with the
  // user-bubble editor — one source of truth, no parallel copy.
  assert.ok(!legacy.includes('DEFERRED_NEXT_ALLOWED_IMAGE_MIMES') &&
    !legacy.includes('DEFERRED_NEXT_MAX_IMAGE_BYTES'),
    'the duplicated DEFERRED_NEXT_* image constants must be gone');
  assert.ok(add.includes('ALLOWED_INLINE_IMAGE_MIMES.has(file.type)') &&
    add.includes('file.size > MAX_INLINE_IMAGE_BYTES'),
    'image validation must reuse the shared inline-editor allow-list/cap');
  assert.ok(strip.includes("fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp'") &&
    editor.includes("textarea.addEventListener('paste'") &&
    editor.includes("row.addEventListener('drop'"),
    'image input via the in-strip + picker, plus textarea paste and editor drop');
  assert.ok(add.includes('new FileReader()') &&
    add.includes('reader.readAsDataURL(file)') &&
    add.includes('draft.attachments.push({ file, dataUrl })'),
    'new image input must be converted back to the host attachment shape');
  assert.ok(editor.includes('evt.isComposing') && editor.includes('evt.keyCode === 229'),
    'editor keydown must ignore keys during CJK IME composition');
  assert.ok(editor.includes("evt.key === 'Escape'") &&
    editor.includes("evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)"),
    'Esc cancels and Cmd/Ctrl+Enter saves the queued edit');
  ok('editor: text+image editable, shared cap, IME-safe, Esc/⌘↵ shortcuts');
})();

(function officialComposerTextLayerIsHostOwned() {
  const composerTextSelector = /\[data-incipit-input-container\][^{]*\[class\*="(?:messageInput|mentionMirror|voiceInterim)"\]/;
  const composerChipSelector = '[data-incipit-input-container] [class*="inputMentionChip"]';
  const composerChip = cssRuleBody(composerChipSelector);
  assert.ok(!legacy.includes('setupComposerInputState') &&
    !legacy.includes('composerEditorPlainText') &&
    !legacy.includes('data-incipit-composer-empty') &&
    !legacy.includes('[class*="mentionMirror"]'),
    'legacy runtime must not track or mutate the official composer text/mirror layer');
  assert.ok(!hostProbe.includes('data-incipit-input-editor') &&
    !hostProbe.includes('inputEditor') &&
    !hostProbe.includes('messageInput') &&
    !hostProbe.includes('[aria-multiline="true"][contenteditable]'),
    'host probe must not mark or observe the official contenteditable editor');
  assert.ok(!theme.includes('data-incipit-composer-empty') &&
    !theme.includes('[data-incipit-input-editor]') &&
    !theme.includes('[class*="mentionMirror"]') &&
    !theme.includes('--app-mention-chip-background') &&
    !theme.includes('--app-mention-chip-foreground') &&
    !composerTextSelector.test(theme),
    'theme.css must not style messageInput, mentionMirror, or voiceInterim');
  assert.ok(!warm.includes('data-incipit-composer-empty') &&
    !warm.includes('[class*="mentionMirror"]') &&
    !warm.includes('--app-mention-chip-background') &&
    !warm.includes('--app-mention-chip-foreground') &&
    !composerTextSelector.test(warm),
    'warm-white override must not reintroduce composer text-layer styling');
  assert.ok(theme.includes('--app-primary-foreground: #f8f8f6 !important;') &&
    theme.includes('--app-input-foreground: #f8f8f6 !important;') &&
    theme.includes('--app-input-secondary-foreground: #f8f8f6 !important;') &&
    warm.includes('--app-primary-foreground: #0d0d0d !important;') &&
    warm.includes('--app-input-foreground: #0d0d0d !important;') &&
    warm.includes('--app-input-secondary-foreground: #0d0d0d !important;') &&
    shared.includes("'--app-input-foreground': SOFT_FG") &&
    shared.includes("'--app-input-secondary-foreground': SOFT_FG"),
    'host input foreground tokens must match the transcript body foreground in each palette');
  assert.ok(!shared.includes('--app-mention-chip-background') &&
    !shared.includes('--app-mention-chip-foreground'),
    'runtime app-var overrides must not recolor official composer mention chips');
  assert.ok(theme.includes('--incipit-composer-mention-chip-background: #3d312d;') &&
    theme.includes('--incipit-composer-mention-chip-foreground: #e0a18b;') &&
    theme.includes('--incipit-composer-mention-chip-background-hover: #493932;') &&
    warm.includes('--incipit-composer-mention-chip-background: #ead8cf;') &&
    warm.includes('--incipit-composer-mention-chip-foreground: #8f452b;') &&
    warm.includes('--incipit-composer-mention-chip-background-hover: #e2c8bc;'),
    'composer mention chip retone must use incipit-scoped palette variables');
  assert.ok(composerChip.includes('background: var(--incipit-composer-mention-chip-background) !important;') &&
    composerChip.includes('background-color: var(--incipit-composer-mention-chip-background) !important;') &&
    composerChip.includes('color: var(--incipit-composer-mention-chip-foreground) !important;') &&
    composerChip.includes('box-shadow:') &&
    !/display\s*:|position\s*:|overflow\s*:|line-height\s*:|font-|caret-|visibility\s*:|opacity\s*:/m.test(composerChip),
    'composer mention chip rule may retint only, without taking over text or layout');
  assert.ok(theme.includes('[data-incipit-input-container] [class*="inputMentionChip"]:hover') &&
    theme.includes('[data-incipit-input-container] [class*="inputMentionChip"] *') &&
    !shared.includes('--incipit-composer-mention-chip'),
    'composer mention chip color is static CSS only, not runtime app-var mutation');
  assert.ok(theme.includes('--incipit-message-mention-chip-background') &&
    theme.includes('var(--incipit-message-mention-chip-background)') &&
    theme.includes('var(--incipit-message-mention-chip-foreground)'),
    'transcript mention chips must use incipit-scoped variables instead of app mention-chip variables');
  ok('composer text layer: official host owns messageInput, mirror, and placeholder; incipit only retints reference chips');
})();

(function attachmentChipsReuseBubbleVisualAndPreview() {
  const strip = functionBody('renderDeferredAttachmentStrip', 4600);
  // Reuse the user-bubble inline editor's chip CSS family + its
  // standalone fullscreen preview — same look, same behaviour, ZERO
  // changes to that battle-tested path.
  assert.ok(strip.includes("strip.className = 'incipit-edit-chip-strip'") &&
    strip.includes("chip.className = 'incipit-edit-chip'") &&
    strip.includes("chip.classList.add('incipit-edit-chip--image')") &&
    strip.includes("img.className = 'incipit-edit-chip-thumb'") &&
    strip.includes("x.className = 'incipit-edit-chip-x'") &&
    strip.includes("add.className = 'incipit-edit-chip-add'"),
    'chips must reuse the .incipit-edit-chip* visual language, not a parallel skin');
  assert.ok(strip.includes('openImagePreview(att.dataUrl)'),
    'clicking an image chip must open the SAME shared fullscreen preview');
  assert.ok(strip.includes("chip.setAttribute('role', 'button')") &&
    strip.includes("chip.setAttribute('tabindex', '0')") &&
    strip.includes("ev.key !== 'Enter' && ev.key !== ' '"),
    'image chip must be keyboard-activatable (a11y parity with the bubble)');
  assert.ok(strip.includes('CHIP_FILE_ICON_SVG') &&
    strip.includes("label.className = 'incipit-edit-chip-label'"),
    'non-image / no-dataUrl attachment must fall back to a neutral labelled chip');
  // The old parallel skin + its CSS/JS hooks must be retired.
  assert.ok(!legacy.includes('data-incipit-deferred-next-attachment="image"') &&
    !legacy.includes('data-incipit-deferred-next-chip-x') &&
    !legacy.includes('data-incipit-deferred-next-edit-attach'),
    'the perfunctory parallel attachment skin must be gone');
  assert.ok(!theme.includes('[data-incipit-deferred-next-chip-x]') &&
    !theme.includes('[data-incipit-deferred-next-edit-attach]') &&
    theme.includes('[data-incipit-deferred-next] .incipit-edit-chip-strip'),
    'dead chip CSS removed; chip strip scoped to the shared family');
  ok('attachment chips: reuse bubble chip skin + preview + a11y, no parallel copy');
})();

(function appliedGuiCopyIsEnglishOnly() {
  // Project convention: the Chinese locale lives only in the CLI; the
  // applied in-editor GUI matches the host language and every other
  // incipit GUI string (plain English). The scaffold's zh/en table +
  // locale switch was redundant and is removed.
  const dict = functionBody('deferredText', 700);
  assert.ok(legacy.includes('const DEFERRED_NEXT_TEXT = Object.freeze({') &&
    !/DEFERRED_NEXT_TEXT = Object\.freeze\(\{\s*zh:/.test(legacy) &&
    !legacy.includes("guide: '引导'"),
    'the bilingual zh/en table must collapse to one flat English map');
  assert.ok(!dict.includes('CFG.language') && !dict.includes('DEFERRED_NEXT_TEXT.en'),
    'deferredText must not branch on locale anymore');
  ok('applied-GUI copy: English-only, no locale branching');
})();

(function genericPermissionRequestsUseThemeSkin() {
  assert.ok(theme.includes('Generic permission request panels.') &&
    theme.includes('[class*="permissionRequestContainer_"] {') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionRequestContainerBackground_"]') &&
    theme.includes('display: none !important;') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionRequestContent_"]') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionAction_"]') &&
    theme.includes('[class*="permissionRequestContainer_"] [class*="permissionOption_"]') &&
    theme.includes('button:not([aria-label]):not(.incipit-ask-collapse-btn):not(.incipit-permission-collapse-btn):not([data-incipit-ask-collapsed-bar]):not([data-incipit-permission-collapsed-bar])') &&
    theme.includes('[class*="permissionRequestContainer_"] input:not([type="checkbox"]):not([type="radio"])') &&
    theme.includes('caret-color: #a8896e !important;'),
    'generic permission request panels must be themed, including Plan acceptance without questionsContainer');
  assert.ok(warm.includes('Generic permission request panels') &&
    warm.includes('[class*="permissionRequestContainer_"] {') &&
    warm.includes('background: #ffffff !important;') &&
    warm.includes('[class*="permissionRequestContainer_"] [class*="permissionAction_"]') &&
    warm.includes('button:not([aria-label]):not(.incipit-ask-collapse-btn):not(.incipit-permission-collapse-btn):not([data-incipit-ask-collapsed-bar]):not([data-incipit-permission-collapsed-bar])') &&
    warm.includes('[class*="permissionRequestContainer_"] input:not([type="checkbox"]):not([type="radio"])') &&
    warm.includes('caret-color: #a8896e !important;'),
    'warm-white must override generic permission request panels, not only AskUserQuestion');
  assert.ok(theme.includes('.incipit-permission-collapse-btn') &&
    theme.includes('[data-incipit-permission-floating-collapse] [class*="permissionRequestContent_"]') &&
    theme.includes('[data-incipit-permission-request][data-incipit-permission-collapsed="1"]') &&
    theme.includes('> .incipit-permission-collapsed-bar') &&
    warm.includes('[data-incipit-permission-request][data-incipit-permission-collapsed="1"] > .incipit-permission-collapsed-bar'),
    'generic permission request panels must share Ask collapse/expand styling in both themes');
  assert.ok(theme.includes('[class*="permissionRequestContainer_"]:has([class*="questionsContainer_"])') &&
    legacy.includes('function isPermissionRequestContainer(el)') &&
    legacy.includes('function closestPermissionRequestContainer(el)') &&
    legacy.includes("container.setAttribute('data-incipit-permission-request', '')") &&
    legacy.includes("container.setAttribute('data-incipit-permission-collapsed', '1')") &&
    legacy.includes("btn.setAttribute('data-incipit-permission-collapse-btn', '')") &&
    legacy.includes("bar.setAttribute('data-incipit-permission-collapsed-bar', '')") &&
    legacy.includes("container.setAttribute('data-incipit-permission-floating-collapse', '1')") &&
    legacy.includes('const nav = container.querySelector(ASK_NAV_SELECTOR);'),
    'collapse JS must decorate every permission request, with Ask retaining navigator-aware button placement');
  ok('permission request panels: Plan/Edit approvals share warm theme and Ask-style collapse');
})();

(function uiHasDarkAndWarmWhiteTreatment() {
  for (const sel of [
    '[data-incipit-deferred-next]',
    '[data-incipit-deferred-next-list]',
    '[data-incipit-deferred-row]',
    '[data-incipit-deferred-next-error]',
    '[data-incipit-deferred-dragging]',
    '[data-incipit-deferred-next-guide]',
    '[data-incipit-deferred-next-textarea]',
  ]) {
    assert.ok(theme.includes(sel), 'dark theme missing ' + sel);
  }
  for (const sel of [
    '[data-incipit-deferred-next]',
    '[data-incipit-deferred-next-error]',
    '[data-incipit-deferred-row][data-incipit-deferred-dragging]',
    '[data-incipit-deferred-next-textarea]',
  ]) {
    assert.ok(warm.includes(sel), 'warm-white override missing ' + sel);
  }
  assert.ok(theme.includes('max-height: 168px') && theme.includes('overflow-y: auto'),
    'the queue list must cap height and scroll, not eat the panel');
  // Flattened summary action row: Edit + Delete are DIRECT icon
  // buttons. The old kebab held only Edit + "Close queue", where
  // "Close queue" was the literal same call as the trash button — a
  // redundant destructive duplicate hidden behind an extra tap.
  const summary = functionBody('renderDeferredNextSummary', 2600);
  assert.ok(summary.includes("makeDeferredIconButton('edit', deferredText('edit'), EDIT_ICON_SVG") &&
    summary.includes("makeDeferredIconButton('delete', deferredText('removeTitle'), TRASH_ICON_SVG"),
    'summary exposes Edit + Delete as direct icon buttons');
  assert.ok(!summary.includes('openActionDropdown') && !summary.includes('MORE_ICON_SVG') &&
    !legacy.includes("deferredText('close')") && !legacy.includes("deferredText('moreTitle')"),
    'the redundant kebab (Edit + duplicate-Delete) must be gone');
  ok('UI: dark + warm-white queue treatment, scroll cap, flattened action row');
})();

console.log('\ndeferred-next: ' + passed + ' checks PASSED');
