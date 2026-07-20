'use strict';

/**
 * Pure parse/label coverage for data/protocol_tags.js.
 * Also source contracts that enhance_legacy + host-badge wire the surface.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

(async () => {
  const {
    isProtocolLeakText,
    parseProtocolText,
    protocolCardHeadline,
    protocolCardTitle,
    protocolStatusLabel,
  } = await import('../data/protocol_tags.js');

  const SAMPLE_TASK = [
    '<task-notification>',
    '<task-id>bdziusx18</task-id>',
    '<tool-use-id>Monitor-26</tool-use-id>',
    '<output-file>/tmp/claude-501/tasks/bdziusx18.output</output-file>',
    '<status>failed</status>',
    '<summary>Monitor "Monitor Tauri app startup progress" script failed (exit 144)</summary>',
    '</task-notification>',
  ].join('\n');

  (function detectsTaskNotification() {
    assert.strictEqual(isProtocolLeakText(SAMPLE_TASK), true);
    const p = parseProtocolText(SAMPLE_TASK);
    assert.ok(p, 'parse must return a model');
    assert.strictEqual(p.kind, 'task-notification');
    assert.strictEqual(p.status, 'error');
    assert.strictEqual(p.dominant, true);
    assert.strictEqual(p.taskId, 'bdziusx18');
    assert.strictEqual(p.toolUseId, 'Monitor-26');
    assert.strictEqual(p.exitCode, '144');
    assert.ok(
      p.summary.includes('Monitor Tauri app startup progress') ||
        p.summary.includes('exit 144'),
      'summary should carry host text',
    );
    ok('parse task-notification failed Monitor payload');
  })();

  (function labelsZhEn() {
    const p = parseProtocolText(SAMPLE_TASK);
    assert.strictEqual(protocolCardTitle(p, 'en'), 'Background task');
    assert.strictEqual(protocolCardTitle(p, 'zh'), '后台任务');
    assert.strictEqual(protocolStatusLabel('error', 'en'), 'failed');
    assert.strictEqual(protocolStatusLabel('error', 'zh'), '失败');
    assert.ok(protocolCardHeadline(p, 'en').length > 0);
    ok('zh/en title + status chip labels');
  })();

  (function successAndPending() {
    const okXml =
      '<task-notification><status>completed</status><summary>Deploy finished</summary></task-notification>';
    const p = parseProtocolText(okXml);
    assert.strictEqual(p.status, 'success');
    assert.strictEqual(p.summary, 'Deploy finished');

    const runXml =
      '<task-notification><status>running</status><summary>building</summary></task-notification>';
    assert.strictEqual(parseProtocolText(runXml).status, 'pending');
    ok('status map: completed→success, running→pending');
  })();

  (function systemReminderAndCaveat() {
    const rem = parseProtocolText(
      '<system-reminder>\nAvailable skills: foo\n</system-reminder>',
    );
    assert.strictEqual(rem.kind, 'system-reminder');
    assert.strictEqual(rem.status, 'info');
    assert.ok(rem.summary.includes('Available skills'));

    const cav = parseProtocolText(
      '<local-command-caveat>Do not respond to these messages</local-command-caveat>',
    );
    assert.strictEqual(cav.kind, 'local-command-caveat');
    assert.ok(isProtocolLeakText(cav.raw));
    ok('system-reminder + local-command-caveat');
  })();

  (function slashCommandCluster() {
    const cmd = [
      '<command-name>/model</command-name>',
      '<command-message>model</command-message>',
      '<command-args>claude-fable-5</command-args>',
    ].join('\n');
    assert.strictEqual(isProtocolLeakText(cmd), true);
    const p = parseProtocolText(cmd);
    assert.strictEqual(p.kind, 'command');
    assert.ok(p.commandName.includes('/model') || p.commandName.includes('model'));
    ok('slash-command cluster is protocol leak');
  })();

  (function ignoresOrdinaryProse() {
    assert.strictEqual(isProtocolLeakText('hello world'), false);
    assert.strictEqual(parseProtocolText('hello world'), null);
    assert.strictEqual(
      isProtocolLeakText('Please fix the <task-notification> leak in the UI'),
      false,
      'prose that merely mentions the tag name is not a leak',
    );
    // Mention in the middle without dominating body.
    const mention =
      'I saw something like this earlier:\n\nnote: not a full payload\n\nPlease hide it.';
    assert.strictEqual(parseProtocolText(mention), null);
    ok('ordinary prose is not collapsed');
  })();

  (function localCommandStdout() {
    const body = [
      '<command-name>/model</command-name>',
      '<command-message>model</command-message>',
      '<command-args>default</command-args>',
      '<local-command-stdout>Set model to claude-opus-4-8</local-command-stdout>',
    ].join('\n');
    const p = parseProtocolText(body);
    assert.strictEqual(p.kind, 'command');
    assert.ok(p.summary.includes('Set model to claude-opus-4-8'));
    ok('local-command-stdout becomes headline');
  })();

  // ---- source contracts ----

  const legacy = fs.readFileSync(path.join(root, 'data', 'enhance_legacy.js'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'data', 'host-badge.cjs'), 'utf8');
  const install = fs.readFileSync(path.join(root, 'src', 'install.js'), 'utf8');
  const theme = fs.readFileSync(path.join(root, 'data', 'theme.css'), 'utf8');
  const cardCss = fs.readFileSync(
    path.join(root, 'data', 'ui', 'protocol-card.css'),
    'utf8',
  );

  (function wiresImportAndDecorators() {
    assert.ok(legacy.includes("from './protocol_tags.js'"));
    assert.ok(legacy.includes('function decorateProtocolLeakBubble'));
    assert.ok(legacy.includes('function decorateProtocolToolResult'));
    assert.ok(legacy.includes('function isProtocolLeakRecord'));
    assert.ok(legacy.includes('!isProtocolLeakRecord(record)'));
    assert.ok(legacy.includes('decorateProtocolLeakBubble(bubble, record)'));
    assert.ok(
      legacy.includes('decorateProtocolToolResult(content)') &&
        legacy.includes("data.status === 'error' || data.status === 'pending'"),
      'error/pending tools must still run protocol OUT collapse',
    );
    // Card must never be inserted relative to the bubble shell as content —
    // that parks it as a sibling outside bubbleEl.querySelector reach and
    // stacks infinite /MODEL (slash-command) cards on session open.
    assert.ok(legacy.includes('function insertProtocolCardInBubble'));
    assert.ok(legacy.includes('function pruneOrphanProtocolCards'));
    assert.ok(legacy.includes('function hideProtocolRawInBubble'));
    assert.ok(legacy.includes('function pruneDetachedProtocolCards'));
    assert.ok(legacy.includes('function isProtocolCardHosted'));
    assert.ok(
      legacy.includes('pruneDetachedProtocolCards(scope)'),
      'scanAndAddCopyButtons must sweep detached protocol cards before decorate',
    );
    // The decorate body must call userBubbleContentElement without
    // `|| bubbleEl` (edit path may still use that fallback).
    const decorateBody = legacy.slice(
      legacy.indexOf('function decorateProtocolLeakBubble'),
      legacy.indexOf('function buildProtocolCard'),
    );
    assert.ok(
      decorateBody.includes('userBubbleContentElement(bubbleEl)'),
      'decorate must resolve content element',
    );
    assert.ok(
      !/userBubbleContentElement\(bubbleEl\)\s*\|\|\s*bubbleEl/.test(decorateBody),
      'must not fall back to bubbleEl as protocol content anchor',
    );
    ok('enhance_legacy wires protocol decorators');
  })();

  (function hostBlocksEdit() {
    assert.ok(host.includes('function entryLooksLikeProtocolLeakRecord'));
    assert.ok(host.includes('entryLooksLikeProtocolLeakRecord(entry)'));
    assert.ok(host.includes('task-notification'));
    ok('host-badge blocks edit/rerun of protocol rows');
  })();

  (function installAndCss() {
    assert.ok(install.includes("protocol_tags.js"));
    assert.ok(theme.includes("ui/protocol-card.css"));
    assert.ok(cardCss.includes('data-incipit-protocol-card'));
    assert.ok(cardCss.includes('data-incipit-protocol-raw-hidden'));
    assert.ok(fs.existsSync(path.join(root, 'data', 'protocol_tags.js')));
    ok('install ships protocol_tags + CSS module');
  })();

  console.log('\nprotocol-tags: ' + passed + ' checks PASSED');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
