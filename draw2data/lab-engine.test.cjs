const assert = require('assert/strict');
const { parseDimension, parseRadiusDimension, parseCompactSymmetric, parseNearbyDimension, normalizeTechnicalText, focusedOnlyForPage, shouldRunNeighborhoodRecovery, isDimensionInk, originalBox } = require('./lab-engine.cjs');
const { classifyDimension, prioritizeDimensions, inferAdministrativeZones, applyStrictCandidateGate, strictCandidateReason, preserveGeometricToleranceForReview } = require('./processing.cjs');
const { detectDimensions, identifyTool } = require('./detection.cjs');
const { preferFlatBarProfileView, analysisVersionFor, ENGINE_VERSION, FLAT_BAR_ENGINE_VERSION, SPARSE_PAGE_DIMENSION_THRESHOLD, sparsePageNumbers, findNearbyReadingConflicts, findTitleBlockRegions, filterTitleBlockDimensions, findReferenceTableRegions, filterReferenceTableDimensions } = require('./processing.cjs');
const { nextRevision, compareProfiles, describeChanges } = require('../revision-tools.js');
const { parseTechnicalDimension, classifyCandidate, detectDocumentZones, isSameDimensionComponent, deduplicateCandidates, buildUserFeedback } = require('./dimension-decision.cjs');
const { expandBox, incompleteReadingSignals, scoreOCRCandidate, chooseBestOCRCandidate, ocrCacheKey, OCRAttemptCache, mergeScore, assembleStackedTolerance, calculateEvaluationMetrics } = require('./dimension-pipeline.cjs');
const { classifyFeatureId, classifyTextSemantics, detectParagraphRegions, mergeBarrierScore, scoreStructuralMerge, flagSuspiciousNumericPrefix, buildAssociationGraph, splitSuspiciousOCR, extractTechnicalAnnotations, detectTextContainer } = require('./structural-analysis.cjs');
const { createCanvas } = require('@napi-rs/canvas');

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
assert.deepEqual(originalBox({x0:10,y0:20,x1:30,y1:40},90,200,100),{x0:20,y0:170,x1:40,y1:190});
assert.deepEqual(originalBox({x0:10,y0:20,x1:30,y1:40},-90,200,100),{x0:60,y0:10,x1:80,y1:30});
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
assert.equal(ENGINE_VERSION, '4.4-structural-dimension-association');
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
const toleranceTablePage={page:1,width:842,height:595,items:[
  {text:'Faixa',x:480,y:207,width:20,height:6},{text:'(mm)',x:480,y:202,width:15,height:6},
  {text:'Tolerância',x:510,y:207,width:33,height:6},{text:'± (mm)',x:512,y:202,width:23,height:6},
  {text:'1,0 < 3,2',x:480,y:195,width:35,height:6},{text:'0,15',x:520,y:195,width:15,height:6},
]};
assert.equal(findReferenceTableRegions(toleranceTablePage).length,1,'reference tolerance tables are detected by their headings');
assert.deepEqual(filterReferenceTableDimensions([
 {page:1,x:518,y:191,width:16,height:7,nominal:.15},
 {page:1,x:720,y:300,width:20,height:7,nominal:48.3,tolerancePlus:.36,toleranceMinus:.36},
], [toleranceTablePage]).dimensions.map(item=>item.nominal),[48.3],'table entries are excluded without removing profile dimensions elsewhere on the sheet');
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
assert.deepEqual(strictResult.accepted.map(item=>item.rawText),['156 ± 1,1']);
assert.equal(strictResult.suggestions.length,6);

