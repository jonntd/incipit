// Host installation detection.
//
// Builds a candidate list of "places where a Claude Code extension might
// live" across VS Code-family hosts and portable layouts. A candidate
// becomes an auto target only when an `anthropic.claude-code-*` directory is
// actually present under its extensions root.
//
// The important invariant is that every candidate carries both halves of the
// target: `extensionsDir` (where the Claude Code extension bundle is patched)
// and `settingsPath` (where incipit writes the chat input font settings).
//
// Also exports `identifyFolder(picked)`, used by the manual "+ add target"
// wizard. Accepted shapes: a single `anthropic.claude-code-*` version
// directory, an extensions root, a portable `data/` directory, a portable
// install root containing `data/`, and the "unknown" sentinel.
//
// This module is filesystem-only. No network, no shelling out. The OS folder
// dialog itself lives in `file-dialog.js`.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_CODE_EXTENSION_PREFIX = 'anthropic.claude-code-';

// ============================================================
// host descriptors
// ============================================================

// VS Code-family products that can host VS Code extensions. The `homeNames`
// field describes the standard extensions root under the user's home, while
// `appDataNames` describes the matching user-data/settings root.
//
// `scoopApps` are package ids used by Scoop buckets. Scoop's VS Code-family
// packages are usually portable archives with data under either
// `<scoop>/persist/<app>/data` or `<scoop>/apps/<app>/current/data`.
const HOSTS = Object.freeze([
  {
    id: 'vscode',
    label: 'VS Code',
    homeNames: ['.vscode'],
    appDataNames: ['Code'],
    binNames: ['Code.exe', 'code.exe', 'code'],
    scoopApps: ['vscode'],
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    homeNames: ['.vscode-insiders'],
    appDataNames: ['Code - Insiders'],
    binNames: ['Code - Insiders.exe', 'code-insiders.exe', 'code-insiders'],
    scoopApps: ['vscode-insiders'],
  },
  {
    id: 'vscodium',
    label: 'VSCodium',
    homeNames: ['.vscode-oss'],
    appDataNames: ['VSCodium'],
    binNames: ['VSCodium.exe', 'vscodium.exe', 'codium.exe', 'codium'],
    scoopApps: ['vscodium'],
  },
  {
    id: 'code-oss',
    label: 'Code - OSS',
    homeNames: ['.vscode-oss'],
    appDataNames: ['Code - OSS'],
    binNames: ['Code - OSS.exe', 'code-oss.exe', 'code-oss'],
    scoopApps: ['code-oss'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    homeNames: ['.cursor'],
    appDataNames: ['Cursor'],
    binNames: ['Cursor.exe', 'cursor.exe', 'cursor'],
    scoopApps: ['cursor'],
  },
  {
    id: 'cursor-insiders',
    label: 'Cursor Insiders',
    homeNames: ['.cursor-insiders'],
    appDataNames: ['Cursor - Insiders'],
    binNames: ['Cursor - Insiders.exe', 'cursor-insiders.exe', 'cursor-insiders'],
    scoopApps: ['cursor-insiders'],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    homeNames: ['.windsurf'],
    appDataNames: ['Windsurf'],
    binNames: ['Windsurf.exe', 'windsurf.exe', 'windsurf'],
    scoopApps: ['windsurf'],
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    homeNames: ['.antigravity-ide', '.antigravity'],
    appDataNames: ['Antigravity IDE', 'Antigravity'],
    lowercaseAppDataFallback: true,
    binNames: ['Antigravity IDE.exe', 'Antigravity.exe', 'antigravity-ide.exe', 'antigravity.exe', 'antigravity-ide', 'antigravity'],
    scoopApps: ['antigravity'],
  },
  {
    id: 'trae',
    label: 'Trae',
    homeNames: ['.trae'],
    appDataNames: ['Trae'],
    lowercaseAppDataFallback: true,
    binNames: ['Trae.exe', 'trae.exe', 'trae'],
    scoopApps: ['trae'],
  },
  {
    id: 'trae-cn',
    label: 'Trae CN',
    homeNames: ['.trae-cn'],
    appDataNames: ['Trae CN'],
    lowercaseAppDataFallback: true,
    binNames: ['Trae CN.exe', 'trae-cn.exe', 'trae-cn'],
    scoopApps: ['trae-cn'],
  },
  {
    id: 'kiro',
    label: 'Kiro',
    homeNames: ['.kiro'],
    appDataNames: ['Kiro'],
    lowercaseAppDataFallback: true,
    binNames: ['Kiro.exe', 'kiro.exe', 'kiro'],
    scoopApps: ['kiro'],
  },
]);

const HOSTS_BY_HOME_NAME = buildHostsByHomeName();
const SCOOP_HOST_BY_APP = buildScoopHostMap();
const ALL_BIN_NAMES = Object.freeze(unique(
  HOSTS.flatMap(host => host.binNames || []),
));

function buildHostsByHomeName() {
  const out = new Map();
  for (const host of HOSTS) {
    for (const homeName of host.homeNames || []) {
      if (!out.has(homeName)) out.set(homeName, []);
      out.get(homeName).push(host);
    }
  }
  return out;
}

function buildScoopHostMap() {
  const out = new Map();
  for (const host of HOSTS) {
    for (const app of host.scoopApps || []) {
      if (!out.has(app)) out.set(app, host);
    }
  }
  return out;
}

// ============================================================
// platform-default settings.json paths
// ============================================================

function userAppDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function settingsPathForAppDataName(appDataName) {
  return path.join(userAppDataDir(), appDataName, 'User', 'settings.json');
}

function appDataRootCandidatesForHost(host) {
  const appDataRoot = userAppDataDir();
  const roots = [];
  for (const appDataName of host.appDataNames || []) {
    roots.push(path.join(appDataRoot, appDataName));
    if (host.lowercaseAppDataFallback || process.platform !== 'win32') {
      const lower = appDataName.toLowerCase();
      if (lower !== appDataName) roots.push(path.join(appDataRoot, lower));
    }
  }
  return unique(roots);
}

function settingsPathForHost(host) {
  const roots = appDataRootCandidatesForHost(host);
  for (const root of roots) {
    try {
      if (fs.existsSync(root)) return path.join(root, 'User', 'settings.json');
    } catch (_) {}
  }
  return roots.length ? path.join(roots[0], 'User', 'settings.json') : null;
}

function settingsPathForAntigravity() {
  const host = HOSTS.find(h => h.id === 'antigravity');
  return host ? settingsPathForHost(host) : settingsPathForAppDataName('Antigravity');
}

function firstExistingAppDataRoot(host) {
  for (const root of appDataRootCandidatesForHost(host)) {
    try {
      if (fs.existsSync(root)) return root;
    } catch (_) {}
  }
  return null;
}

// Shared extension roots need special handling. VSCodium and Code - OSS both
// conventionally use `~/.vscode-oss/extensions`, but their settings live under
// different app-data roots. If exactly one matching app-data root exists, show
// that one. If neither exists yet, keep only the first descriptor so auto-detect
// does not manufacture two rows for a single fresh install.
function selectHostsForHomeName(homeName, hosts) {
  if (hosts.length <= 1) return hosts;
  const existing = hosts.filter(host => firstExistingAppDataRoot(host));
  return existing.length ? existing : [hosts[0]];
}

// ============================================================
// candidate lists
// ============================================================

function standardCandidates() {
  const home = os.homedir();
  const list = [];
  for (const [homeName, hosts] of HOSTS_BY_HOME_NAME.entries()) {
    for (const host of selectHostsForHomeName(homeName, hosts)) {
      list.push({
        label: host.label,
        extensionsDir: path.join(home, homeName, 'extensions'),
        settingsPath: settingsPathForHost(host),
        source: 'auto',
        kind: 'standard',
      });
    }
  }
  return [...list, ...appDataExtensionCandidates()];
}

// Some VS Code-family builds and community packages store extensions directly
// under the app-data/config root instead of the home root. Keep this as a
// low-priority fallback. It only surfaces when a Claude Code extension is
// actually present there.
function appDataExtensionCandidates() {
  const out = [];
  const seen = new Set();
  for (const host of HOSTS) {
    for (const root of appDataRootCandidatesForHost(host)) {
      const key = canonicalExistingPath(root);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        label: `${host.label} (app data)`,
        extensionsDir: path.join(root, 'extensions'),
        settingsPath: path.join(root, 'User', 'settings.json'),
        source: 'auto',
        kind: 'standard',
      });
    }
  }
  return out;
}

