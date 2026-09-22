const DEFAULT_DIMENSION_DECISION_CONFIG = Object.freeze({
  weights: Object.freeze({
    validFormat: 25,
    dimensionLine: 25,
    arrowTermination: 20,
    leaderLine: 25,
    compatibleAlignment: 15,
    nearbyGeometry: 10,
    technicalSymbol: 15,
    coherentTolerance: 10,
    titleBlock: -80,
    inferredTitleBlock: -40,
    administrativeLabel: -60,
    isolatedNumber: -50,
    technicalNote: -40,
    date: -40,
    scale: -40,
    administrativeMetric: -40,
    farFromGeometry: -30,
    inconsistentGrouping: -30,
  }),
  thresholds: Object.freeze({ dimension: 75, review: 45 }),
  context: Object.freeze({ x: 72, y: 22 }),
});
const { classifyTextSemantics, detectParagraphRegions } = require('./structural-analysis.cjs');

const TITLE_BLOCK_WORDS = /\b(?:cliente|t[ií]tulo|uso\s+final|desenhista|desenhado\s+por|data|revis[aã]o|escala|peso|[aá]rea|per[ií]metro|liga|dcc|planicidade|toler[aâ]ncia|acabamento|estimativa|ferramenta|responsabilidade|aprova[cç][aã]o\s+t[eé]cnica|espessura\s+n[aã]o\s+indicada|raios?\s+n[aã]o\s+indicados|c[oó]digo\s+do\s+perfil)\b/i;
const NOTE_WORDS = /\b(?:aten[cç][aã]o|observa[cç][aã]o|nota(?:s)?|embalagem|inspe[cç][aã]o|pe[cç]as?\s+por\s+amarrado|intercalar)\b/i;
const ADMIN_METRIC = /\b(?:dcc|peso|[aá]rea|per[ií]metro|planicidade|raios?\s+n[aã]o\s+indicados|espessura\s+n[aã]o\s+indicada)\b/i;
const GDT_WORDS = /\b(?:gd&t|datum|paralelismo|perpendicularidade|concentricidade|batimento|circularidade|cilindricidade|retitude)\b/i;

const numeric = value => {
  const result = Number(String(value).replace(',', '.'));
  return Number.isFinite(result) ? result : null;
};

function normalizeOCRText(value) {
  return String(value || '')
    .replace(/[−–—]/g, '-')
    .replace(/[Ø⌀]/g, 'Ø')
    .replace(/\+\s*\/\s*-/g, '±')
    .replace(/\s+/g, ' ')
    .trim();
}

function validTolerance(nominal, upper, lower) {
  return Number.isFinite(nominal) && nominal > 0 && Number.isFinite(upper) && Number.isFinite(lower)
    && upper >= 0 && lower <= 0 && upper < nominal && Math.abs(lower) < nominal;
}