const decisionPage={page:1,width:842,height:595,items:[
 {text:'DCC',x:610,y:80,width:20,height:7},{text:'PERÍMETRO(mm)',x:650,y:90,width:60,height:7},
 {text:'PLANICIDADE:',x:610,y:100,width:55,height:7},{text:'RAIOS NÃO INDICADOS:',x:610,y:110,width:90,height:7},
]};
const decisionZones=detectDocumentZones([decisionPage]);
const decisionFor=(rawText,x,y,geometryEvidence)=>classifyCandidate({page:1,rawText,recognizedText:rawText,x,y,width:28,height:7,confidence:.99,geometryEvidence},{page:decisionPage,zones:decisionZones});
for(const [text,x,y] of [['157',635,80],['382',716,90],['0,62',670,100],['0,5',704,110]])assert.equal(decisionFor(text,x,y).decisionClassification,'NOT_DIMENSION',`${text} in a title-block field is not a dimension`);
const productionDimension=decisionFor('156±1,1',220,360,{dimensionLine:true,arrowTermination:true,compatibleAlignment:true,nearbyProfile:true});
assert.equal(productionDimension.decisionClassification,'DIMENSION');
assert.equal(productionDimension.ocrConfidence,.99);
assert.ok(productionDimension.dimensionConfidence>=.75);
const vertical=parseTechnicalDimension('1,2±0,15');
assert.deepEqual(vertical,{type:'LINEAR',nominal:1.2,upperTolerance:.15,lowerTolerance:-.15,symbol:'',kind:'SYMMETRIC'});
assert.equal(decisionFor('5',300,300).decisionClassification,'NOT_DIMENSION');
assert.equal(decisionFor('31',300,300,{dimensionLine:true,arrowTermination:true,extensionLines:true,compatibleAlignment:true,nearbyProfile:true}).decisionClassification,'REVIEW','short plain dimensions stay reviewable even with strong geometry');
const radius=decisionFor('R18,86',300,300,{dimensionLine:true,compatibleAlignment:true,nearbyProfile:true});
assert.equal(radius.decisionClassification,'DIMENSION');
assert.equal(parseTechnicalDimension('R18,86').nominal,18.86);
assert.equal(parseTechnicalDimension('Ø20').type,'DIAMETER');
assert.equal(parseTechnicalDimension('45°').type,'ANGLE');
assert.equal(parseTechnicalDimension('M8').type,'THREAD');
assert.equal(parseTechnicalDimension('M10x1,5').pitch,1.5);
assert.equal(parseTechnicalDimension('45 DEG').type,'ANGLE');
assert.equal(parseTechnicalDimension('2x45°').type,'CHAMFER');
assert.equal(parseTechnicalDimension('C2').type,'CHAMFER');
assert.deepEqual(parseTechnicalDimension('50 +0.2 -0.1'),{type:'LINEAR',nominal:50,upperTolerance:.2,lowerTolerance:-.1,symbol:'',kind:'ASYMMETRIC'});
assert.deepEqual(parseTechnicalDimension('50 +/- 0,6'),{type:'LINEAR',nominal:50,upperTolerance:.6,lowerTolerance:-.6,symbol:'',kind:'SYMMETRIC'});
assert.ok(isSameDimensionComponent({x:10,y:10,width:20,height:8,rotation:0},{x:32,y:11,width:15,height:8,rotation:0})>=55);
assert.ok(isSameDimensionComponent({x:10,y:10,width:20,height:8,rotation:0},{x:200,y:80,width:15,height:20,rotation:90})<55);
assert.equal(deduplicateCandidates([{page:1,x:10,y:10,width:20,height:8,nominal:50,dimensionConfidence:.9},{page:1,x:11,y:10,width:20,height:8,nominal:50,dimensionConfidence:.7}]).length,1);
const feedback=buildUserFeedback(productionDimension,{userAction:'confirm',classification:'dimension'});
assert.equal(feedback.userAction,'confirm');
assert.equal(feedback.zone,'drawing_area');
assert.equal(feedback.dimensionScore,productionDimension.dimensionScore);
assert.deepEqual(feedback.bbox,{x:productionDimension.x,y:productionDimension.y,width:productionDimension.width,height:productionDimension.height});
const inferredZone=[{page:1,type:'TITLE_BLOCK',inferredType:'QUADRO_INFERIOR',x0:0,y0:0,x1:400,y1:200}];
assert.equal(classifyCandidate({page:1,rawText:'5,5±0,18',x:100,y:100,width:28,height:7,confidence:.9,geometryEvidence:{dimensionLine:true,compatibleAlignment:true,nearbyProfile:true}},{page:{page:1,items:[]},zones:inferredZone}).decisionClassification,'REVIEW','a real-looking dimension on an inferred boundary must remain reviewable');
assert.equal(classifyCandidate({page:1,rawText:'96',x:100,y:100,width:15,height:7,confidence:.99,geometryEvidence:{dimensionLine:true,compatibleAlignment:true,nearbyProfile:true}},{page:{page:1,items:[]},zones:inferredZone}).decisionClassification,'NOT_DIMENSION','a plain administrative number in the inferred block must not be promoted');