// Portable layouts: a single `data/` directory with `extensions/` and
// `user-data/User/settings.json` siblings under it. Official zip portable
// VS Code uses a `data/` folder next to the executable. Scoop's VS Code-family
// packages persist the same `data/` shape under the Scoop root.
function portableCandidates() {
  const list = [];

  // $VSCODE_PORTABLE is the official portable data indicator for VS Code.
  if (process.env.VSCODE_PORTABLE) {
    list.push(portableDataCandidate(
      'VS Code (portable, $VSCODE_PORTABLE)',
      process.env.VSCODE_PORTABLE,
    ));
  }

  list.push(...scoopPortableCandidates());

  return list;
}

function portableDataCandidate(label, portableDataDir) {
  return {
    label,
    extensionsDir: path.join(portableDataDir, 'extensions'),
    settingsPath: path.join(portableDataDir, 'user-data', 'User', 'settings.json'),
    source: 'auto',
    kind: 'portable',
  };
}

function scoopPortableCandidates() {
  const out = [];
  const seenDataDirs = new Set();
  for (const root of scoopRoots()) {
    for (const app of SCOOP_HOST_BY_APP.keys()) {
      addScoopAppDataCandidates(out, seenDataDirs, root, app, SCOOP_HOST_BY_APP.get(app));
    }
    addGenericScoopDataCandidates(out, seenDataDirs, root);
  }
  return out;
}

function scoopRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.SCOOP) roots.push(process.env.SCOOP);
  roots.push(path.join(home, 'scoop'));
  if (process.env.SCOOP_GLOBAL) roots.push(process.env.SCOOP_GLOBAL);
  if (process.env.PROGRAMDATA) roots.push(path.join(process.env.PROGRAMDATA, 'scoop'));
  return unique(roots).filter(Boolean);
}

function addScoopAppDataCandidates(out, seenDataDirs, root, app, host) {
  const label = host ? `${host.label} (Scoop portable)` : `Scoop portable (${app})`;
  addPortableDataIfNew(out, seenDataDirs, label, path.join(root, 'persist', app, 'data'));
  addPortableDataIfNew(out, seenDataDirs, label, path.join(root, 'apps', app, 'current', 'data'));

  // Some Scoop installs may not have a `current` junction/link at the moment
  // we scan (partial install, broken shim, restored backup). If versioned app
  // directories contain `data/`, keep them as fallbacks. They dedupe via
  // realpath when `current` points at the same place.
  const appRoot = path.join(root, 'apps', app);
  for (const child of safeReadDir(appRoot)) {
    if (child === 'current') continue;
    addPortableDataIfNew(out, seenDataDirs, label, path.join(appRoot, child, 'data'));
  }
}

function addGenericScoopDataCandidates(out, seenDataDirs, root) {
  const persistRoot = path.join(root, 'persist');
  for (const app of safeReadDir(persistRoot)) {
    const host = SCOOP_HOST_BY_APP.get(app);
    const label = host ? `${host.label} (Scoop portable)` : `Scoop portable (${app})`;
    addPortableDataIfNew(out, seenDataDirs, label, path.join(persistRoot, app, 'data'));
  }

  const appsRoot = path.join(root, 'apps');
  for (const app of safeReadDir(appsRoot)) {
    const host = SCOOP_HOST_BY_APP.get(app);
    const label = host ? `${host.label} (Scoop portable)` : `Scoop portable (${app})`;
    addPortableDataIfNew(out, seenDataDirs, label, path.join(appsRoot, app, 'current', 'data'));
    for (const child of safeReadDir(path.join(appsRoot, app))) {
      if (child === 'current') continue;
      addPortableDataIfNew(out, seenDataDirs, label, path.join(appsRoot, app, child, 'data'));
    }
  }
}

