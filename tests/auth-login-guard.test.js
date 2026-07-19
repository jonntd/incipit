'use strict';

/**
 * Source + behavioral contracts for mid-turn authentication_failed login wall.
 *
 * Host webview (Claude Code index.js):
 *   processMessage: error==="authentication_failed" → context.showLogin()
 *   showLogin: authStatus=null; forceLogin=true → full-page login unmounts transcript
 *
 * incipit must:
 *   · wrap session.processMessage + context.showLogin
 *   · swallow only the mid-turn authentication_failed path
 *   · keep intentional /login + cold-start login working
 *   · reclaim a sticky forceLogin when account still has token/subscription
 *   · surface a non-blocking auth banner instead of the login wall
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const legacy = fs.readFileSync(path.join(root, 'data', 'enhance_legacy.js'), 'utf8');
const emptyCss = fs.readFileSync(path.join(root, 'data', 'ui', 'empty-state.css'), 'utf8');
const warm = fs.readFileSync(path.join(root, 'data', 'warm-white-override.css'), 'utf8');

let passed = 0;
function ok(name) {
  console.log('  ok  ' + name);
  passed++;
}

function functionBody(name, span = 2400) {
  const idx = legacy.indexOf('function ' + name);
  assert.ok(idx >= 0, 'missing function ' + name);
  return legacy.slice(idx, idx + span);
}

(function sourceContracts() {
  assert.ok(legacy.includes('function setupAuthLoginGuard'));
  assert.ok(legacy.includes('function wrapShowLoginOnContext'));
  assert.ok(legacy.includes('function wrapAuthGuardOnSession'));
  assert.ok(legacy.includes('function reclaimForcedLoginIfStillAuthed'));
  assert.ok(legacy.includes("e.error === 'authentication_failed'"));
  assert.ok(legacy.includes('authGuardSuppressLogin'));
  assert.ok(legacy.includes('incipitAuthLoginGuardShowLogin'));
  assert.ok(legacy.includes('incipitAuthLoginGuardProcessMessage'));
  assert.ok(legacy.includes("reportHealth('legacy.auth_login_guard', 'ok')"));
  assert.ok(legacy.includes('setupAuthLoginGuard()'));
  assert.ok(legacy.includes('setupAuthLoginGuard,'));
  assert.ok(legacy.includes("kind = 'auth'") || legacy.includes("kind === 'auth'"));
  assert.ok(legacy.includes('markSurfaceAuthFailed'));
  assert.ok(legacy.includes('authTitle'));
  assert.ok(emptyCss.includes('data-incipit-surface-state="auth"'));
  assert.ok(warm.includes('data-incipit-surface-state="auth"'));
  ok('source: wrap + init + auth banner CSS');
})();

(function processMessageOnlySuppressesAuthFailed() {
  const body = functionBody('wrapAuthGuardOnSession', 900);
  assert.ok(body.includes("e.type === 'assistant'"));
  assert.ok(body.includes("e.error === 'authentication_failed'"));
  assert.ok(body.includes('authGuardSuppressLogin = true'));
  assert.ok(body.includes('finally'));
  assert.ok(body.includes('authGuardSuppressLogin = false'));
  ok('processMessage suppress is scoped to authentication_failed');
})();

(function showLoginHonorsSuppressFlagOnly() {
  const body = functionBody('wrapShowLoginOnContext', 700);
  assert.ok(body.includes('if (authGuardSuppressLogin)'));
  assert.ok(body.includes('notifyAuthFailureInline()'));
  assert.ok(body.includes('return original.apply(this, args)'));
  ok('showLogin only no-ops under suppress flag');
})();

(function reclaimDoesNotClearColdStart() {
  const body = functionBody('reclaimForcedLoginIfStillAuthed', 600);
  assert.ok(body.includes('accountLooksAuthenticated'));
  assert.ok(body.includes('forceLogin.value = false'));
  // Must require account evidence before clearing forceLogin.
  assert.ok(body.includes('if (!accountLooksAuthenticated'));
  ok('reclaim requires account token/subscription evidence');
})();

// ---- Behavioral unit tests (isolated helpers, no full enhance load) ----

(async function main() {
  let showLoginCalls = 0;
  let notified = 0;
  let suppress = false;
  const ctx = {
    showLogin: async function () { showLoginCalls++; },
    forceLogin: { value: false },
  };
  const originalShow = ctx.showLogin;
  ctx.showLogin = async function (...args) {
    if (suppress) {
      notified++;
      return;
    }
    return originalShow.apply(this, args);
  };

  suppress = true;
  await ctx.showLogin();
  assert.strictEqual(showLoginCalls, 0, 'suppressed path must not call host showLogin');
  assert.strictEqual(notified, 1);
  suppress = false;
  await ctx.showLogin();
  assert.strictEqual(showLoginCalls, 1, 'intentional login must still reach host');
  ok('behavior: suppress mid-turn, allow intentional login');

  let sawSuppressDuring = false;
  suppress = false;
  const session = {
    processMessage(e) {
      if (suppress) sawSuppressDuring = true;
      if (e && e.error === 'authentication_failed') {
        // host would call showLogin here; our outer wrap sets suppress first
      }
    },
  };
  const originalPm = session.processMessage;
  session.processMessage = function (e) {
    if (e && e.type === 'assistant' && e.error === 'authentication_failed') {
      suppress = true;
      try {
        return originalPm.apply(this, arguments);
      } finally {
        suppress = false;
      }
    }
    return originalPm.apply(this, arguments);
  };

  session.processMessage({ type: 'assistant', error: 'authentication_failed' });
  assert.strictEqual(sawSuppressDuring, true);
  assert.strictEqual(suppress, false, 'suppress must clear in finally');
  sawSuppressDuring = false;
  session.processMessage({ type: 'assistant', error: 'rate_limit' });
  assert.strictEqual(sawSuppressDuring, false);
  ok('behavior: processMessage suppress window is finally-cleared');

  function accountLooksAuthenticated(account) {
    if (!account || typeof account !== 'object') return false;
    if (account.tokenSource && account.tokenSource !== 'none') return true;
    if (account.subscriptionType) return true;
    return false;
  }
  function reclaim(ctxObj, account) {
    if (!ctxObj || !ctxObj.forceLogin) return false;
    if (ctxObj.forceLogin.value !== true) return false;
    if (!accountLooksAuthenticated(account)) return false;
    ctxObj.forceLogin.value = false;
    return true;
  }

  const cold = { forceLogin: { value: true } };
  assert.strictEqual(reclaim(cold, { tokenSource: 'none' }), false);
  assert.strictEqual(cold.forceLogin.value, true);

  const sticky = { forceLogin: { value: true } };
  assert.strictEqual(reclaim(sticky, { tokenSource: 'claudeai', subscriptionType: 'pro' }), true);
  assert.strictEqual(sticky.forceLogin.value, false);

  const none = { forceLogin: { value: true } };
  assert.strictEqual(reclaim(none, null), false);
  assert.strictEqual(none.forceLogin.value, true);
  ok('behavior: reclaim only when account still authenticated');

  console.log('\n' + passed + ' checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
