import { preprocessMarkdownMath } from './math_tokens.js';

const HTTP_NEEDLE_RE = /https?:\/\//i;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);
const CLOSING_TO_OPENING = Object.freeze({
  ')': '(',
  ']': '[',
  '}': '{',
});
const PREPROCESS_CACHE_MAX_ENTRIES = 96;
const PREPROCESS_CACHE_MAX_CHARS = 2 * 1024 * 1024;
const PREPROCESS_CACHE_MISS = Symbol('incipit-preprocess-cache-miss');

// Send/stop state changes can re-render old assistant markdown. Keep repeated
// handoffs O(1) so URL normalization does not turn each send into a full
// transcript rescan on the UI thread.
const preprocessCache = new Map();
let preprocessCacheChars = 0;

export function preprocessMarkdown(text, options = {}) {
  if (typeof text !== 'string' || !text) return text;
  const math = !!options.math;
  const cached = readPreprocessCache(text, math);
  if (cached !== PREPROCESS_CACHE_MISS) return cached;

  let next = preprocessMarkdownBareUrls(text);
  if (math) next = preprocessMarkdownMath(next);
  rememberPreprocessCache(text, math, next);
  return next;
}

export function preprocessMarkdownBareUrls(text) {
  if (typeof text !== 'string' || !HTTP_NEEDLE_RE.test(text)) return text;

  let out = '';
  let last = 0;
  let i = 0;
  let changed = false;

  while (i < text.length) {
    const fencedEnd = fencedCodeEnd(text, i);
    if (fencedEnd > i) {
      i = fencedEnd;
      continue;
    }

    const codeEnd = inlineCodeEnd(text, i);
    if (codeEnd > i) {
      i = codeEnd;
      continue;
    }

    if (!startsHttpScheme(text, i) || shouldSkipUrlStart(text, i)) {
      i += 1;
      continue;
    }

    const hit = readBareUrl(text, i);
    if (!hit) {
      i += 1;
      continue;
    }

    out += text.slice(last, i) + '<' + hit.url + '>' + hit.suffix;
    last = hit.end;
    i = hit.end;
    changed = true;
  }

  return changed ? out + text.slice(last) : text;
}

function startsHttpScheme(text, i) {
  return startsAsciiFolded(text, i, 'http://') ||
    startsAsciiFolded(text, i, 'https://');
}

function startsAsciiFolded(text, start, needle) {
  if (start + needle.length > text.length) return false;
  for (let i = 0; i < needle.length; i += 1) {
    let actual = text.charCodeAt(start + i);
    const wanted = needle.charCodeAt(i);
    if (actual >= 0x41 && actual <= 0x5A) actual += 0x20;
    if (actual !== wanted) return false;
  }
  return true;
}

function shouldSkipUrlStart(text, i) {
  if (i <= 0) return false;
  const prev = text[i - 1];
  // Do not rewrite existing autolinks, HTML attributes, or markdown link
  // destinations. Bare prose URLs are the only target.
  if (prev === '<' || prev === '"' || prev === "'" || prev === '=' || prev === '(' || prev === '[') {
    return true;
  }
  return /[A-Za-z0-9+.-]/.test(prev);
}

function readBareUrl(text, start) {
  let end = start;
  while (end < text.length && isAsciiUrlChar(text[end])) end += 1;
  if (end <= start) return null;

  const raw = text.slice(start, end);
  const split = splitTrailingUrlSuffix(raw);
  if (!split.url || !looksLikeHttpUrl(split.url)) return null;
  return { url: split.url, suffix: split.suffix, end };
}

function isAsciiUrlChar(ch) {
  if (!ch || /\s/.test(ch)) return false;
  const code = ch.charCodeAt(0);
  if (code < 0x21 || code > 0x7E) return false;
  return ch !== '<' && ch !== '>' && ch !== '"' && ch !== "'" && ch !== '`';
}

