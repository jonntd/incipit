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
    preprocessMarkdownBareUrls('caps HTTP://EXAMPLE.com/docs'),
    'caps <HTTP://EXAMPLE.com/docs>',
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

  const tableWithLiteralBreaks = '| A | B |\n| - | - |\n| one<br>two | three<br />four |';
  assert.strictEqual(
    preprocessMarkdown(tableWithLiteralBreaks, { math: false }),
    tableWithLiteralBreaks,
  );

  console.log('markdown-preprocess: 10 checks PASSED');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