assert.deepEqual(expandBox({x0:40,y0:40,x1:60,y1:60},1.5,100,100),{x0:35,y0:35,x1:65,y1:65});
assert.ok(incompleteReadingSignals('±').includes('SHORT_FRAGMENT'));
assert.ok(incompleteReadingSignals(',15').includes('DECIMAL_WITHOUT_INTEGER'));
const highOcrFragment=scoreOCRCandidate({text:'15',confidence:.99},parseTechnicalDimension),completeTolerance=scoreOCRCandidate({text:'1,2±0,15',confidence:.92},parseTechnicalDimension);
assert.ok(completeTolerance.finalScore>highOcrFragment.finalScore,'semantic completeness must beat raw OCR confidence');
assert.equal(chooseBestOCRCandidate([{text:'15',confidence:.99},{text:'1,2±0,15',confidence:.92}],parseTechnicalDimension).text,'1,2±0,15');
assert.equal(ocrCacheKey({documentId:'a',page:1,bbox:{x0:1,y0:2,x1:3,y1:4},rotation:0,expansion:1}),ocrCacheKey({documentId:'a',page:1,bbox:{x0:1,y0:2,x1:3,y1:4},rotation:0,expansion:1}));
const cache=new OCRAttemptCache();let produced=0;(async()=>{await cache.getOrCreate('same',async()=>++produced);await cache.getOrCreate('same',async()=>++produced);assert.equal(produced,1);assert.equal(cache.diagnostics().hits,1)})().catch(error=>{throw error});
assert.ok(mergeScore({x:10,y:10,width:15,height:7,rotation:0,dimensionLineId:'L1',rawText:'50'},{x:27,y:10,width:15,height:7,rotation:0,dimensionLineId:'L1',rawText:'+0,2'})>=70);
const stacked=assembleStackedTolerance([{id:'n',page:1,x:10,y:10,width:15,height:7,rawText:'50',dimensionLineId:'L1'},{id:'p',page:1,x:26,y:7,width:14,height:7,rawText:'+0,2',dimensionLineId:'L1'},{id:'m',page:1,x:26,y:14,width:14,height:7,rawText:'-0,1',dimensionLineId:'L1'}],parseTechnicalDimension);
assert.equal(stacked[0].tolerancePlus,.2);assert.equal(stacked[0].toleranceMinus,.1);
const metrics=calculateEvaluationMetrics([{userAction:'confirm',previousClassification:'DIMENSION',ocrText:'50',correctedText:'50'},{userAction:'exclude',previousClassification:'DIMENSION'},{userAction:'confirm',previousClassification:'NOT_DIMENSION',ocrText:'15',correctedText:'1,5'},{userAction:'exclude',previousClassification:'NOT_DIMENSION'}]);
assert.deepEqual({tp:metrics.truePositive,fp:metrics.falsePositive,fn:metrics.falseNegative,tn:metrics.trueNegative},{tp:1,fp:1,fn:1,tn:1});assert.equal(metrics.precision,.5);assert.equal(metrics.recall,.5);assert.equal(metrics.f1,.5);