function parseTechnicalDimension(value) {
  const text = normalizeOCRText(value).replace(/\s+/g, '');
  let match = text.match(/^([Ø]?)\s*(\d+(?:[,.]\d+)?)\+(\d+(?:[,.]\d+)?)(?:\/)?-(\d+(?:[,.]\d+)?)$/i);
  if (match) {
    const nominal = numeric(match[2]), upperTolerance = numeric(match[3]), lowerTolerance = -numeric(match[4]);
    if (validTolerance(nominal, upperTolerance, lowerTolerance)) return { type: match[1] ? 'DIAMETER' : 'LINEAR', nominal, upperTolerance, lowerTolerance, symbol: match[1] || '', kind: 'ASYMMETRIC' };
  }
  match = text.match(/^([Ø]?)(\d+(?:[,.]\d+)?)±(\d+(?:[,.]\d+)?)$/i);
  if (match) {
    const nominal = numeric(match[2]), tolerance = numeric(match[3]);
    if (validTolerance(nominal, tolerance, -tolerance)) return { type: match[1] ? 'DIAMETER' : 'LINEAR', nominal, upperTolerance: tolerance, lowerTolerance: -tolerance, symbol: match[1] || '', kind: 'SYMMETRIC' };
  }
  match = text.match(/^R(\d+(?:[,.]\d+)?)$/i);
  if (match && numeric(match[1]) > 0) return { type: 'RADIUS', nominal: numeric(match[1]), upperTolerance: null, lowerTolerance: null, symbol: 'R', kind: 'RADIUS' };
  match = text.match(/^Ø(\d+(?:[,.]\d+)?)$/i);
  if (match && numeric(match[1]) > 0) return { type: 'DIAMETER', nominal: numeric(match[1]), upperTolerance: null, lowerTolerance: null, symbol: 'Ø', kind: 'DIAMETER' };
  match = text.match(/^(\d+(?:[,.]\d+)?)(?:°|DEG)$/i);
  if (match && numeric(match[1]) >= 0 && numeric(match[1]) <= 360) return { type: 'ANGLE', nominal: numeric(match[1]), upperTolerance: null, lowerTolerance: null, symbol: '°', kind: 'ANGLE' };
  match = text.match(/^M(\d+(?:[,.]\d+)?)(?:X(\d+(?:[,.]\d+)?))?$/i);
  if (match && numeric(match[1]) > 0) return { type: 'THREAD', nominal: numeric(match[1]), pitch: match[2] ? numeric(match[2]) : null, upperTolerance: null, lowerTolerance: null, symbol: 'M', kind: 'THREAD' };
  match = text.match(/^(?:C(\d+(?:[,.]\d+)?)|(\d+(?:[,.]\d+)?)X(\d+(?:[,.]\d+)?)(?:°|DEG))$/i);
  if (match) return { type: 'CHAMFER', nominal: numeric(match[1] || match[2]), angle: match[3] ? numeric(match[3]) : null, upperTolerance: null, lowerTolerance: null, symbol: match[1] ? 'C' : '×', kind: 'CHAMFER' };
  match = text.match(/^(\d+(?:[,.]\d+)?)$/);
  if (match) return { type: 'LINEAR', nominal: numeric(match[1]), upperTolerance: null, lowerTolerance: null, symbol: '', kind: 'PLAIN' };
  return null;
}

function center(box) {
  return { x: Number(box.x || 0) + Number(box.width || 0) / 2, y: Number(box.y || 0) + Number(box.height || 0) / 2 };
}

function regionContains(region, candidate) {
  const point = center(candidate);
  return Number(region.page) === Number(candidate.page) && point.x >= region.x0 && point.x <= region.x1 && point.y >= region.y0 && point.y <= region.y1;
}

function clusterDenseFields(items, width, height, pageNumber) {
  const small = items.filter(item => Number(item.width || 0) <= width * .16 && Number(item.height || 0) <= height * .05), clusters = [];
  for (const item of small) {
    const cx = Number(item.x) + Number(item.width || 0) / 2, cy = Number(item.y) + Number(item.height || 0) / 2;
    let cluster = clusters.find(group => Math.abs(group.cx - cx) <= width * .13 && Math.abs(group.cy - cy) <= height * .12);
    if (!cluster) { cluster = { items: [], cx, cy }; clusters.push(cluster); }
    cluster.items.push(item); cluster.cx = cluster.items.reduce((sum, value) => sum + Number(value.x) + Number(value.width || 0) / 2, 0) / cluster.items.length; cluster.cy = cluster.items.reduce((sum, value) => sum + Number(value.y) + Number(value.height || 0) / 2, 0) / cluster.items.length;
  }
  return clusters.filter(cluster => cluster.items.length >= 5).map(cluster => {
    const x0 = Math.max(0, Math.min(...cluster.items.map(item => Number(item.x))) - 10), y0 = Math.max(0, Math.min(...cluster.items.map(item => Number(item.y))) - 10);
    const x1 = Math.min(width, Math.max(...cluster.items.map(item => Number(item.x) + Number(item.width || 0))) + 10), y1 = Math.min(height, Math.max(...cluster.items.map(item => Number(item.y) + Number(item.height || 0))) + 10);
    const rows = new Set(cluster.items.map(item => Math.round(Number(item.y) / Math.max(3, Number(item.height || 5))))).size;
    const columns = new Set(cluster.items.map(item => Math.round(Number(item.x) / Math.max(8, Number(item.width || 12))))).size;
    const keywordCount = cluster.items.filter(item => TITLE_BLOCK_WORDS.test(String(item.text || ''))).length;
    return { page: pageNumber, type: rows >= 3 && columns >= 3 && keywordCount < 2 ? 'TABLE' : 'TITLE_BLOCK', x0, y0, x1, y1, evidence: keywordCount ? 'Campos administrativos agrupados.' : 'Concentração visual de pequenos campos.', visualEvidence: { fieldCount: cluster.items.length, rows, columns, keywordCount } };
  });
}

