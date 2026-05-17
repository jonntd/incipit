// Raw-mode keyboard loop for interactive menu screens.
//
// The renderer deliberately stays on the terminal's normal screen. We
// do not enter the alternate screen, do not enable mouse tracking, and
// do not draw an in-app scrollbar. That keeps mouse-wheel behavior in
// Windows Terminal / Terminal.app / iTerm2 / GNOME Terminal owned by the
// terminal itself, which is much less fragile than trying to emulate a
// scrollback buffer inside a CLI menu.

'use strict';

const readline = require('readline');
const {
  captureScreenRender,
  supportsTerminalControl,
} = require('./frontispiece');

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const ERASE_VIEWPORT = '\x1b[2J\x1b[H';
const ERASE_VIEWPORT_AND_SCROLLBACK = '\x1b[2J\x1b[3J\x1b[H';
const ERASE_LINE_RIGHT = '\x1b[K';

let activeScreenSession = null;

process.on('exit', () => {
  if (supportsTerminalControl()) process.stdout.write(CURSOR_SHOW);
});

async function withScreenSession(work) {
  if (!supportsTerminalControl() || activeScreenSession) {
    return work();
  }
  activeScreenSession = createScreenRenderer({ clearHistoryOnFirstDraw: true });
  try {
    return await work();
  } finally {
    if (activeScreenSession) {
      activeScreenSession.showCursor();
      activeScreenSession = null;
    }
  }
}

function keyLoop({ render, onKey }) {
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw === true;
    const terminal = supportsTerminalControl();
    const screen = terminal
      ? (activeScreenSession || createScreenRenderer())
      : createDumbRenderer(render);

    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    } catch (_) {}
    process.stdin.resume();
    if (terminal) process.stdout.write(CURSOR_HIDE);

    let finished = false;

    const cleanup = () => {
      process.stdin.removeListener('keypress', handler);
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      } catch (_) {}
      process.stdin.pause();
      if (terminal) process.stdout.write(CURSOR_SHOW);
    };

    const fail = exc => {
      finished = true;
      cleanup();
      reject(exc);
    };

    function handler(str, key) {
      if (finished) return;

      if (key && key.ctrl && key.name === 'c') {
        finished = true;
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }
      if (key && key.ctrl && key.name === 'd') {
        finished = true;
        cleanup();
        resolve({ action: 'back' });
        return;
      }

      if (terminal && key && (key.name === 'pageup' || key.name === 'pagedown')) {
        try {
          screen.scrollPage(key.name === 'pageup' ? -1 : 1);
          renderAndRehide();
        } catch (exc) {
          fail(exc);
        }
        return;
      }

      let outcome;
      try {
        outcome = onKey(str, key);
      } catch (exc) {
        fail(exc);
        return;
      }

      if (outcome && outcome.done) {
        finished = true;
        cleanup();
        resolve(outcome.result);
        return;
      }

      try {
        if (terminal) screen.scrollToFocus();
        renderAndRehide();
      } catch (exc) {
        fail(exc);
      }
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', handler);

    try {
      if (terminal) screen.scrollToFocus();
      renderAndRehide();
    } catch (exc) {
      fail(exc);
    }

    function renderAndRehide() {
      screen.draw(render);
      if (terminal) process.stdout.write(CURSOR_HIDE);
    }
  });
}

function invalidateScreenSession(options = {}) {
  if (!activeScreenSession || typeof activeScreenSession.reset !== 'function') {
    return false;
  }
  activeScreenSession.reset(options);
  return true;
}

function createDumbRenderer(render) {
  let painted = false;
  return {
    draw: () => {
      if (painted) return;
      painted = true;
      render();
    },
  };
}

function createScreenRenderer(options = {}) {
  let lastLines = null;
  let scrollOffset = 0;
  let preferFocus = true;
  let lastScrollRows = 8;
  let eraseForNextFullPaint = options.clearHistoryOnFirstDraw
    ? ERASE_VIEWPORT_AND_SCROLLBACK
    : ERASE_VIEWPORT;

  const reset = (resetOptions = {}) => {
    lastLines = null;
    scrollOffset = 0;
    preferFocus = true;
    process.stdout.write((resetOptions.history ? ERASE_VIEWPORT_AND_SCROLLBACK : ERASE_VIEWPORT) + CURSOR_SHOW);
    eraseForNextFullPaint = resetOptions.history
      ? ERASE_VIEWPORT_AND_SCROLLBACK
      : ERASE_VIEWPORT;
  };

  const draw = render => {
    const frame = captureScreenRender(render);
    const materialized = materializeFrame(splitScreenLines(frame.text), frame.scrollRegion, {
      scrollOffset,
      preferFocus,
      lastScrollRows,
    });
    const nextLines = materialized.lines;
    scrollOffset = materialized.scrollOffset;
    lastScrollRows = materialized.scrollRows || lastScrollRows;

    if (lastLines == null) {
      process.stdout.write(eraseForNextFullPaint + nextLines.join('\r\n'));
      eraseForNextFullPaint = ERASE_VIEWPORT;
      lastLines = nextLines;
      return;
    }

    const max = Math.max(lastLines.length, nextLines.length);
    const out = [];
    for (let i = 0; i < max; i += 1) {
      const prev = lastLines[i] || '';
      const next = nextLines[i] || '';
      if (prev === next) continue;
      out.push(moveTo(i + 1, 1), next, ERASE_LINE_RIGHT);
    }
    if (out.length) process.stdout.write(out.join(''));
    lastLines = nextLines;
  };

  const scrollBy = delta => {
    scrollOffset += delta;
    preferFocus = false;
  };

  const scrollPage = direction => {
    scrollBy(direction * Math.max(1, lastScrollRows - 1));
  };

  const scrollToFocus = () => {
    preferFocus = true;
  };

  const showCursor = () => {
    process.stdout.write(CURSOR_SHOW);
  };

  return { draw, reset, scrollPage, scrollToFocus, showCursor };
}

