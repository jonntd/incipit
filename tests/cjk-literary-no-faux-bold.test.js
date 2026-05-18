'use strict';

// Regression guard for the 2026-05-18 judgment, two-preset form.
//
// Body font has two presets (config.BODY_FONT_FAMILY_OPTIONS):
//   plex-hei   (DEFAULT) Latin IBM Plex Serif + CJK Noto Sans SC 思源黑体
//   plex-serif (opt-in)  Latin IBM Plex Serif + CJK LXGW WenKai 霞鹜文楷
//
// The non-negotiable invariant is NO synthetic (faux) bold: every
// @font-face is declared at font-weight:400 and the heavier cut lives
// under a separate family name. Emphasis + warm-white bodyBold faces
// switch WITH the preset (BODY_FONT_FACE_BY_KEY), so a gothic body never
// gets kai bold runs and vice versa. Bundled CJK weight map:
//   Reading      -> LXGWWenKai-400   ReadingHei      -> NotoSansSC-400
//   Emphasis     -> LXGWWenKai-500   EmphasisHei     -> NotoSansSC-600
//   PaperReading -> LXGWWenKai-500   PaperReadingHei -> NotoSansSC-500
// LXGW WenKai has no real master heavier than Medium 500 (kai ceiling),
// so Emphasis kai = 500 by design — raising it to a numeric bold would
// re-invite the very faux bold this test exists to prevent.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }

const dataDir = path.join(__dirname, '..', 'data');
const theme = fs.readFileSync(path.join(dataDir, 'theme.css'), 'utf8');
const warm = fs.readFileSync(path.join(dataDir, 'warm-white-override.css'), 'utf8');
const installSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'install.js'), 'utf8');

function fontFaces(css) {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const fam = /font-family:\s*'([^']+)'/.exec(body);
    const wt = /font-weight:\s*([^;]+);/.exec(body);
    const src = /src:\s*url\('([^']+)'\)/.exec(body);
    out.push({
      family: fam && fam[1],
      weight: wt && wt[1].trim(),
      src: src && src[1],
    });
  }
  return out;
}

const ALL_FACES = [...fontFaces(theme), ...fontFaces(warm)];
const BUNDLED = ['Reading', 'Emphasis', 'PaperReading',
                 'ReadingHei', 'EmphasisHei', 'PaperReadingHei'];

// 1. Name-encoded weight discipline: EVERY bundled @font-face (both
//    presets, Latin + CJK halves) is declared at weight 400.
(function weightAlwaysFourHundred() {
  const faces = ALL_FACES.filter(f => BUNDLED.includes(f.family));
  // 6 families * 2 unicode halves = 12 @font-face rules.
  assert.strictEqual(faces.length, 12, `expected 12 bundled @font-face rules, got ${faces.length}`);
  for (const f of faces) {
    assert.strictEqual(
      f.weight, '400',
      `@font-face '${f.family}' must declare font-weight:400 (got ${f.weight}) — ` +
      `a numeric bold here re-invites Chromium faux bold`,
    );
  }
  ok('all 12 bundled @font-face rules declared at weight 400 (no synthetic bold)');
})();

// 2. Each bundled family's CJK src is the matching real-weight master.
(function cjkSrcRealMasters() {
  const wantCjk = {
    Reading: 'fonts/lxgw-wenkai/LXGWWenKai-400.woff2',
    Emphasis: 'fonts/lxgw-wenkai/LXGWWenKai-500.woff2',
    PaperReading: 'fonts/lxgw-wenkai/LXGWWenKai-500.woff2',
    ReadingHei: 'fonts/noto-sans-sc/NotoSansSC-400.woff2',
    EmphasisHei: 'fonts/noto-sans-sc/NotoSansSC-600.woff2',
    PaperReadingHei: 'fonts/noto-sans-sc/NotoSansSC-500.woff2',
  };
  const wantLatin = {
    Reading: '400', Emphasis: '600', PaperReading: '500',
    ReadingHei: '400', EmphasisHei: '600', PaperReadingHei: '500',
  };
  const seenCjk = {};
  for (const f of ALL_FACES) {
    if (!BUNDLED.includes(f.family) || !f.src) continue;
    if (/lxgw-wenkai|noto-sans-sc/.test(f.src)) {
      assert.strictEqual(f.src, wantCjk[f.family],
        `@font-face '${f.family}' CJK src must be ${wantCjk[f.family]} (got ${f.src})`);
      seenCjk[f.family] = true;
    } else if (/ibm-plex-serif/.test(f.src)) {
      assert.ok(f.src.includes(`IBMPlexSerif-${wantLatin[f.family]}.woff2`),
        `@font-face '${f.family}' Latin src must be Plex ${wantLatin[f.family]} (got ${f.src})`);
    }
  }
  assert.deepStrictEqual(
    Object.keys(seenCjk).sort(), BUNDLED.slice().sort(),
    `every bundled family must have a CJK @font-face (missing: ${BUNDLED.filter(b => !seenCjk[b])})`,
  );
  ok('every bundled family CJK src = matching real-weight master (kai 400/500, hei 400/500/600)');
})();