function detectDocumentZones(pages = [], suppliedRegions = [], candidates = []) {
  const zones = suppliedRegions.map(region => ({ ...region, type: region.type || 'TITLE_BLOCK' }));
  for (const page of pages) {
    zones.push(...detectParagraphRegions([page]));
    const width = Number(page.width) || 842, height = Number(page.height) || 595;
    const items = (page.items || []).filter(item => Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)));
    zones.push(...clusterDenseFields(items, width, height, Number(page.page)));
    const administrative = items.filter(item => TITLE_BLOCK_WORDS.test(String(item.text || '')));
    for (const item of administrative) {
      zones.push({ page: Number(page.page), type: 'TITLE_BLOCK', x0: Math.max(0, Number(item.x) - 16), y0: Math.max(0, Number(item.y) - 28), x1: Math.min(width, Number(item.x) + Number(item.width || 0) + 145), y1: Math.min(height, Number(item.y) + Number(item.height || 0) + 28), evidence: String(item.text) });
    }
    const notes = items.filter(item => NOTE_WORDS.test(String(item.text || '')));
    for (const item of notes) zones.push({ page: Number(page.page), type: 'TECHNICAL_NOTE', x0: Math.max(0, Number(item.x) - 10), y0: Math.max(0, Number(item.y) - 12), x1: Math.min(width, Number(item.x) + Number(item.width || 0) + 70), y1: Math.min(height, Number(item.y) + Number(item.height || 0) + 12), evidence: String(item.text) });
    const gdt = items.filter(item => GDT_WORDS.test(String(item.text || '')));
    for (const item of gdt) zones.push({ page: Number(page.page), type: 'GD&T', x0: Math.max(0, Number(item.x) - 12), y0: Math.max(0, Number(item.y) - 16), x1: Math.min(width, Number(item.x) + Number(item.width || 0) + 90), y1: Math.min(height, Number(item.y) + Number(item.height || 0) + 16), evidence: String(item.text) });
    for (const candidate of candidates.filter(value => Number(value.page) === Number(page.page) && value.geometryEvidence?.dimensionLine)) zones.push({ page: Number(page.page), type: 'DIMENSION_REGION', x0: Math.max(0, Number(candidate.x) - 30), y0: Math.max(0, Number(candidate.y) - 22), x1: Math.min(width, Number(candidate.x) + Number(candidate.width || 0) + 30), y1: Math.min(height, Number(candidate.y) + Number(candidate.height || 0) + 22), evidence: candidate.dimensionLineId || 'Linha de dimensão associada.' });
    zones.push({ page: Number(page.page), type: 'OTHER', subtype: 'HEADER', x0: 0, y0: height * .9, x1: width, y1: height });
  }
  return zones;
}

