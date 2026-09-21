const assert = require('assert/strict');
const { parseDimension, parseRadiusDimension, parseCompactSymmetric, parseNearbyDimension, normalizeTechnicalText, focusedOnlyForPage, shouldRunNeighborhoodRecovery, isDimensionInk } = require('./lab-engine.cjs');
const { classifyDimension, prioritizeDimensions, inferAdministrativeZones, applyStrictCandidateGate } = require('./processing.cjs');
const { detectDimensions, identifyTool } = require('./detection.cjs');
const { preferFlatBarProfileView, analysisVersionFor, ENGINE_VERSION, FLAT_BAR_ENGINE_VERSION, SPARSE_PAGE_DIMENSION_THRESHOLD, sparsePageNumbers, findNearbyReadingConflicts, findTitleBlockRegions, filterTitleBlockDimensions } = require('./processing.cjs');
const { nextRevision, compareProfiles, describeChanges } = require('../revision-tools.js');

assert.equal(normalizeTechnicalText('8,2#0,3'), '8,2±0,3');
assert.deepEqual(parseDimension('50±0,36'), { nominal: 50, tolerancePlus: .36, toleranceMinus: .36, kind: 'SYMMETRIC' });
assert.deepEqual(parseDimension('8,2+0,3/-0,1'), { nominal: 8.2, tolerancePlus: .3, toleranceMinus: .1, kind: 'ASYMMETRIC' });
assert.equal(parseDimension('Ø25±0,1').symbol, 'Ø');
assert.deepEqual(parseCompactSymmetric('1,60,15'), { nominal: 1.6, tolerancePlus: .15, toleranceMinus: .15, kind: 'SYMMETRIC_COMPACT' });
assert.deepEqual(parseCompactSymmetric('210,15'), { nominal: 2, tolerancePlus: .15, toleranceMinus: .15, kind: 'SYMMETRIC_COMPACT' });
assert.deepEqual(parseCompactSymmetric('1,7840,15'), { nominal: 1.78, tolerancePlus: .15, toleranceMinus: .15, kind: 'SYMMETRIC_COMPACT' });
assert.equal(parseDimension('1,78±0,15').nominal, 1.78);
assert.equal(parseDimension('0,8±0,6'), null);
assert.equal(parseDimension('01').kind, 'PLAIN');
assert.equal(parseDimension('8,2±33'), null);
assert.deepEqual(parseRadiusDimension('R3'), { nominal: 3, tolerancePlus: null, toleranceMinus: null, kind: 'RADIUS', symbol: 'R' });
assert.equal(parseRadiusDimension('R1,5').nominal, 1.5);
assert.equal(parseRadiusDimension('R83', 25), null);
assert.equal(parseNearbyDimension('60,13').kind, 'SYMMETRIC_COMPACT');
assert.equal(parseDimension('60,13').kind, 'PLAIN');
assert.equal(parseNearbyDimension('4 R3').kind, 'RADIUS');
assert.equal(parseRadiusDimension('AR3'), null);
assert.equal(parseRadiusDimension('R0'), null);
assert.equal(isDimensionInk(25, 25, 25), true, 'black dimension text must be retained');
assert.equal(isDimensionInk(110, 110, 110), true, 'dark gray anti-aliased text must be retained');
assert.equal(isDimensionInk(20, 30, 245), true, 'blue dimension and profile strokes must be retained');
assert.equal(isDimensionInk(25, 220, 30), false, 'green title-block lines are not dimension ink');
assert.equal(isDimensionInk(245, 25, 25), false, 'red markup is not dimension ink');
assert.equal(isDimensionInk(255, 255, 255), false, 'white background is not dimension ink');
assert.deepEqual(identifyTool('19-0065.pdf', ''), { tool: '19-0065', source: 'FILENAME' });
assert.deepEqual(identifyTool('drawing.pdf', '19-0065'), { tool: '19-0065', source: 'PDF_TEXT' });

const vector = detectDimensions([{ page: 1, width: 500, height: 300, items: [
  { text: '160±0,75', x: 10, y: 200, width: 50, height: 8, rotation: 0 },
  { text: '6±0,13', x: 100, y: 150, width: 35, height: 8, rotation: 0 },
  { text: 'R', x: 400, y: 100, width: 6, height: 8, rotation: 0 },
  { text: '3', x: 408, y: 100, width: 6, height: 8, rotation: 0 },
] }]);
assert.equal(vector.length, 3);
assert.deepEqual(vector.map(item => item.rawText), ['160±0,75', '6±0,13', 'R3']);
assert.equal(vector[2].symbol, 'R');
assert.equal(vector[2].tolerancePlus, null);