function addPortableDataIfNew(out, seenDataDirs, label, dataDir) {
  const key = canonicalExistingPath(dataDir);
  if (seenDataDirs.has(key)) return;
  seenDataDirs.add(key);
  out.push(portableDataCandidate(label, dataDir));
}

function allCandidates() {
  return [...standardCandidates(), ...portableCandidates()];
}

// ============================================================
// extension scanning
// ============================================================

// List the `anthropic.claude-code-*` directories under `extensionsDir`,
// sorted by parsed semantic version then by mtime. Returns `[]` if the
// directory doesn't exist or contains no match.
function scanClaudeCodeExtensions(extensionsDir) {
  if (!extensionsDir || !fs.existsSync(extensionsDir)) return [];
  let names;
  try {
    names = fs.readdirSync(extensionsDir);
  } catch (_) {
    return [];
  }
  const candidates = [];
  for (const n of names) {
    if (!n.startsWith(CLAUDE_CODE_EXTENSION_PREFIX)) continue;
    const full = path.join(extensionsDir, n);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    candidates.push({
      name: n,
      path: full,
      version: parseVersion(n),
      mtimeMs: stat.mtimeMs,
    });
  }
  candidates.sort((a, b) => {
    const cmp = compareVersionTuples(a.version, b.version);
    if (cmp !== 0) return cmp;
    return a.mtimeMs - b.mtimeMs;
  });
  return candidates;
}

function parseVersion(dirName) {
  const m = dirName.match(/^anthropic\.claude-code-(\d+(?:\.\d+)+)/);
  if (!m) return [];
  return m[1].split('.').map(x => parseInt(x, 10));
}