const featureCircle=createCanvas(100,60),featureContext=featureCircle.getContext('2d');featureContext.fillStyle='white';featureContext.fillRect(0,0,100,60);featureContext.strokeStyle='black';featureContext.lineWidth=2;featureContext.beginPath();featureContext.ellipse(24,30,17,18,0,0,Math.PI*2);featureContext.stroke();
const detectedCircle=detectTextContainer(featureContext,{x0:17,y0:25,x1:31,y1:35});assert.equal(detectedCircle.type,'CIRCLE');assert.equal(classifyFeatureId('09',{container:detectedCircle}).classification,'FEATURE_ID');assert.equal(classifyFeatureId('93,1±0,6',{container:detectedCircle}).classification,'OTHER');
assert.equal(classifyFeatureId('12',{container:{type:'NONE'}}).classification,'OTHER');
const featureDimensionMerge=scoreStructuralMerge({text:'09',bbox:{x0:10,y0:10,x1:20,y1:20},classification:'FEATURE_ID'},{text:'93,1±0,6',bbox:{x0:23,y0:10,x1:65,y1:20}},{containerA:detectedCircle,containerB:{type:'NONE'},sameVisualComponent:true,compatibleSemanticSequence:true});assert.equal(featureDimensionMerge.allowed,false);assert.equal(featureDimensionMerge.score,0);
assert.ok(mergeBarrierScore({classification:'FEATURE_ID'},{text:'R3'})>=100);
assert.equal(flagSuspiciousNumericPrefix('918,3±0,5',[{text:'9',possibleFeatureId:true}]).alternatives[0],'18,3±0,5');
assert.equal(flagSuspiciousNumericPrefix('918,3±0,5',[]),null,'numeric prefix is flagged only when independent visual token evidence exists');
for(const value of ['[09] 93,1±0,6','[07] 18,3±0,5','[11] 81,7±0,6']){const tokens=value.match(/\d+(?:[,.]\d+)?|±\d+(?:[,.]\d+)?/g)||[];assert.ok(tokens.length>=2,`keep component tokens for ${value}`)}
assert.equal(parseTechnicalDimension('R3').type,'RADIUS');assert.equal(parseTechnicalDimension('133,3°').type,'ANGLE');
assert.equal(classifyTextSemantics('RAIOS NÃO INDICADOS: 0,3 mm').classification,'TECHNICAL_PROPERTY');
assert.equal(classifyTextSemantics('TOLERÂNCIA NÃO ESPECIFICADA: ±0,5 mm').property,'UNSPECIFIED_TOLERANCE');
assert.equal(classifyTextSemantics('COMPRIMENTO DESENVOLVIDO: 1290±1,0mm').classification,'TECHNICAL_DIMENSION');
assert.equal(classifyTextSemantics('TERMO DE RESPONSABILIDADE: declaro para todos os fins que o desenho atende à lei número 9.279.').classification,'PARAGRAPH');
const weakDCCNumber={id:'dcc-93',page:1,x:698.8,y:45,width:5.2,height:4.6,source:'OCR_LAB',confidence:.95,rawText:'93',geometryEvidence:{dimensionLine:true,compatibleAlignment:true,nearbyProfile:true,arrowTermination:false,extensionLines:false}};
assert.equal(strictCandidateReason(weakDCCNumber,{page:1,width:842,height:595},[]),'NUMERO_SIMPLES_SEM_LINHA_DE_COTA_E_TERMINACAO','a line/border and alignment alone must not validate a plain number');
const dccGate=applyStrictCandidateGate([weakDCCNumber],[{page:1,width:842,height:595}],[]);assert.equal(dccGate.accepted.length,0);assert.equal(dccGate.suggestions.length,1);
const weakTolerance={source:'OCR_LAB',rawText:'8,2±0,3',tolerancePlus:.3,toleranceMinus:.3,documentZone:'DRAWING_AREA',decisionClassification:'NOT_DIMENSION',confidence:0,geometryEvidence:{}};
assert.equal(preserveGeometricToleranceForReview(weakTolerance).decisionClassification,'REVIEW','low OCR/context score must not hide a tolerance attached to dimension geometry');
assert.equal(preserveGeometricToleranceForReview({...weakTolerance,documentZone:'TABLE'}).decisionClassification,'NOT_DIMENSION','administrative tables remain protected');
assert.equal(preserveGeometricToleranceForReview({...weakTolerance,documentZone:'TITLE_BLOCK'}).decisionClassification,'REVIEW','soft title-block proximity must not hide a genuine control-production tolerance from manual review');
const {source:ignoredSource,...toleranceWithoutSource}=weakTolerance;assert.equal(preserveGeometricToleranceForReview(toleranceWithoutSource).decisionClassification,'REVIEW','valid tolerance syntax remains reviewable across vector/OCR sources');
assert.equal(applyStrictCandidateGate([{...weakTolerance,x:300,y:300,width:20,height:6}],[{page:1,width:842,height:595,items:[]}],[]).accepted.length,1,'low-confidence tolerance readings remain in the review queue');
assert.equal(applyStrictCandidateGate([{...weakTolerance,x:300,y:300,width:20,height:6}],[{page:1,width:842,height:595,items:[]}],[{left:0,right:0}]).accepted.length,1,'conflicting tolerance readings remain available for manual resolution');
const annotationPage={page:1,width:500,height:500,items:[{text:'RAIOS NÃO INDICADOS: 0,3 mm'},{text:'COMPRIMENTO DESENVOLVIDO: 1290±1,0mm'}]},annotations=extractTechnicalAnnotations([annotationPage]);assert.deepEqual(annotations.map(item=>item.property),['UNSPECIFIED_RADIUS','DEVELOPED_LENGTH']);assert.equal(annotations[1].geometricDimension,false);
const paragraphRegion=detectParagraphRegions([{page:1,width:500,height:500,items:[{text:'TERMO DE RESPONSABILIDADE declaro para todos os fins do desenho',x:10,y:10,width:250,height:90}]}])[0];assert.equal(paragraphRegion.type,'PARAGRAPH');assert.ok(paragraphRegion.y1-paragraphRegion.y0<30,'paragraph region must not grow from oversized PDF text boxes into drawing areas');
const untouched=splitSuspiciousOCR('918,3±0,5',[{text:'9',bbox:{x0:1,y0:1,x1:5,y1:8}}]);assert.equal(untouched.rawOCRText,'918,3±0,5');assert.equal(untouched.finalText,null);
const graph=buildAssociationGraph([{id:'r',rawText:'R3',dimensionLineId:'dim-1',associatedLeaderLineId:'lead-1',containerId:null}]);assert.ok(graph.edges.some(edge=>edge.relation==='TEXT_TO_LEADER_LINE'));assert.ok(graph.edges.some(edge=>edge.relation==='TEXT_TO_DIMENSION_LINE'));

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