function extractContext(candidate, page, config = DEFAULT_DIMENSION_DECISION_CONFIG) {
  const point = center(candidate), nearby = (page?.items || []).filter(item => {
    const other = center(item);
    return Math.abs(other.x - point.x) <= config.context.x && Math.abs(other.y - point.y) <= config.context.y;
  });
  const text=nearby.map(item=>item.text).join(' ').replace(/\s+/g,' ').trim();
  return { text, classification:classifyTextSemantics(text), items: nearby.map(item => ({ text: item.text, x: item.x, y: item.y, width: item.width, height: item.height })) };
}

function candidateZone(candidate, zones) {
  const matches = zones.filter(region => regionContains(region, candidate));
  const administrative=matches.find(region => region.type === 'TITLE_BLOCK' || region.type === 'TABELA_REFERENCIA');
  return administrative?.inferredType ? 'INFERRED_TITLE_BLOCK' : administrative?.type
    || matches.find(region => region.type === 'TECHNICAL_NOTE')?.type
    || matches.find(region => region.type === 'PARAGRAPH' || region.type === 'NOTE')?.type
    || matches.find(region => region.type === 'TABLE')?.type
    || matches.find(region => region.type === 'GD&T')?.type
    || matches.find(region => region.type === 'DIMENSION_REGION')?.type
    || 'DRAWING_AREA';
}

function addEvidence(log, key, points, detail) {
  if (!points) return;
  log.push({ key, points, detail });
}

