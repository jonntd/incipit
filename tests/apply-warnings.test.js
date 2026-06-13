'use strict';

// Guards the 2026-06-12 judgment: the hostRoute "未知版本/内容指纹" provenance
// line is maintainer telemetry, not a user-facing degradation. When every real
// patch anchor succeeds, an unregistered host build must NOT raise a yellow
// apply warning. A real functional degradation (e.g. the semantic bridge) still
// must. Re-routing the provenance line back into warnings turns this red.

const assert = require('assert');
const { __test } = require('../src/menu');

const { collectApplyWarnings, isHostRouteProvenanceLine } = __test;

let passed = 0;
function ok(name, cond) {
  assert(cond, name);
  console.log('  ok  ' + name);
  passed++;
}

// Real renderHostRouteStatus output shape for an unregistered build, plus the
// surrounding all-green status lines.
const hostRouteDegraded = '宿主版本路由          : 降级 (未知版本/内容指纹)';
const bridgeDegraded = '宿主语义桥            : 降级 (将使用 fiber/DOM fallback)';
const someOk = 'extension 契约        : ok';

ok('predicate matches the hostRoute provenance line',
  isHostRouteProvenanceLine(hostRouteDegraded));
ok('predicate does not match a real functional degradation',
  !isHostRouteProvenanceLine(bridgeDegraded));

// All anchors succeeded, build just not in the catalog yet → zero warnings.
const provenanceOnly = collectApplyWarnings({
  extensionJs: { statusLines: [hostRouteDegraded, someOk] },
  webviewIndex: { statusLines: [someOk] },
});
ok('provenance-only degradation produces no yellow warning',
  provenanceOnly.length === 0);

// A genuine functional degradation still surfaces; the provenance line stays out.
const withRealDegradation = collectApplyWarnings({
  extensionJs: { statusLines: [hostRouteDegraded, someOk] },
  webviewIndex: { statusLines: [bridgeDegraded, someOk] },
});
ok('real functional degradation still warns',
  withRealDegradation.some(w => /宿主语义桥/.test(w)));
ok('provenance line never rides along with a real degradation',
  !withRealDegradation.some(isHostRouteProvenanceLine));

console.log('apply-warnings tests passed: ' + passed);
