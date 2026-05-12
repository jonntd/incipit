import { preprocessMarkdownMath } from './math_tokens.js';
import { startHostProbe } from './host_probe.js';
import {
  CFG,
  applyAppVarOverrides,
  applyBodyBoldFlag,
  dbg,
  ensureDomFreeze,
  injectStyles,
  log,
  setupAppVarObserver,
  warn,
  whenDOMReady,
} from './enhance_shared.js';

/**
 * incipit webview bootstrap.
 *
 * Keep this file small and first-paint focused. Heavy behavior now loads from
 * separate modules after the critical attrs/styles are in place. The
 * synchronous markdown math hook stays here: the host react-markdown patch
 * cannot await a lazy import.
 */

(() => {
  'use strict';

  window.__CLAUDE_ENHANCE_PREPROCESS_MARKDOWN__ = CFG.math
    ? preprocessMarkdownMath
    : (raw => raw);

  let footerLoadStarted = false;
  function loadFooterBadge(reason) {
    if (footerLoadStarted) return;
    footerLoadStarted = true;
    dbg('loading footer/badge module:', reason);
    import('./enhance_footer_badge.js')
      .then(mod => {
        if (mod && typeof mod.initFooterBadge === 'function') mod.initFooterBadge();
      })
      .catch(e => warn('enhance_footer_badge.js import failed:', e));
  }

  let thinkingLoadStarted = false;
  function loadThinking(reason) {
    if (thinkingLoadStarted) return;
    thinkingLoadStarted = true;
    dbg('loading thinking module:', reason);
    import('./enhance_thinking.js')
      .then(mod => {
        if (mod && typeof mod.initThinking === 'function') mod.initThinking();
      })
      .catch(e => warn('enhance_thinking.js import failed:', e));
  }

  let typographyLoadStarted = false;
  function loadTypography(reason) {
    if (typographyLoadStarted) return;
    typographyLoadStarted = true;
    dbg('loading typography/code module:', reason);
    import('./enhance_typography.js')
      .then(mod => {
        if (mod && typeof mod.initTypography === 'function') mod.initTypography();
      })
      .catch(e => warn('enhance_typography.js import failed:', e));
  }

  function installRenderTimeCodeHighlighter() {
    if (typeof window.__INCIPIT_HIGHLIGHT_CODE_HTML__ === 'function') return;
    const cache = new Map();
    const MAX_CACHE_ENTRIES = 160;

    function remember(key, value) {
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const first = cache.keys().next().value;
        if (first !== undefined) cache.delete(first);
      }
      cache.set(key, value);
      return value;
    }

    window.__INCIPIT_HIGHLIGHT_CODE_HTML__ = (rawCode, className) => {
      const hljs = window.hljs;
      if (!hljs || typeof hljs.highlight !== 'function') return null;

      const code = String(rawCode ?? '');
      const classes = String(className || '');
      const key = classes + '\u0000' + code;
      if (cache.has(key)) return cache.get(key);

      const match = /\blanguage-([A-Za-z0-9_+.-]+)\b/.exec(classes);
      const language = match && match[1];
      try {
        const result = language && (!hljs.getLanguage || hljs.getLanguage(language))
          ? hljs.highlight(code, { language, ignoreIllegals: true })
          : hljs.highlightAuto(code);
        return remember(key, result && typeof result.value === 'string' ? result.value : null);
      } catch (e) {
        warn('render-time code highlight failed:', e);
        return remember(key, null);
      }
    };
    loadTypography('react-code-render-preload');
  }

  let heavyLoadStarted = false;
  function loadHeavy(reason) {
    if (heavyLoadStarted) return;
    heavyLoadStarted = true;
    dbg('loading heavy module:', reason);
    import('./enhance_legacy.js')
      .catch(e => warn('enhance_legacy.js import failed:', e));
  }

  function scheduleDeferredModules() {
    const run = () => {
      loadFooterBadge('after-critical');
      loadThinking('after-critical');
      loadTypography('after-critical');
      loadHeavy('after-critical');
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  function markCriticalReady() {
    try {
      document.documentElement.setAttribute('data-incipit-critical-ready', '1');
    } catch (_) {}
  }

  function initCritical() {
    log('Initializing bootstrap (theme, host attrs, app vars)...');
    ensureDomFreeze();
    applyAppVarOverrides();
    setupAppVarObserver();
    applyBodyBoldFlag();
    startHostProbe();
    injectStyles();
    installRenderTimeCodeHighlighter();
    markCriticalReady();
    scheduleDeferredModules();
  }

  ensureDomFreeze();
  whenDOMReady(initCritical);
})();