function calculateDimensionScore(candidate, { page, zones = [], conflicted = false, config = DEFAULT_DIMENSION_DECISION_CONFIG } = {}) {
  const weights = config.weights, parsed = parseTechnicalDimension(candidate.rawText || candidate.recognizedText || candidate.ocrText || '');
  const context = extractContext(candidate, page, config), zone = candidateZone(candidate, zones), log = [];
  const text = normalizeOCRText(candidate.rawText || candidate.recognizedText || candidate.ocrText || '');
  const semantic=classifyTextSemantics(`${context.text} ${text}`);
  if (parsed) addEvidence(log, 'VALID_FORMAT', weights.validFormat, `Formato técnico ${parsed.kind}.`);
  if (candidate.geometryEvidence?.dimensionLine || candidate.hasDimensionLine) addEvidence(log, 'DIMENSION_LINE', weights.dimensionLine, 'Linha de dimensão próxima.');
  if (candidate.geometryEvidence?.arrowTermination || candidate.hasArrowTermination) addEvidence(log, 'ARROW_TERMINATION', weights.arrowTermination, 'Terminação ou seta de cota próxima.');
  if(parsed?.type==='RADIUS'&&(candidate.associatedLeaderLineId||candidate.geometryEvidence?.associatedLeaderLineId)&&Number(candidate.geometryEvidence?.leaderLine?.confidence||0)>=.68)addEvidence(log,'LEADER_LINE',weights.leaderLine,'Texto de raio relacionado a uma linha líder; o contato com a curva ainda requer conferência.');
  if (candidate.geometryEvidence?.compatibleAlignment || candidate.compatibleAlignment) addEvidence(log, 'COMPATIBLE_ALIGNMENT', weights.compatibleAlignment, 'Texto alinhado com a linha de dimensão.');
  if (candidate.geometryEvidence?.nearbyProfile || candidate.nearbyGeometry) addEvidence(log, 'NEARBY_GEOMETRY', weights.nearbyGeometry, 'Geometria do perfil próxima.');
  if (parsed && ['RADIUS', 'DIAMETER', 'ANGLE', 'THREAD'].includes(parsed.type)) addEvidence(log, 'TECHNICAL_SYMBOL', weights.technicalSymbol, `Símbolo técnico ${parsed.symbol}.`);
  if (parsed && parsed.upperTolerance !== null) addEvidence(log, 'COHERENT_TOLERANCE', weights.coherentTolerance, 'Tolerância coerente com o nominal.');
  if (zone === 'TITLE_BLOCK' || zone === 'TABELA_REFERENCIA') addEvidence(log, 'TITLE_BLOCK', weights.titleBlock, `Localizado em ${zone}.`);
  if (zone === 'INFERRED_TITLE_BLOCK') addEvidence(log, 'INFERRED_TITLE_BLOCK', weights.inferredTitleBlock, 'Localizado em uma faixa administrativa inferida; requer confirmação visual.');
  if (TITLE_BLOCK_WORDS.test(context.text)) addEvidence(log, 'ADMINISTRATIVE_LABEL', weights.administrativeLabel, `Contexto administrativo: ${context.text.slice(0, 120)}`);
  if (zone === 'TECHNICAL_NOTE' || NOTE_WORDS.test(context.text)) addEvidence(log, 'TECHNICAL_NOTE', weights.technicalNote, 'Localizado junto de nota ou instrução.');
  if (zone === 'PARAGRAPH' || zone === 'NOTE') addEvidence(log,'TEXT_BLOCK',-75,'Dentro de um bloco de texto corrido ou nota; números não são dimensões geométricas.');
  if (/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(context.text)) addEvidence(log, 'DATE', weights.date, 'Aparenta fazer parte de uma data.');
  if (/\bescala\s*\d+\s*:\s*\d+/i.test(context.text) || /^\d+\s*:\s*\d+$/.test(text)) addEvidence(log, 'SCALE', weights.scale, 'Aparenta ser uma escala.');
  if (ADMIN_METRIC.test(context.text)) addEvidence(log, 'ADMINISTRATIVE_METRIC', weights.administrativeMetric, 'Associado a peso, área, perímetro ou outro campo geral.');
  const hasGeometry = Boolean(candidate.geometryEvidence?.dimensionLine || candidate.hasDimensionLine || candidate.geometryEvidence?.nearbyProfile || candidate.nearbyGeometry || candidate.geometryEvidence?.arrowTermination || candidate.hasArrowTermination);
  if (parsed?.kind === 'PLAIN' && !hasGeometry) addEvidence(log, 'ISOLATED_NUMBER', weights.isolatedNumber, 'Número simples sem evidência geométrica.');
  if (candidate.geometryEvidence?.farFromProfile) addEvidence(log, 'FAR_FROM_GEOMETRY', weights.farFromGeometry, 'Distante da geometria do perfil.');
  if (conflicted || candidate.groupingConfidence !== undefined && Number(candidate.groupingConfidence) < .55) addEvidence(log, 'INCONSISTENT_GROUPING', weights.inconsistentGrouping, 'Agrupamento textual inconsistente.');
  const ocrConfidence=Number(candidate.ocrConfidence??candidate.confidence??0);
  const semanticScore = parsed ? (parsed.kind === 'PLAIN' ? .62 : 1) : 0;
  const geometrySignals = [candidate.geometryEvidence?.dimensionLine, candidate.geometryEvidence?.arrowTermination, candidate.geometryEvidence?.compatibleAlignment, candidate.geometryEvidence?.nearbyProfile, candidate.geometryEvidence?.extensionLines,parsed?.type==='RADIUS'&&candidate.geometryEvidence?.associatedLeaderLineId].filter(Boolean).length;
  const geometryScore = Math.min(1, geometrySignals / 4);
  const zoneScore = zone === 'DIMENSION_REGION' || zone === 'DRAWING_AREA' ? 1 : zone === 'INFERRED_TITLE_BLOCK' ? .42 : zone === 'GD&T' ? .5 : zone === 'TECHNICAL_NOTE' || zone === 'TABLE' ? .2 : 0;
  const contextScore = TITLE_BLOCK_WORDS.test(context.text) || ADMIN_METRIC.test(context.text) ? 0 : NOTE_WORDS.test(context.text) ? .25 : 1;
  const groupingScore = candidate.groupingConfidence === undefined ? 1 : Math.max(0, Math.min(1, Number(candidate.groupingConfidence)));
  const scoreComponents = { ocrScore: Math.max(0, Math.min(1, ocrConfidence)), semanticScore, geometryScore, zoneScore, contextScore, groupingScore };
  let score = Math.round(100 * (scoreComponents.ocrScore * .12 + semanticScore * .24 + geometryScore * .34 + zoneScore * .18 + contextScore * .08 + groupingScore * .04));
  if (zone === 'TITLE_BLOCK' || zone === 'TABELA_REFERENCIA' || zone === 'TABLE') score = Math.min(score, 24);
  if (zone === 'TECHNICAL_NOTE') score = Math.min(score, 34);
  if (zone === 'INFERRED_TITLE_BLOCK') score = Math.min(score, 74);
  if (zone === 'INFERRED_TITLE_BLOCK' && parsed?.kind === 'PLAIN' && !(candidate.geometryEvidence?.arrowTermination && candidate.geometryEvidence?.extensionLines)) score = Math.min(score, 39);
  if (zone === 'INFERRED_TITLE_BLOCK' && parsed?.upperTolerance == null && !(candidate.geometryEvidence?.arrowTermination && candidate.geometryEvidence?.extensionLines)) score = Math.min(score, 39);
  if (parsed?.kind === 'PLAIN' && geometrySignals < 2) score = Math.min(score, 39);
  if (parsed?.kind === 'PLAIN' && /^\d{1,2}$/.test(text)) score = Math.min(score, 74);
  if(semantic.classification==='TECHNICAL_PROPERTY')score=Math.min(score,14);
  if(semantic.classification==='TECHNICAL_DIMENSION')score=Math.min(score,74);
  if(['PARAGRAPH','NOTE'].includes(semantic.classification)||zone==='PARAGRAPH'||zone==='NOTE')score=Math.min(score,19);
  if (!parsed) score = Math.min(score, 20);
  const classification = score >= config.thresholds.dimension&&ocrConfidence>=.55 ? 'DIMENSION' : score >= config.thresholds.review ? 'REVIEW' : 'NOT_DIMENSION';
  const semanticType=semantic.classification==='TECHNICAL_DIMENSION'?'TECHNICAL_DIMENSION':semantic.classification==='TECHNICAL_PROPERTY'?'TECHNICAL_PROPERTY':parsed?.type==='RADIUS'?'RADIUS_DIMENSION':parsed?.type==='ANGLE'?'ANGLE_DIMENSION':parsed?.type==='DIAMETER'?'DIAMETER_DIMENSION':parsed?.type==='THREAD'?'THREAD_DIMENSION':parsed?.type==='CHAMFER'?'CHAMFER_DIMENSION':parsed?'LINEAR_DIMENSION':semantic.classification;
  return { score, dimensionConfidence: score / 100, classification, zone, context, parsed, semantic, semanticType, scoreComponents, decisionLog: log };
}

