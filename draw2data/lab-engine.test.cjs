const assert = require('assert/strict');
const { parseDimension, normalizeTechnicalText } = require('./lab-engine.cjs');

assert.equal(normalizeTechnicalText('8,2#0,3'), '8,2±0,3');
assert.deepEqual(parseDimension('50±0,36'), { nominal: 50, tolerancePlus: .36, toleranceMinus: .36, kind: 'SYMMETRIC' });
assert.deepEqual(parseDimension('8,2+0,3/-0,1'), { nominal: 8.2, tolerancePlus: .3, toleranceMinus: .1, kind: 'ASYMMETRIC' });
assert.equal(parseDimension('01').kind, 'PLAIN');
assert.equal(parseDimension('8,2±33'), null);

console.log('Laboratory dimension parser: OK');
