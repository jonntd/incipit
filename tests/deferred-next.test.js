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

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const legacy = fs.readFileSync(path.join(__dirname, '..', 'data', 'enhance_legacy.js'), 'utf8');
const theme = fs.readFileSync(path.join(__dirname, '..', 'data', 'theme.css'), 'utf8');
const warm = fs.readFileSync(path.join(__dirname, '..', 'data', 'warm-white-override.css'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(__dirname, '..', 'data', 'legacy', 'deferred_next.js'), 'utf8');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
function functionBody(name, span = 1800) {
  const idx = legacy.indexOf('function ' + name);
  assert.ok(idx >= 0, 'missing function ' + name);
  return legacy.slice(idx, idx + span);
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
  assert.ok(observer.includes('if (!deferredQueue.length && !deferredNextEl) return;') &&
    observer.includes('deferredNodeTouchesComposerOrAsk') &&
    observer.includes('armNaturalEndConfirm();'),
    'observer is cheap when idle, composer/Ask-scoped, and arms (not flushes) on touch');
  assert.ok(rowFor.includes('if (hasEditor) refreshDeferredEditorInPlace(row, item)'),
    'a row holding a live editor must be refreshed in place, never rebuilt');
  assert.ok(rowFor.includes('else { row.textContent = \'\'; renderDeferredNextEditor(row, item); }'),
    'the editor is built once (no live editor yet); summary stays stateless');
  ok('card: keyed reconciliation, editor row preserved, Ask-scoped observer');
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