function classifyCandidate(candidate, context = {}) {
  const decision = calculateDimensionScore(candidate, context);
  return { ...candidate, ocrConfidence: Number(candidate.ocrConfidence ?? candidate.confidence ?? 0), dimensionConfidence: decision.dimensionConfidence, dimensionScore: decision.score, scoreComponents: decision.scoreComponents, semanticClass:decision.semanticType, technicalProperty:decision.semantic.classification==='TECHNICAL_PROPERTY'?decision.semantic:null, decisionClassification: decision.classification, documentZone: decision.zone, nearbyContext: decision.context, decisionLog: decision.decisionLog };
}

function classifyCandidates(candidates = [], pages = [], options = {}) {
  const pageMap = new Map(pages.map(page => [Number(page.page), page]));
  const zones = detectDocumentZones(pages, options.regions || [], candidates), conflicted = new Set((options.conflicts || []).flatMap(item => [item.left, item.right]));
  return { zones, candidates: candidates.map((candidate, index) => classifyCandidate(candidate, { page: pageMap.get(Number(candidate.page)), zones, conflicted: conflicted.has(index), config: options.config || DEFAULT_DIMENSION_DECISION_CONFIG })) };
}

function overlapRatio(a, b) {
  const x0 = Math.max(Number(a.x), Number(b.x)), y0 = Math.max(Number(a.y), Number(b.y));
  const x1 = Math.min(Number(a.x) + Number(a.width || 0), Number(b.x) + Number(b.width || 0)), y1 = Math.min(Number(a.y) + Number(a.height || 0), Number(b.y) + Number(b.height || 0));
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0), smallest = Math.min(Number(a.width || 0) * Number(a.height || 0), Number(b.width || 0) * Number(b.height || 0));
  return smallest > 0 ? intersection / smallest : 0;
}