// 3. Presets: gothic is the default (first option + DEFAULT_THEME), each
//    preset body stack leads with a bundled family that actually exists.
(function presetsCoherent() {
  const opts = config.BODY_FONT_FAMILY_OPTIONS;
  assert.strictEqual(opts[0][0], 'plex-hei', 'first body preset (default) must be plex-hei (gothic)');
  assert.strictEqual(config.DEFAULT_THEME.bodyFontFamily, 'plex-hei', 'DEFAULT_THEME body must be plex-hei');
  const keys = opts.map(o => o[0]).sort();
  assert.deepStrictEqual(keys, ['plex-hei', 'plex-serif'], `unexpected body presets: ${keys}`);

  const declaredFamilies = new Set(ALL_FACES.map(f => f.family));
  const leadFamily = css => /^'([^']+)'/.exec(css)[1];
  for (const [key, css] of opts) {
    const lead = leadFamily(css);
    assert.ok(declaredFamilies.has(lead),
      `preset ${key} leads with '${lead}' which has no @font-face`);
  }
  assert.ok(/sans-serif\s*$/.test(opts.find(o => o[0] === 'plex-hei')[1]), 'gothic preset ends at sans-serif');
  assert.ok(/\bserif\s*$/.test(opts.find(o => o[0] === 'plex-serif')[1]), 'kai preset ends at serif');
  ok('presets: plex-hei default, both lead with a real bundled family');
})();

// 4. Emphasis + paper faces switch with the preset and name real
//    @font-face families (so a preset can't point bold at a ghost).
(function faceMapResolvesToRealFamilies() {
  const declared = new Set(ALL_FACES.map(f => f.family));
  const map = config.BODY_FONT_FACE_BY_KEY;
  for (const key of ['plex-hei', 'plex-serif']) {
    assert.ok(map[key], `BODY_FONT_FACE_BY_KEY missing ${key}`);
    const emph = /^'([^']+)'/.exec(map[key].emphasis)[1];
    const paper = map[key].paper.replace(/'/g, '');
    assert.ok(declared.has(emph), `${key} emphasis family '${emph}' has no @font-face`);
    assert.ok(declared.has(paper), `${key} paper family '${paper}' has no @font-face`);
  }
  // Gothic body must pair with gothic bold; kai with kai.
  assert.ok(/EmphasisHei/.test(map['plex-hei'].emphasis), 'plex-hei emphasis must be EmphasisHei');
  assert.ok(/'Emphasis'/.test(map['plex-serif'].emphasis), 'plex-serif emphasis must be Emphasis');
  ok('emphasis/paper faces switch with preset and resolve to real families');
})();

// 5. install.js conditionally injects the per-preset emphasis + paper
//    vars (the wiring that makes #4 actually take effect at apply).
(function installInjectsFaceVars() {
  assert.ok(/--incipit-emphasis-font:/.test(installSrc),
    'install.js must inject --incipit-emphasis-font');
  assert.ok(/--incipit-paper-reading-font:/.test(installSrc),
    'install.js must inject --incipit-paper-reading-font');
  assert.ok(/var\(--incipit-paper-reading-font, 'PaperReading'\)/.test(warm),
    'warm-white bodyBold rule must select paper face via --incipit-paper-reading-font');
  ok('install.js injects emphasis/paper vars; warm-white rule reads the paper var');
})();

// 6. Bundled subsets present and sized like real CJK subsets.
(function fontFilesPresentAndReal() {
  const woff2 = dir => fs.readdirSync(path.join(dataDir, 'fonts', dir))
    .filter(n => n.endsWith('.woff2')).sort();
  const kai = woff2('lxgw-wenkai');
  assert.deepStrictEqual(kai, ['LXGWWenKai-400.woff2', 'LXGWWenKai-500.woff2'],
    `lxgw-wenkai must hold exactly 400+500 woff2 (got ${kai.join(', ')})`);
  const hei = woff2('noto-sans-sc');
  assert.deepStrictEqual(hei, ['NotoSansSC-400.woff2', 'NotoSansSC-500.woff2', 'NotoSansSC-600.woff2'],
    `noto-sans-sc must hold exactly 400+500+600 woff2 (got ${hei.join(', ')})`);
  for (const [dir, files] of [['lxgw-wenkai', kai], ['noto-sans-sc', hei]]) {
    for (const fnm of files) {
      const sz = fs.statSync(path.join(dataDir, 'fonts', dir, fnm)).size;
      assert.ok(sz > 800_000 && sz < 6_000_000, `${dir}/${fnm} size ${sz} out of sane CJK-subset range`);
    }
  }
  ok('kai 400/500 + hei 400/500/600 woff2 present and CJK-subset sized');
})();

console.log('\ncjk-literary-no-faux-bold: ' + passed + ' checks PASSED');