const bcSelection = preferFlatBarProfileView([
  { page: 1, x: 15, width: 10, rawText: '160 ± 0,75', symbol: '' },
  { page: 2, x: 60, width: 8, rawText: '160 ± 0,75', symbol: '' },
  { page: 2, x: 85, width: 4, rawText: 'R3', symbol: 'R' }
], [
  { page: 1, width: 100, text: 'EP Especificação Embalagem' },
  { page: 2, width: 100, text: 'Desenho da ferramenta' }
]);
assert.deepEqual(bcSelection.dimensions.map(item => item.rawText), ['160 ± 0,75', 'R3']);
assert.deepEqual(bcSelection.diagnostics.ignoredPackagingPages, [1]);
assert.equal(analysisVersionFor('BC-507.pdf'), FLAT_BAR_ENGINE_VERSION);
assert.equal(analysisVersionFor('TP-8377.pdf'), ENGINE_VERSION);
assert.equal(ENGINE_VERSION, '4.0-strict-region-and-geometry-gate');
assert.equal(SPARSE_PAGE_DIMENSION_THRESHOLD, 3);
assert.deepEqual(sparsePageNumbers([
  { page: 1 }, { page: 1 }, { page: 1 }, { page: 1 },
  { page: 2 }, { page: 2 }, { page: 3 }
], [{ page: 1 }, { page: 2 }, { page: 3 }]), [2, 3]);
assert.deepEqual(sparsePageNumbers([], [{ page: 1 }, { page: 2 }]), [1, 2]);
assert.equal(focusedOnlyForPage({ focusedOnly: true, fullScanPages: [1] }, 1), false);
assert.equal(focusedOnlyForPage({ focusedOnly: true, fullScanPages: [1] }, 2), true);
assert.equal(focusedOnlyForPage({ focusedOnly: false, fullScanPages: [] }, 1), false);
assert.equal(shouldRunNeighborhoodRecovery({ pageDimensionCount: 7, radiusCount: 5, linearCount: 2 }), true);
assert.equal(shouldRunNeighborhoodRecovery({ pageDimensionCount: 7, radiusCount: 2, linearCount: 5 }), false);
assert.equal(shouldRunNeighborhoodRecovery({ flatBarRecovery: true, pageDimensionCount: 7 }), true);
assert.equal(classifyDimension({ rawText: 'R4', symbol: 'R' }).type, 'RADIUS');
assert.equal(classifyDimension({ rawText: '100 ± 0,86', tolerancePlus: .86 }).type, 'TOLERANCED_LINEAR');
assert.equal(classifyDimension({ rawText: '91,22' }).type, 'LINEAR');
assert.equal(classifyDimension({ rawText: '25 REF' }).type, 'REFERENCE');
assert.deepEqual(prioritizeDimensions([{ rawText: 'R4', symbol: 'R' }, { rawText: '100 ± 0,86', tolerancePlus: .86 }]).map(item => item.dimensionType), ['TOLERANCED_LINEAR', 'RADIUS']);
assert.deepEqual(findNearbyReadingConflicts([
  { page: 1, x: 10, y: 20, width: 8, height: 5, nominal: 8, tolerancePlus: .2, toleranceMinus: .2 },
  { page: 1, x: 15, y: 20, width: 8, height: 5, nominal: 9.8, tolerancePlus: .2, toleranceMinus: .2 },
  { page: 1, x: 100, y: 20, width: 8, height: 5, nominal: 12, tolerancePlus: .2, toleranceMinus: .2 },
]), [{ left: 0, right: 1 }], 'conflicting OCR readings near the same label must be flagged for visual review');
const titleBlockPage={page:1,width:600,height:840,items:[
  {text:'Peso',x:500,y:480,width:20,height:6},{text:'Área',x:460,y:480,width:20,height:6},
  {text:'Perímetro',x:460,y:465,width:30,height:6},{text:'Escala',x:510,y:435,width:20,height:6},
  {text:'Desenhista',x:530,y:490,width:28,height:6},{text:'DCC',x:420,y:450,width:12,height:6},
  {text:'Aprovação Produto',x:480,y:763,width:42,height:6},{text:'Aprovado',x:480,y:758,width:22,height:6},
  {text:'Data',x:480,y:752,width:12,height:6},{text:'Notas',x:503,y:741,width:18,height:6},
  {text:'DIN-004',x:100,y:700,width:40,height:8}
]};
assert.equal(findTitleBlockRegions(titleBlockPage).length,2);
assert.deepEqual(filterTitleBlockDimensions([
  {page:1,x:520,y:470,width:10,height:5,nominal:382},
  {page:1,x:490,y:720,width:10,height:5,nominal:157},
  {page:1,x:180,y:620,width:12,height:5,nominal:68}
], [titleBlockPage]).dimensions.map(item=>item.nominal),[68], 'both title-block areas must be excluded while profile dimensions remain');
const strictPage={page:1,width:842,height:595,items:[]};
const strictCandidates=[
  {page:1,source:'OCR_LAB',rawText:'156 ± 1,1',nominal:156,tolerancePlus:1.1,toleranceMinus:1.1,confidence:.57,x:205,y:370,width:27,height:7},
  {page:1,source:'OCR_LAB',rawText:'31',nominal:31,tolerancePlus:null,toleranceMinus:null,confidence:.95,x:718,y:233,width:6,height:5},
  {page:1,source:'OCR_LAB',rawText:'20',nominal:20,tolerancePlus:null,toleranceMinus:null,confidence:.84,x:467,y:122,width:3,height:8},
  {page:1,source:'OCR_LAB',rawText:'33',nominal:33,tolerancePlus:null,toleranceMinus:null,confidence:.78,x:581,y:108,width:2,height:6},
  {page:1,source:'OCR_LAB',rawText:'382',nominal:382,tolerancePlus:null,toleranceMinus:null,confidence:.65,x:780,y:95,width:6,height:4},
  {page:1,source:'OCR_LAB',rawText:'157',nominal:157,tolerancePlus:null,toleranceMinus:null,confidence:.96,x:723,y:87,width:6,height:4},
  {page:1,source:'OCR_LAB',rawText:'R8',nominal:8,tolerancePlus:null,toleranceMinus:null,symbol:'R',dimensionType:'RADIUS',confidence:.35,x:773,y:81,width:5,height:56},
];
assert.equal(inferAdministrativeZones(strictCandidates,[strictPage]).some(zone=>zone.type==='QUADRO_INFERIOR'),true);
const strictResult=applyStrictCandidateGate(strictCandidates,[strictPage],[]);
assert.deepEqual(strictResult.accepted.map(item=>item.rawText),['156 ± 1,1','31']);
assert.equal(strictResult.suggestions.length,5);