function splitTrailingUrlSuffix(raw) {
  let url = raw;
  let suffix = '';

  while (url) {
    const ch = url[url.length - 1];
    if (TRAILING_PUNCTUATION.has(ch) || hasUnmatchedClosing(url, ch)) {
      suffix = ch + suffix;
      url = url.slice(0, -1);
      continue;
    }
    break;
  }

  return { url, suffix };
}

function hasUnmatchedClosing(text, closing) {
  const opening = CLOSING_TO_OPENING[closing];
  if (!opening) return false;

  let balance = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === opening) balance += 1;
    else if (ch === closing) balance -= 1;
  }
  return balance < 0;
}

function looksLikeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.host;
  } catch (_) {
    return false;
  }
}

function fencedCodeEnd(text, i) {
  if (!atMarkdownLineStart(text, i)) return 0;
  const marker = text[i];
  if (marker !== '`' && marker !== '~') return 0;

  let len = 0;
  while (text[i + len] === marker) len += 1;
  if (len < 3) return 0;

  const openLineEnd = lineEndIndex(text, i);
  let pos = openLineEnd < text.length ? openLineEnd + 1 : openLineEnd;
  while (pos < text.length) {
    const end = lineEndIndex(text, pos);
    if (isClosingFenceLine(text, pos, end, marker, len)) {
      return end < text.length ? end + 1 : end;
    }
    pos = end < text.length ? end + 1 : end;
  }
  return text.length;
}

function inlineCodeEnd(text, i) {
  if (text[i] !== '`') return 0;

  let len = 0;
  while (text[i + len] === '`') len += 1;
  let pos = i + len;
  while (pos < text.length) {
    if (text[pos] !== '`') {
      pos += 1;
      continue;
    }
    let closeLen = 0;
    while (text[pos + closeLen] === '`') closeLen += 1;
    if (closeLen === len) return pos + closeLen;
    pos += closeLen;
  }
  return i + 1;
}

function atMarkdownLineStart(text, i) {
  let j = i;
  while (j > 0 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j -= 1;
  return i - j <= 3 && (j === 0 || text[j - 1] === '\n');
}

function lineEndIndex(text, from) {
  const end = text.indexOf('\n', from);
  return end === -1 ? text.length : end;
}

function isClosingFenceLine(text, start, end, marker, minLen) {
  let j = start;
  let indent = 0;
  while (j < end && (text[j] === ' ' || text[j] === '\t') && indent < 3) {
    j += 1;
    indent += 1;
  }

  let len = 0;
  while (j + len < end && text[j + len] === marker) len += 1;
  if (len < minLen) return false;

  let k = j + len;
  while (k < end) {
    if (text[k] !== ' ' && text[k] !== '\t') return false;
    k += 1;
  }
  return true;
}

function readPreprocessCache(text, math) {
  const entry = preprocessCache.get(text);
  const field = math ? 'math' : 'plain';
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, field)) {
    return PREPROCESS_CACHE_MISS;
  }
  preprocessCache.delete(text);
  preprocessCache.set(text, entry);
  return entry[field];
}

function rememberPreprocessCache(text, math, value) {
  if (typeof text !== 'string') return;
  const field = math ? 'math' : 'plain';
  let entry = preprocessCache.get(text);
  if (entry) {
    preprocessCache.delete(text);
    preprocessCacheChars -= entry.__chars || 0;
    if (!Object.prototype.hasOwnProperty.call(entry, field)) {
      entry.__chars += String(value || '').length;
    }
  } else {
    entry = { __chars: text.length + String(value || '').length };
  }
  entry[field] = value;
  preprocessCache.set(text, entry);
  preprocessCacheChars += entry.__chars;
  trimPreprocessCache();
}

function trimPreprocessCache() {
  while (
    preprocessCache.size > PREPROCESS_CACHE_MAX_ENTRIES ||
    preprocessCacheChars > PREPROCESS_CACHE_MAX_CHARS
  ) {
    const first = preprocessCache.keys().next();
    if (first.done) break;
    const entry = preprocessCache.get(first.value);
    preprocessCache.delete(first.value);
    preprocessCacheChars -= entry && entry.__chars ? entry.__chars : 0;
  }
}
