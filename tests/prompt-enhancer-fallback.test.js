'use strict';

// Prompt enhancer model fallback chain:
//   primary (current Claude settings.model) → sonnet DEFAULT → haiku DEFAULT
// Dedupes, missing DEFAULT_* skipped. Multi-model: one attempt each on
// switchable errors. Single-model collapse: historical same-model retries.

const assert = require('assert');

const T = require('../data/host-badge.cjs').__test;

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

const ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
];

function withCleanEnv(fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function chain(settings, preferredModel) {
  return withCleanEnv(() => T.resolvePromptEnhancerModelChain(settings, preferredModel));
}

// --- chain construction ----------------------------------------------------

{
  const c = chain({
    model: 'claude-fable-5-dd-5.4-korg',
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5-dd-eerf-3yh',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.2',
    },
  });
  assert.deepStrictEqual(c, [
    'claude-fable-5-dd-5.4-korg',
    'claude-fable-5-dd-eerf-3yh',
    'z-ai/glm-5.2',
  ]);
  ok('primary → sonnet → haiku');
}

{
  const c = chain({
    model: 'claude-fable-5-dd-eerf-3yh',
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5-dd-eerf-3yh',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.2',
    },
  });
  assert.deepStrictEqual(c, [
    'claude-fable-5-dd-eerf-3yh',
    'z-ai/glm-5.2',
  ]);
  ok('dedupes when primary is already sonnet');
}

{
  const c = chain({
    model: 'Primary-Model',
    env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'primary-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'PRIMARY-MODEL',
    },
  });
  assert.deepStrictEqual(c, ['Primary-Model']);
  ok('case-insensitive dedupe keeps first spelling');
}

{
  const c = chain({
    model: 'only-primary',
    env: {},
  });
  assert.deepStrictEqual(c, ['only-primary']);
  ok('missing DEFAULT_* leaves single-model chain');
}

{
  const c = chain({
    model: 'opus',
    env: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-free',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5-dd-eerf-3yh',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.2',
    },
  });
  assert.deepStrictEqual(c, [
    'mimo-v2.5-free',
    'claude-fable-5-dd-eerf-3yh',
    'z-ai/glm-5.2',
  ]);
  ok('family alias primary resolves then chains sonnet/haiku');
}

{
  const c = chain({
    model: 'default',
    env: {
      ANTHROPIC_MODEL: 'grok-4.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-x',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x',
    },
  });
  assert.deepStrictEqual(c, ['grok-4.5', 'sonnet-x', 'haiku-x']);
  ok('default model uses ANTHROPIC_MODEL then DEFAULT_* fallbacks');
}

{
  // UI selected a different model than settings — preferred wins as primary.
  const c = chain({
    model: 'default',
    env: {
      ANTHROPIC_MODEL: 'grok-4.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-x',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-x',
    },
  }, 'hy3-free');
  assert.deepStrictEqual(c, ['hy3-free', 'sonnet-x', 'haiku-x']);
  ok('preferred UI model overrides settings primary (two different models)');
}

{
  const c = chain({});
  assert.ok(Array.isArray(c) && c.length >= 1);
  assert.strictEqual(typeof c[0], 'string');
  assert.ok(c[0].length > 0);
  ok('empty settings still yields at least one model id');
}

// Your live settings shape: explicit fable id + mapped sonnet/haiku defaults.
{
  const c = chain({
    model: 'claude-fable-5-dd-5.4-korg',
    env: {
      ANTHROPIC_MODEL: 'grok-4.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'mimo-v2.5-free',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5-dd-eerf-3yh',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'z-ai/glm-5.2',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'deepseek-v4-flash-free',
    },
  });
  assert.deepStrictEqual(c, [
    'claude-fable-5-dd-5.4-korg',
    'claude-fable-5-dd-eerf-3yh',
    'z-ai/glm-5.2',
  ]);
  ok('live settings resolve to fable-korg → sonnet → haiku');
}

// --- switchable vs same-model retry ----------------------------------------

{
  const timeout = new Error('API request timeout');
  timeout.code = 'ETIMEDOUT';
  timeout.retryable = true;
  assert.strictEqual(T.isRetryablePromptEnhancerError(timeout), true);
  assert.strictEqual(T.isPromptEnhancerModelSwitchableError(timeout), true);
  ok('timeout is retryable and switchable');
}

{
  const notFound = new Error('model not found (model=foo, status=404)');
  notFound.statusCode = 404;
  assert.strictEqual(T.isRetryablePromptEnhancerError(notFound), false);
  assert.strictEqual(T.isPromptEnhancerModelSwitchableError(notFound), true);
  ok('model-not-found switches chain but does not same-model retry');
}

{
  const auth = new Error('No Claude auth found');
  auth.retryable = false;
  assert.strictEqual(T.isRetryablePromptEnhancerError(auth), false);
  assert.strictEqual(T.isPromptEnhancerModelSwitchableError(auth), false);
  ok('auth failure neither retries nor switches');
}

{
  const badReq = new Error('invalid request body');
  badReq.statusCode = 400;
  assert.strictEqual(T.isRetryablePromptEnhancerError(badReq), false);
  assert.strictEqual(T.isPromptEnhancerModelSwitchableError(badReq), false);
  ok('generic 400 neither retries nor switches');
}

{
  const overloaded = new Error('overloaded (model=x, status=529)');
  overloaded.statusCode = 529;
  assert.strictEqual(T.isRetryablePromptEnhancerError(overloaded), true);
  assert.strictEqual(T.isPromptEnhancerModelSwitchableError(overloaded), true);
  ok('529 overloaded is retryable and switchable');
}


// --- prompt content + sanitizer (accuracy / plain text) --------------------

{
  const content = T.buildPromptEnhancerUserContent('fix the bug');
  assert.ok(!content.includes('⚠️'), 'no emoji warning banner');
  assert.ok(content.includes('NO TOOLS ALLOWED'));
  assert.ok(content.includes('strictly faithful') || content.includes('faithful to the original'));
  assert.ok(content.includes('Do not invent') || content.includes('do not invent'));
  assert.ok(content.includes('no emoji') || content.includes('no decorative'));
  ok('buildPromptEnhancerUserContent is plain-text and accuracy-first');
}

{
  assert.strictEqual(
    T.sanitizeEnhancedPrompt('Please fix the ✨ bug 🐛 now', 'orig'),
    'Please fix the bug now',
  );
  assert.ok(!/\p{Extended_Pictographic}/u.test(
    T.sanitizeEnhancedPrompt('Add 🚀 rocket support', 'x'),
  ));
  // Empty-after-strip falls back to original
  assert.strictEqual(T.sanitizeEnhancedPrompt('✨✨✨', 'keep me'), 'keep me');
  ok('sanitizeEnhancedPrompt strips emoji and falls back to original');
}

console.log(`\n${passed} passed`);
