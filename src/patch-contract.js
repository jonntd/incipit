'use strict';

const INSTALL_MANIFEST_SCHEMA = 1;

function normalizeStatusFromLine(line) {
  const text = String(line || '');
  if (/降级|degraded/i.test(text)) return 'degraded';
  if (/失败|failed|error/i.test(text)) return 'failed';
  if (/跳过|fallback/i.test(text)) return 'degraded';
  if (/上游已容错/.test(text)) return 'upstreamSafe';
  if (/未发现/.test(text)) return 'preExisting';
  return 'patched';
}

function reasonFromStatus(status) {
  switch (status) {
    case 'degraded': return 'degraded';
    case 'failed': return 'failed';
    case 'upstreamSafe': return 'upstream-safe';
    case 'preExisting': return 'pre-existing';
    default: return 'patched';
  }
}

function cleanObject(detail, limit = 12, valueLimit = 160) {
  if (!detail || typeof detail !== 'object') return undefined;
  const out = {};
  for (const key of Object.keys(detail).slice(0, limit)) {
    const value = detail[key];
    if (value == null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = String(value).slice(0, valueLimit);
  }
  return out;
}

function stableTextHash(text) {
  const input = String(text || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function defaultFingerprint(name, line, status) {
  const text = String(line || '');
  const normalizedName = String(name || 'install.unknown');
  return {
    source: text ? 'status-line' : 'explicit-status',
    name: normalizedName,
    status,
    lineHash: stableTextHash(`${normalizedName}:${status}`),
  };
}

function patchContract({
  name,
  layer = 'install',
  line = '',
  status = null,
  priority = 'normal',
  anchorReason = null,
  contractReason = null,
  fingerprint = null,
  detail = null,
}) {
  const normalizedStatus = status || normalizeStatusFromLine(line);
  const reason = contractReason || anchorReason || reasonFromStatus(normalizedStatus);
  const entry = {
    schemaVersion: INSTALL_MANIFEST_SCHEMA,
    name: String(name || 'install.unknown'),
    layer,
    status: normalizedStatus,
    priority: String(priority || 'normal'),
    anchorReason: anchorReason || reason,
    contractReason: contractReason || reason,
  };
  const cleanedFingerprint = cleanObject(
    fingerprint || defaultFingerprint(name, line, normalizedStatus),
    16,
    240,
  );
  if (cleanedFingerprint) entry.fingerprint = cleanedFingerprint;
  const cleaned = cleanObject(detail);
  if (cleaned) entry.detail = cleaned;
  return Object.freeze(entry);
}

function manifestFromPatchContracts(contracts) {
  const entries = [];
  const seen = new Set();
  for (const contract of contracts || []) {
    if (!contract || !contract.name || seen.has(contract.name)) continue;
    seen.add(contract.name);
    entries.push({ ...contract });
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return {
    schemaVersion: INSTALL_MANIFEST_SCHEMA,
    entries,
  };
}

function buildInstallManifestPreamble(contracts) {
  const json = JSON.stringify(manifestFromPatchContracts(contracts));
  return `globalThis.__incipitInstallManifest = Object.freeze(${json});\n`;
}

module.exports = {
  INSTALL_MANIFEST_SCHEMA,
  patchContract,
  manifestFromPatchContracts,
  buildInstallManifestPreamble,
  normalizeStatusFromLine,
};
