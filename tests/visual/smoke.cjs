#!/usr/bin/env node
'use strict';

/**
 * Optional Playwright smoke for incipit UI surfaces.
 * Skips cleanly when Playwright or a live host is unavailable so `npm test`
 * stays hermetic (source contracts cover P0–P2 structure).
 */

const fs = require('fs');
const path = require('path');

function skip(reason) {
  console.log('visual smoke: SKIP — ' + reason);
  process.exit(0);
}

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (_) {
    skip('playwright not installed (optional peer)');
  }

  // Live host URL would be injected by a future CI job, e.g.:
  //   INCIPIT_VISUAL_URL=http://127.0.0.1:port/webview
  const url = process.env.INCIPIT_VISUAL_URL;
  if (!url) {
    skip('set INCIPIT_VISUAL_URL to a patched webview URL to run live shots');
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: path.join(outDir, 'transcript.png'), fullPage: true });
    console.log('visual smoke: wrote tests/visual/output/transcript.png');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('visual smoke: FAIL', err && err.message ? err.message : err);
  process.exit(1);
});
