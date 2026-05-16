import { reportCapability, bumpPerfCounter } from './runtime_kernel.js';

const INSTALL_STATUS_HEALTH = Object.freeze({
  patched: 'ok',
  preExisting: 'ok',
  upstreamSafe: 'ok',
  degraded: 'degraded',
  failed: 'degraded',
});

const MISS_REASONS = new Set([
  'notMounted',
  'noFiber',
  'shapeMiss',
  'notApplicable',
  'error',
  'stale',
]);

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail == null ? null : { value: String(detail).slice(0, 160) };
  const out = {};
  for (const key of Object.keys(detail).slice(0, 12)) {
    const value = detail[key];
    if (value == null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = String(value).slice(0, 160);
  }
  return out;
}

let installManifestPublished = false;

function publishInstallManifestCapabilities() {
  if (installManifestPublished) return;
  installManifestPublished = true;
  const manifest = globalThis.__incipitInstallManifest;
  const entries = manifest && Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    const installStatus = String(entry.status || 'patched');
    const status = INSTALL_STATUS_HEALTH[installStatus] || 'pending';
    reportCapability(entry.name, status, {
      layer: entry.layer || 'install',
      installStatus,
      priority: entry.priority || 'normal',
      reason: entry.contractReason || entry.anchorReason || installStatus,
      fingerprint: safeDetail(entry.fingerprint),
      detail: safeDetail(entry.detail),
      manifestSchemaVersion: entry.schemaVersion || manifest.schemaVersion || 0,
    });
  }
}

function scheduleInstallManifestPublish() {
  const publish = () => {
    try { publishInstallManifestCapabilities(); } catch (_) {}
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(publish);
  else Promise.resolve().then(publish).catch(() => {});
}

function errorDetail(error) {
  return {
    message: error && error.message ? error.message : String(error || 'unknown error'),
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      value: null,
      reason: 'error',
      detail: { message: 'probe returned no ProbeResult' },
    };
  }
  if (result.ok === true) {
    return {
      ok: true,
      value: result.value,
      reason: 'ok',
      detail: safeDetail(result.detail),
    };
  }
  const reason = MISS_REASONS.has(result.reason) ? result.reason : 'error';
  return {
    ok: false,
    value: null,
    reason,
    detail: safeDetail(result.detail),
  };
}

export function defineCapability({
  name,
  layer,
  presence = 'always',
  probe,
  shapeValidate,
  staleAfterMs = 0,
  hysteresisFails = 3,
  hysteresisWindowMs = 500,
  warmupMs = 5000,
}) {
  if (typeof probe !== 'function') {
    throw new TypeError('defineCapability requires a probe function');
  }
  const id = String(name || `runtime.${layer || 'unknown'}.unknown`);
  const startAt = nowMs();
  let status = 'pending';
  let lastReason = null;
  let lastDetail = null;
  let lastReadAt = 0;
  let ok = 0;
  let fails = 0;
  let failWindowStartedAt = 0;
  let hasSeenOk = false;
  let cacheResult = null;
  let cacheAt = 0;

  function publish(nextStatus, result) {
    status = nextStatus;
    lastReason = result.reason;
    lastDetail = result.detail || null;
    reportCapability(id, status, {
      reason: lastReason,
      lastDetail,
    });
  }

  function pending(result) {
    fails = 0;
    failWindowStartedAt = 0;
    publish('pending', result);
  }

  function pass(result) {
    ok++;
    hasSeenOk = true;
    fails = 0;
    failWindowStartedAt = 0;
    cacheResult = result;
    cacheAt = lastReadAt;
    publish('ok', result);
  }

  function miss(result) {
    if (result.reason === 'notMounted' || result.reason === 'notApplicable' || result.reason === 'stale') {
      pending(result);
      return;
    }
    if (presence === 'optional') {
      pending({ ...result, reason: result.reason || 'notApplicable' });
      return;
    }
    if (presence === 'afterSeen' && !hasSeenOk) {
      pending(result);
      return;
    }
    if (lastReadAt - startAt < warmupMs) {
      pending(result);
      return;
    }
    if (!failWindowStartedAt || lastReadAt - failWindowStartedAt > hysteresisWindowMs) {
      failWindowStartedAt = lastReadAt;
      fails = 1;
    } else {
      fails++;
    }
    publish(fails >= hysteresisFails ? 'degraded' : 'pending', result);
  }

  function read(ctx) {
    lastReadAt = nowMs();
    if (cacheResult && staleAfterMs > 0 && lastReadAt - cacheAt <= staleAfterMs) {
      bumpPerfCounter(`capability.${id}.ok`);
      return cacheResult;
    }

    let result;
    try {
      result = normalizeResult(probe(ctx));
    } catch (error) {
      result = {
        ok: false,
        value: null,
        reason: 'error',
        detail: errorDetail(error),
      };
    }

    if (result.ok && typeof shapeValidate === 'function') {
      let valid = false;
      try { valid = shapeValidate(result.value) === true; }
      catch (error) {
        result = {
          ok: false,
          value: null,
          reason: 'error',
          detail: { via: 'shapeValidate', ...errorDetail(error) },
        };
      }
      if (result.ok && !valid) {
        result = {
          ok: false,
          value: null,
          reason: 'shapeMiss',
          detail: { via: 'shapeValidate' },
        };
      }
    }

    bumpPerfCounter(`capability.${id}.${result.reason}`);
    if (result.ok) pass(result);
    else miss(result);
    return result;
  }

  function state() {
    return {
      status,
      lastReason,
      ok,
      fails,
      lastReadAt,
      lastDetail,
    };
  }

  function invalidate() {
    cacheResult = null;
    cacheAt = 0;
  }

  return { read, state, invalidate };
}

scheduleInstallManifestPublish();