assert.equal(nextRevision([]), '00');
assert.equal(nextRevision([{ revision: '00' }, { revision: '02' }]), '03');
assert.equal(nextRevision([{ revision: 'A' }]), '');
const revisionDiff = compareProfiles({ dimensions: [
  { id: 'stable-a', dimensionKey: 'a', rawText: '100 ± 0,5', nominal: 100, tolerancePlus: .5, toleranceMinus: .5, x: 100, y: 50, width: 20, height: 10 },
  { id: 'stable-b', dimensionKey: 'b', rawText: 'R3', nominal: 3, symbol: 'R', x: 200, y: 50, width: 10, height: 10 },
] }, { dimensions: [
  { rawText: '102 ± 0,3', nominal: 102, tolerancePlus: .3, toleranceMinus: .3, x: 101, y: 50, width: 20, height: 10 },
  { rawText: 'R3', nominal: 3, symbol: 'R', x: 200, y: 50, width: 10, height: 10 },
  { rawText: 'Ø8', nominal: 8, symbol: 'Ø', x: 300, y: 50, width: 10, height: 10 },
] });
assert.equal(revisionDiff.find(item => item.old?.dimensionKey === 'a')?.status, 'CHANGED');
assert.equal(revisionDiff.find(item => item.old?.dimensionKey === 'a')?.changes.nominal, true);
assert.equal(revisionDiff.find(item => item.old?.dimensionKey === 'a')?.changes.tolerancePlus, true);
assert.equal(revisionDiff.find(item => item.old?.dimensionKey === 'b')?.status, 'UNCHANGED');
assert.equal(revisionDiff.filter(item => item.status === 'ADDED').length, 1);
assert.equal(revisionDiff.filter(item => item.status === 'REMOVED').length, 0);
assert.match(describeChanges(revisionDiff.find(item => item.old?.dimensionKey === 'a')), /Nominal 100 → 102/);
assert.match(describeChanges(revisionDiff.find(item => item.old?.dimensionKey === 'a')), /Tol\. \+ 0,5 → 0,3/);

console.log('Laboratory dimension parser: OK');
