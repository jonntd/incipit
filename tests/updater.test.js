'use strict';

const assert = require('assert');
const { parseVersion, isNewerVersion, getPlatformAssetName } = require('../src/updater');

console.log('Testing updater utilities...');

// 1. Version parsing & comparison
assert.deepStrictEqual(parseVersion('v0.1.19'), [0, 1, 19]);
assert.deepStrictEqual(parseVersion('0.2.0'), [0, 2, 0]);

assert.strictEqual(isNewerVersion('0.1.20', '0.1.19'), true);
assert.strictEqual(isNewerVersion('0.2.0', '0.1.19'), true);
assert.strictEqual(isNewerVersion('1.0.0', '0.1.19'), true);
assert.strictEqual(isNewerVersion('0.1.19', '0.1.19'), false);
assert.strictEqual(isNewerVersion('0.1.18', '0.1.19'), false);
assert.strictEqual(isNewerVersion('0.1.19.1', '0.1.19'), true);

// 2. Asset name mapping
const assetName = getPlatformAssetName();
assert.strictEqual(typeof assetName, 'string');
assert.ok(assetName.startsWith('incipit-'));

console.log('✅ Updater tests passed successfully!');
