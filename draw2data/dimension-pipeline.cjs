const crypto = require('crypto');

const DEFAULT_OCR_PIPELINE_CONFIG = Object.freeze({
  cropExpansionLevels: Object.freeze([1, 1.2, 1.5, 2]),
  rotations: Object.freeze([0, 90, -90, 180]),
  maxCandidatesPerPage: 12,
  acceptScore: .82,
  rotationTriggerScore: .68,
});

function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function expandBox(box, factor, width, height) {
  const cx = (Number(box.x0) + Number(box.x1)) / 2, cy = (Number(box.y0) + Number(box.y1)) / 2;
  const halfWidth = Math.max(2, (Number(box.x1) - Number(box.x0)) * Number(factor) / 2);
  const halfHeight = Math.max(2, (Number(box.y1) - Number(box.y0)) * Number(factor) / 2);
  return { x0: Math.max(0, Math.floor(cx - halfWidth)), y0: Math.max(0, Math.floor(cy - halfHeight)), x1: Math.min(width, Math.ceil(cx + halfWidth)), y1: Math.min(height, Math.ceil(cy + halfHeight)) };
}

function incompleteReadingSignals(text, box = {}, cropBox = {}) {
  const compact = String(text || '').replace(/\s+/g, '');
  const signals = [];
  if (/^(?:\d{1,2}|[±+\-]|[RØ⌀M]|[,.]\d+)$/.test(compact)) signals.push('SHORT_FRAGMENT');
  if (/^[,.]\d+$/.test(compact)) signals.push('DECIMAL_WITHOUT_INTEGER');
  if (/^[±+\-]/.test(compact) && !/\d.*[±+\-]|[±+\-].*\d/.test(compact)) signals.push('TOLERANCE_WITHOUT_NOMINAL');
  if (/^[RØ⌀M]$/i.test(compact)) signals.push('SYMBOL_WITHOUT_VALUE');
  const margin = 2;
  if (Number.isFinite(Number(box.x0)) && (Number(box.x0) <= Number(cropBox.x0 || 0) + margin || Number(box.y0) <= Number(cropBox.y0 || 0) + margin || Number(box.x1) >= Number(cropBox.x1 || Infinity) - margin || Number(box.y1) >= Number(cropBox.y1 || Infinity) - margin)) signals.push('TOUCHES_CROP_EDGE');
  return [...new Set(signals)];
}

function scoreOCRCandidate(reading, parse) {
  const parsed = parse(String(reading.text || ''));
  const ocrScore = clamp(Number(reading.confidence || 0) > 1 ? Number(reading.confidence) / 100 : reading.confidence);
  let semanticScore = 0;
  if (parsed) semanticScore = parsed.kind === 'PLAIN' ? .58 : .9;
  if (parsed && ['RADIUS', 'DIAMETER', 'ANGLE', 'THREAD', 'CHAMFER'].includes(parsed.type || parsed.kind)) semanticScore = .94;
  if (parsed && (parsed.upperTolerance !== null && parsed.upperTolerance !== undefined || parsed.tolerancePlus !== null && parsed.tolerancePlus !== undefined)) semanticScore = 1;
  const incompleteSignals = incompleteReadingSignals(reading.text, reading.bbox, reading.cropBox);
  const completenessScore = clamp(1 - incompleteSignals.length * .2);
  const geometryScore = clamp(reading.geometryScore ?? (reading.geometryEvidence?.dimensionLine ? .65 : 0) + (reading.geometryEvidence?.arrowTermination ? .2 : 0) + (reading.geometryEvidence?.extensionLines ? .15 : 0));
  const finalScore = clamp(ocrScore * .2 + semanticScore * .42 + completenessScore * .23 + geometryScore * .15);
  return { ...reading, parsed, ocrScore, semanticScore, completenessScore, geometryScore, finalScore, incompleteSignals };
}

function chooseBestOCRCandidate(readings, parse) {
  return readings.map(reading => scoreOCRCandidate(reading, parse)).sort((a, b) => b.finalScore - a.finalScore || b.semanticScore - a.semanticScore || b.ocrScore - a.ocrScore)[0] || null;
}

