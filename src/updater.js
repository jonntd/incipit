'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const GITHUB_REPO = 'jonntd/incipit';

function getPlatformAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'incipit-macos-arm64' : 'incipit-macos-x64';
  } else if (platform === 'win32') {
    return 'incipit-win-x64.exe';
  } else if (platform === 'linux') {
    return 'incipit-linux-x64';
  }
  return null;
}

function parseVersion(v) {
  if (!v) return [0, 0, 0];
  const clean = String(v).replace(/^v/i, '').trim();
  return clean.split('.').map(n => parseInt(n, 10) || 0);
}

function isNewerVersion(latest, current) {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  const maxLen = Math.max(l.length, c.length);
  for (let i = 0; i < maxLen; i++) {
    const numL = l[i] || 0;
    const numC = c[i] || 0;
    if (numL > numC) return true;
    if (numL < numC) return false;
  }
  return false;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'incipit-updater',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'incipit-updater'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, destPath, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed with HTTP ${res.statusCode}`));
      }
      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const file = fs.createWriteStream(destPath);

      res.on('data', chunk => {
        downloadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
      file.on('error', err => {
        fs.unlink(destPath, () => reject(err));
      });
    }).on('error', err => {
      fs.unlink(destPath, () => reject(err));
    });
  });
}

async function checkLatestRelease(currentVersion) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const release = await fetchJson(url);
  const latestTag = release.tag_name || release.name || '';
  const latestVersion = latestTag.replace(/^v/i, '');

  const hasNewer = isNewerVersion(latestVersion, currentVersion);
  const assetName = getPlatformAssetName();
  const asset = release.assets ? release.assets.find(a => a.name === assetName) : null;

  return {
    hasNewer,
    currentVersion,
    latestVersion,
    releaseName: release.name,
    releaseNotes: release.body || '',
    downloadUrl: asset ? asset.browser_download_url : null,
    assetName
  };
}

async function performSelfUpdate(downloadUrl, onProgress) {
  const currentExecPath = process.execPath;
  const isPkgBinary = process.pkg !== undefined || path.extname(currentExecPath).toLowerCase() === '.exe' || !currentExecPath.endsWith('node');

  const tempPath = `${currentExecPath}.tmp-${Date.now()}`;

  await downloadFile(downloadUrl, tempPath, onProgress);

  if (process.platform === 'win32') {
    const batPath = `${currentExecPath}.update.bat`;
    const batContent = `@echo off
timeout /t 1 /nobreak > nul
move /y "${tempPath}" "${currentExecPath}"
start "" "${currentExecPath}"
del "%~f0"
`;
    fs.writeFileSync(batPath, batContent);
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  } else {
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, currentExecPath);
  }
}

module.exports = {
  getPlatformAssetName,
  parseVersion,
  isNewerVersion,
  checkLatestRelease,
  performSelfUpdate
};
