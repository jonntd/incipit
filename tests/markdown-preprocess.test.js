'use strict';

const assert = require('assert');

(async () => {
  const {
    preprocessMarkdown,
    preprocessMarkdownBareUrls,
  } = await import('../data/markdown_preprocess.js');

  assert.strictEqual(
    preprocessMarkdownBareUrls('nxhub -> http://127.0.0.1:3100/nxhub（PID 23468）'),
    'nxhub -> <http://127.0.0.1:3100/nxhub>（PID 23468）',
  );

  assert.strictEqual(
    preprocessMarkdownBareUrls('see https://example.com/docs.'),
    'see <https://example.com/docs>.',
  );

  assert.strictEqual(
    preprocessMarkdownBareUrls('wiki https://example.com/Foo_(bar)'),
    'wiki <https://example.com/Foo_(bar)>',
  );

  assert.strictEqual(
    preprocessMarkdownBareUrls('already <https://example.com/docs>'),
    'already <https://example.com/docs>',
  );

  assert.strictEqual(
    preprocessMarkdownBareUrls('[docs](https://example.com/docs)'),
    '[docs](https://example.com/docs)',
  );

  assert.strictEqual(
    preprocessMarkdownBareUrls('`http://127.0.0.1:3100/nxhub（PID）`'),
    '`http://127.0.0.1:3100/nxhub（PID）`',
  );

  assert.strictEqual(
    preprocessMarkdownBareUrls('```txt\nhttp://127.0.0.1:3100/nxhub（PID）\n```\nhttp://127.0.0.1:3100/ok（PID）'),
    '```txt\nhttp://127.0.0.1:3100/nxhub（PID）\n```\n<http://127.0.0.1:3100/ok>（PID）',
  );

  assert.strictEqual(
    preprocessMarkdown('http://127.0.0.1:3100/nxhub（PID）', { math: false }),
    '<http://127.0.0.1:3100/nxhub>（PID）',
  );

  console.log('markdown-preprocess: 8 checks PASSED');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