function deduplicateCandidates(candidates = []) {
  const accepted = [];
  for (const candidate of [...candidates].sort((a, b) => Number(b.dimensionConfidence || 0) - Number(a.dimensionConfidence || 0) || Number(b.ocrConfidence || b.confidence || 0) - Number(a.ocrConfidence || a.confidence || 0))) {
    const duplicate = accepted.some(other => Number(other.page) === Number(candidate.page) && (overlapRatio(other, candidate) >= .55 || Math.hypot(center(other).x - center(candidate).x, center(other).y - center(candidate).y) < 8) && Math.abs(Number(other.nominal) - Number(candidate.nominal)) < .11);
    if (!duplicate) accepted.push(candidate);
  }
  return accepted;
}

function isSameDimensionComponent(a, b) {
  const height = Math.max(1, Number(a.height || 0), Number(b.height || 0)), ac = center(a), bc = center(b);
  let score = 0;
  if (Math.abs(ac.y - bc.y) <= height * .65) score += 35;
  if (Math.abs(Number(a.height || 0) - Number(b.height || 0)) <= height * .35) score += 20;
  if (Math.abs(Number(a.rotation || 0) - Number(b.rotation || 0)) <= 5) score += 20;
  if (Math.abs(ac.x - bc.x) <= height * 5) score += 20;
  if (a.dimensionLineId && a.dimensionLineId === b.dimensionLineId) score += 25;
  return Math.max(0, Math.min(100, score));
}

function buildUserFeedback(candidate, { correctedText = null, userAction, classification, crop = null, documentId = null } = {}) {
  return { documentId, candidateId: candidate.id || null, cropPath: crop, crop, page: candidate.page, bbox: { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height }, zone: String(candidate.documentZone || 'OTHER').toLowerCase(), ocrText: candidate.recognizedText || candidate.rawText || '', finalText: correctedText ?? candidate.rawText ?? '', correctedText, classification: classification || (userAction === 'exclude' ? 'not_dimension' : 'dimension'), dimensionType: candidate.dimensionType || null, rotation: candidate.rotation || 0, orientation: candidate.rotation || 0, associatedDimensionLine: candidate.dimensionLineId || candidate.geometryEvidence?.dimensionLineId || null, geometryFeatures: candidate.geometryEvidence || null, semanticFeatures: { scoreComponents: candidate.scoreComponents || null, parsedType: candidate.dimensionType || null, groupingConfidence: candidate.groupingConfidence ?? null }, reason: candidate.decisionLog?.map(item => item.key).join(',') || null, userAction, x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height, ocrConfidence: candidate.ocrConfidence ?? candidate.confidence ?? null, dimensionScore: candidate.dimensionScore ?? null, dimensionConfidence: candidate.dimensionConfidence ?? null, previousClassification: candidate.decisionClassification || null, nearbyContext: candidate.nearbyContext || null, geometryEvidence: candidate.geometryEvidence || null, createdAt: new Date().toISOString() };
}

module.exports = { DEFAULT_DIMENSION_DECISION_CONFIG, TITLE_BLOCK_WORDS, normalizeOCRText, parseTechnicalDimension, detectDocumentZones, extractContext, calculateDimensionScore, classifyCandidate, classifyCandidates, deduplicateCandidates, isSameDimensionComponent, buildUserFeedback };