function materializeFrame(lines, scrollRegion, state) {
  const rows = viewportRows();
  if (!Number.isFinite(rows) || rows <= 0) {
    return { lines, scrollOffset: 0, scrollRows: lines.length };
  }
  if (
    !scrollRegion ||
    !Number.isInteger(scrollRegion.start) ||
    !Number.isInteger(scrollRegion.end) ||
    scrollRegion.start < 0 ||
    scrollRegion.end > lines.length ||
    scrollRegion.end <= scrollRegion.start
  ) {
    return { lines: fitToViewport(lines), scrollOffset: 0, scrollRows: rows };
  }

  const top = lines.slice(0, scrollRegion.start);
  const body = lines.slice(scrollRegion.start, scrollRegion.end);
  const bottom = lines.slice(scrollRegion.end);
  const scrollRows = rows - top.length - bottom.length;

  if (scrollRows < 1) {
    return { lines: fitToViewport(lines), scrollOffset: 0, scrollRows: rows };
  }

  const maxOffset = Math.max(0, body.length - scrollRows);
  let nextOffset = clampInt(state.scrollOffset || 0, 0, maxOffset);

  if (state.preferFocus) {
    const focusLine = findFocusLine(lines);
    if (focusLine >= scrollRegion.start && focusLine < scrollRegion.end) {
      const focusInBody = focusLine - scrollRegion.start;
      if (focusInBody < nextOffset) {
        nextOffset = focusInBody;
      } else if (focusInBody >= nextOffset + scrollRows) {
        nextOffset = focusInBody - scrollRows + 1;
      }
      nextOffset = clampInt(nextOffset, 0, maxOffset);
    }
  }

  const bodySlice = body.slice(nextOffset, nextOffset + scrollRows);
  const filler = new Array(Math.max(0, rows - top.length - bodySlice.length - bottom.length)).fill('');
  return {
    lines: [
      ...top,
      ...bodySlice,
      ...filler,
      ...bottom,
    ],
    scrollOffset: nextOffset,
    scrollRows,
  };
}

function findFocusLine(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (stripAnsi(lines[i]).includes('›')) return i;
  }
  return -1;
}

function splitScreenLines(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized) return [];
  const withoutFinalBlank = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutFinalBlank ? withoutFinalBlank.split('\n') : [];
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function moveTo(row, col) {
  return `\x1b[${row};${col}H`;
}

function fitToViewport(lines) {
  const rows = viewportRows();
  if (!rows || lines.length <= rows) return lines;
  return lines.slice(0, rows);
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(max, Math.max(min, n));
}

function viewportRows() {
  const rows = process.stdout && process.stdout.rows;
  return Number.isFinite(rows) && rows > 0 ? rows : Infinity;
}

// Live progress loop: repaint `render()` on a timer while `task()` runs,
// and let ANY key cancel. Used for the deep scan — the user must see
// scrolling progress and be able to stop the moment they see what they
// want. `task` receives `{ isCancelled }` and is expected to poll it (the
// engine also enforces its own hard deadline). Resolves
// `{ cancelled, result }` when the task settles. Raw-mode / cursor
// teardown mirrors keyLoop exactly so the terminal is always restored.
function liveLoop({ task, render, intervalMs = 120 }) {
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw === true;
    const terminal = supportsTerminalControl();
    const screen = terminal
      ? (activeScreenSession || createScreenRenderer())
      : createDumbRenderer(render);

    let finished = false;
    let cancelled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearInterval(timer); timer = null; }
      process.stdin.removeListener('keypress', handler);
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      } catch (_) {}
      process.stdin.pause();
      if (terminal) process.stdout.write(CURSOR_SHOW);
    };
    const settle = (fn, val) => {
      if (finished) return;
      finished = true;
      cleanup();
      fn(val);
    };

    function handler(str, key) {
      if (finished) return;
      if (key && key.ctrl && key.name === 'c') {
        finished = true;
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      }
      // Any other key = "stop now, take what you have".
      cancelled = true;
    }

    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    } catch (_) {}
    process.stdin.resume();
    if (terminal) process.stdout.write(CURSOR_HIDE);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', handler);

    const paint = () => {
      try {
        screen.draw(render);
        if (terminal) process.stdout.write(CURSOR_HIDE);
      } catch (exc) {
        settle(reject, exc);
      }
    };

    paint();
    timer = setInterval(paint, intervalMs);

    Promise.resolve()
      .then(() => task({ isCancelled: () => cancelled }))
      .then(result => { paint(); settle(resolve, { cancelled, result }); })
      .catch(exc => settle(reject, exc));
  });
}

module.exports = { keyLoop, liveLoop, withScreenSession, invalidateScreenSession };