function ocrCacheKey({ documentId, page, bbox, rotation, expansion, psm }) {
  const normalized = [documentId || '', page, ...['x0', 'y0', 'x1', 'y1'].map(key => Math.round(Number(bbox?.[key]) || 0)), rotation || 0, expansion || 1, psm || 7].join('|');
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

class OCRAttemptCache {
  constructor() { this.values = new Map(); this.hits = 0; this.misses = 0; }
  async getOrCreate(key, producer) {
    if (this.values.has(key)) { this.hits += 1; return this.values.get(key); }
    this.misses += 1;
    const value = await producer(); this.values.set(key, value); return value;
  }
  diagnostics() { return { entries: this.values.size, hits: this.hits, misses: this.misses }; }
}

function mergeScore(a, b) {
  const ac = { x: Number(a.x || 0) + Number(a.width || 0) / 2, y: Number(a.y || 0) + Number(a.height || 0) / 2 };
  const bc = { x: Number(b.x || 0) + Number(b.width || 0) / 2, y: Number(b.y || 0) + Number(b.height || 0) / 2 };
  const height = Math.max(1, Number(a.height || 0), Number(b.height || 0));
  let score = 0;
  if (Math.abs(ac.y - bc.y) <= height * .7) score += 22;
  if (Math.abs(ac.x - bc.x) <= height * 6) score += 18;
  if (Math.abs(Number(a.height || 0) - Number(b.height || 0)) <= height * .4) score += 12;
  if (Math.abs(Number(a.rotation || 0) - Number(b.rotation || 0)) <= 5) score += 12;
  if (a.dimensionLineId && a.dimensionLineId === b.dimensionLineId) score += 26;
  const sequence = `${a.rawText || a.text || ''}${b.rawText || b.text || ''}`.replace(/\s+/g, '');
  if (/\d(?:[,.]\d+)?(?:±|\+|\-)\d/.test(sequence) || /^[RØ⌀M]\d/i.test(sequence)) score += 20;
  return Math.max(0, Math.min(100, score));
}

function assembleStackedTolerance(items, parse) {
  const result = [];
  for (const nominal of items.filter(item => /^\d+(?:[,.]\d+)?$/.test(String(item.rawText || item.text || '').trim()))) {
    const height = Math.max(1, Number(nominal.height || 0)), cx = Number(nominal.x || 0) + Number(nominal.width || 0) / 2;
    const nearby = items.filter(item => item !== nominal && Number(item.page) === Number(nominal.page) && Math.abs((Number(item.x || 0) + Number(item.width || 0) / 2) - cx) <= height * 5 && Math.abs(Number(item.y || 0) - Number(nominal.y || 0)) <= height * 4);
    const plus = nearby.find(item => /^\+\s*\d+(?:[,.]\d+)?$/.test(String(item.rawText || item.text || '').trim()));
    const minus = nearby.find(item => /^-\s*\d+(?:[,.]\d+)?$/.test(String(item.rawText || item.text || '').trim()));
    if (!plus || !minus) continue;
    const rawText = `${nominal.rawText || nominal.text}${plus.rawText || plus.text}/${minus.rawText || minus.text}`;
    const parsed = parse(rawText); if (!parsed) continue;
    const components = [nominal, plus, minus];
    result.push({ ...nominal, rawText, recognizedText: rawText, nominal: parsed.nominal, tolerancePlus: parsed.upperTolerance ?? parsed.tolerancePlus, toleranceMinus: Math.abs(parsed.lowerTolerance ?? parsed.toleranceMinus), groupingConfidence: Math.min(mergeScore(nominal, plus), mergeScore(nominal, minus)) / 100, groupedCandidateIds: components.map(item => item.id).filter(Boolean), x: Math.min(...components.map(item => Number(item.x || 0))), y: Math.min(...components.map(item => Number(item.y || 0))), width: Math.max(...components.map(item => Number(item.x || 0) + Number(item.width || 0))) - Math.min(...components.map(item => Number(item.x || 0))), height: Math.max(...components.map(item => Number(item.y || 0) + Number(item.height || 0))) - Math.min(...components.map(item => Number(item.y || 0))) });
  }
  return result;
}

function safeDivide(numerator, denominator) { return denominator ? numerator / denominator : 0; }
function calculateEvaluationMetrics(records = []) {
  let truePositive = 0, falsePositive = 0, falseNegative = 0, trueNegative = 0, ocrCorrect = 0, ocrTotal = 0, geometryErrors = 0;
  for (const row of records) {
    const actual = row.userAction === 'exclude' || row.classification === 'not_dimension' ? 'not_dimension' : 'dimension';
    const predicted = String(row.previousClassification || row.predictedClassification || '').toLowerCase() === 'not_dimension' ? 'not_dimension' : 'dimension';
    if (actual === 'dimension' && predicted === 'dimension') truePositive += 1;
    else if (actual === 'not_dimension' && predicted === 'dimension') falsePositive += 1;
    else if (actual === 'dimension') falseNegative += 1;
    else trueNegative += 1;
    if (row.correctedText !== null && row.correctedText !== undefined) { ocrTotal += 1; if (String(row.correctedText).trim() === String(row.ocrText || '').trim()) ocrCorrect += 1; }
    if (row.reason && /DIMENSION_LINE|ARROW|EXTENSION/i.test(row.reason) && actual !== predicted) geometryErrors += 1;
  }
  const precision = safeDivide(truePositive, truePositive + falsePositive), recall = safeDivide(truePositive, truePositive + falseNegative);
  return { sampleSize: records.length, truePositive, falsePositive, falseNegative, trueNegative, precision, recall, f1: safeDivide(2 * precision * recall, precision + recall), ocrAccuracy: safeDivide(ocrCorrect, ocrTotal), classificationAccuracy: safeDivide(truePositive + trueNegative, records.length), geometryAssociationErrors: geometryErrors };
}

module.exports = { DEFAULT_OCR_PIPELINE_CONFIG, expandBox, incompleteReadingSignals, scoreOCRCandidate, chooseBestOCRCandidate, ocrCacheKey, OCRAttemptCache, mergeScore, assembleStackedTolerance, calculateEvaluationMetrics };