function compareVersionTuples(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? 0 : a[i];
    const bv = b[i] === undefined ? 0 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ============================================================
// auto-detect
// ============================================================

function detectAutoTargets() {
  const out = [];
  const seen = new Set();
  for (const c of allCandidates()) {
    const exts = scanClaudeCodeExtensions(c.extensionsDir);
    if (!exts.length) continue;

    // Dedup on the full target pair. Two products can share the same
    // extensions root while still requiring different User/settings.json
    // files (notably VSCodium vs Code - OSS).
    const key = targetDedupKey(c.extensionsDir, c.settingsPath);
    if (seen.has(key)) continue;
    seen.add(key);

    const latest = exts[exts.length - 1];
    out.push({
      label: c.label,
      extensionsDir: c.extensionsDir,
      settingsPath: c.settingsPath,
      latestVersion: latest.version.join('.') || 'unknown',
      latestExtName: latest.name,
      source: 'auto',
    });
  }
  return out;
}

// ============================================================
// identify a user-picked folder
// ============================================================

// Return shape: { kind, extensionsDir?, settingsPath?, latestVersion?,
// latestExtName?, hint?, recoverable? }
//
// `recoverable` flags a diagnostic state: the picked path looks like a VS
// Code-family program install directory but no `data/` sibling exists. In
// standard mode, extensions live under the user profile, not next to the
// binary, so the UI explains the correct folder shape.
function identifyFolder(picked) {
  if (!picked || !fs.existsSync(picked)) {
    return { kind: 'unknown', hint: 'path-missing' };
  }
  let stat;
  try { stat = fs.statSync(picked); } catch (_) {
    return { kind: 'unknown', hint: 'path-stat-failed' };
  }
  if (!stat.isDirectory()) {
    return { kind: 'unknown', hint: 'not-a-directory' };
  }

  const base = path.basename(picked);

  // Layer 1: a single anthropic.claude-code-* version directory.
  if (base.startsWith(CLAUDE_CODE_EXTENSION_PREFIX) &&
      fs.existsSync(path.join(picked, 'extension.js')) &&
      isDir(path.join(picked, 'webview'))) {
    const extensionsDir = path.dirname(picked);
    const version = parseVersion(base).join('.') || 'unknown';
    return {
      kind: 'extension_version',
      extensionsDir,
      settingsPath: deriveSettingsPathFromExtensionsDir(extensionsDir),
      latestVersion: version,
      latestExtName: base,
    };
  }

  // Layer 2: an extensions directory containing one or more matches.
  const exts = scanClaudeCodeExtensions(picked);
  if (exts.length) {
    const latest = exts[exts.length - 1];
    return {
      kind: 'extensions_dir',
      extensionsDir: picked,
      settingsPath: deriveSettingsPathFromExtensionsDir(picked),
      latestVersion: latest.version.join('.') || 'unknown',
      latestExtName: latest.name,
    };
  }

  // Layer 3: portable data directory, with `extensions/` and `user-data/`.
  if (isPortableDataDir(picked)) {
    const extensionsDir = path.join(picked, 'extensions');
    const settingsPath = path.join(picked, 'user-data', 'User', 'settings.json');
    const portableExts = scanClaudeCodeExtensions(extensionsDir);
    if (portableExts.length) {
      const latest = portableExts[portableExts.length - 1];
      return {
        kind: 'portable_data',
        extensionsDir,
        settingsPath,
        latestVersion: latest.version.join('.') || 'unknown',
        latestExtName: latest.name,
      };
    }
    return {
      kind: 'portable_data_empty',
      extensionsDir,
      settingsPath,
    };
  }

  // Layer 4: a portable install root with `data/` next to Code.exe etc.
  if (isDir(path.join(picked, 'data'))) {
    const dataInner = path.join(picked, 'data');
    if (isPortableDataDir(dataInner)) {
      return identifyFolder(dataInner);
    }
  }

  // Layer 5: a host profile/data root the user pointed at — e.g. ~/.vscode,
  // ~/.cursor, ~/.vscode-insiders — whose `extensions/` subfolder holds
  // Claude Code. This is the single most natural manual pick (the parent of
  // the extensions dir). Resolve EXACTLY one level down; never an arbitrary
  // deep walk — a deep scan could match a stale or wrong-host copy and
  // silently retarget the patch. Settings derivation reuses the same
  // (already-validated) path used by Layer 2 for a directly-picked
  // extensions dir, so standard mode correctly resolves to the
  // platform-default user settings location.
  const profileExtDir = path.join(picked, 'extensions');
  if (isDir(profileExtDir)) {
    const profileExts = scanClaudeCodeExtensions(profileExtDir);
    if (profileExts.length) {
      const latest = profileExts[profileExts.length - 1];
      return {
        kind: 'extensions_dir',
        extensionsDir: profileExtDir,
        settingsPath: deriveSettingsPathFromExtensionsDir(profileExtDir),
        latestVersion: latest.version.join('.') || 'unknown',
        latestExtName: latest.name,
      };
    }
    // It IS an editor-profile shape (has an `extensions/`) but Claude Code
    // is not installed there — return a specific, actionable hint instead
    // of the generic "no known shape".
    return { kind: 'unknown', hint: 'profile-no-claude-code' };
  }

  if (looksLikeStandardVSCodeInstall(picked)) {
    return {
      kind: 'standard_install_root',
      hint: 'standard-install-no-data',
      recoverable: true,
    };
  }

  return { kind: 'unknown', hint: 'no-known-shape' };
}

function isPortableDataDir(p) {
  return isDir(path.join(p, 'extensions')) && isDir(path.join(p, 'user-data'));
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function looksLikeStandardVSCodeInstall(picked) {
  for (const name of ALL_BIN_NAMES) {
    try {
      if (fs.existsSync(path.join(picked, name))) return true;
    } catch (_) {}
  }
  return false;
}

// Walk up from an extensionsDir and map it back to the corresponding
// platform-default settings.json. Returns null when the folder shape is not
// recognized; caller should ask the user separately.
function deriveSettingsPathFromExtensionsDir(extensionsDir) {
  const portable = derivePortableSettingsPathFromExtensionsDir(extensionsDir);
  if (portable) return portable;

  const appData = deriveAppDataSettingsPathFromExtensionsDir(extensionsDir);
  if (appData) return appData;

  const parent = path.basename(path.dirname(extensionsDir));
  const hosts = HOSTS_BY_HOME_NAME.get(parent);
  if (hosts && hosts.length) {
    const selected = selectHostsForHomeName(parent, hosts);
    return settingsPathForHost(selected[0]);
  }
  return null;
}

function derivePortableSettingsPathFromExtensionsDir(extensionsDir) {
  if (path.basename(extensionsDir) !== 'extensions') return null;
  const dataDir = path.dirname(extensionsDir);
  if (!isDir(path.join(dataDir, 'user-data'))) return null;
  return path.join(dataDir, 'user-data', 'User', 'settings.json');
}

function deriveAppDataSettingsPathFromExtensionsDir(extensionsDir) {
  if (path.basename(extensionsDir) !== 'extensions') return null;
  const root = path.dirname(extensionsDir);
  const rootName = path.basename(root).toLowerCase();
  for (const host of HOSTS) {
    for (const appDataRoot of appDataRootCandidatesForHost(host)) {
      if (path.basename(appDataRoot).toLowerCase() === rootName) {
        return path.join(root, 'User', 'settings.json');
      }
    }
  }
  return null;
}

// Best-effort friendly identity for a discovered `.../extensions` dir: a
// host label for the picker plus the SAME settings path manual identify
// would derive (so a scanned target behaves exactly like a hand-picked
// one). Label precedence: profile home-name (.vscode → VS Code) → app-data
// root name → portable (sibling user-data) → the parent dir name.
function describeExtensionsDir(extensionsDir) {
  const settingsPath = deriveSettingsPathFromExtensionsDir(extensionsDir);
  const parentName = path.basename(path.dirname(extensionsDir));

  const homeHosts = HOSTS_BY_HOME_NAME.get(parentName);
  if (homeHosts && homeHosts.length) {
    return { label: selectHostsForHomeName(parentName, homeHosts)[0].label, settingsPath };
  }
  const lower = parentName.toLowerCase();
  for (const host of HOSTS) {
    for (const appDataRoot of appDataRootCandidatesForHost(host)) {
      if (path.basename(appDataRoot).toLowerCase() === lower) {
        return { label: `${host.label} (app data)`, settingsPath };
      }
    }
  }
  if (isDir(path.join(path.dirname(extensionsDir), 'user-data'))) {
    return { label: `${parentName} (portable)`, settingsPath };
  }
  return { label: parentName || 'Unknown editor', settingsPath };
}

// ============================================================
// validation
// ============================================================

// Used both at startup (drop stale entries from the persisted list) and before
// apply (refuse to run against an invalid target). `valid` = extensionsDir
// exists AND has at least one matching extension.
function validateTargetEntry(entry) {
  if (!entry || !entry.extensionsDir) {
    return { valid: false, reason: 'missing-extensions-dir' };
  }
  if (!fs.existsSync(entry.extensionsDir)) {
    return { valid: false, reason: 'extensions-dir-not-found' };
  }
  const exts = scanClaudeCodeExtensions(entry.extensionsDir);
  if (!exts.length) {
    return { valid: false, reason: 'no-claude-code-extension' };
  }
  const latest = exts[exts.length - 1];
  return {
    valid: true,
    latestVersion: latest.version.join('.') || 'unknown',
    latestExtName: latest.name,
    latestExtPath: latest.path,
  };
}

// ============================================================
// small filesystem helpers
// ============================================================

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir).filter(name => {
      try { return fs.statSync(path.join(dir, name)).isDirectory(); }
      catch (_) { return false; }
    });
  } catch (_) {
    return [];
  }
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function canonicalExistingPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_) {
    return resolved;
  }
}

function targetDedupKey(extensionsDir, settingsPath) {
  return [
    canonicalExistingPath(extensionsDir || ''),
    settingsPath ? canonicalExistingPath(settingsPath) : '',
  ].join('\0');
}

module.exports = {
  CLAUDE_CODE_EXTENSION_PREFIX,
  detectAutoTargets,
  identifyFolder,
  validateTargetEntry,
  scanClaudeCodeExtensions,
  deriveSettingsPathFromExtensionsDir,
  describeExtensionsDir,
  settingsPathForAppDataName,
};
