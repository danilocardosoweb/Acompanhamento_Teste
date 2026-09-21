const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWorker } = require('tesseract.js');
const { loadPdfJs } = require('./pdfjs.cjs');

const SCALE = 5;
const MAX_PAGES = 10;

function number(value) {
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function printable(value) {
  return String(value).replace('.', ',');
}

function validTolerance(nominal, plus, minus) {
  return Number.isFinite(nominal) && Number.isFinite(plus) && Number.isFinite(minus)
    && plus >= 0 && minus >= 0 && plus < nominal && minus < nominal
    && plus <= Math.max(0.2, nominal * 0.35) && minus <= Math.max(0.2, nominal * 0.35);
}

// CAD fonts are often read as #, %, or § where the drawing contains ±.
// We only normalize these glyphs when they sit between two numeric values.
function normalizeTechnicalText(value) {
  let text = String(value || '')
    .replace(/[−–—]/g, '-')
    .replace(/[Ø⌀]/g, '')
    .replace(/\s+/g, '')
    .replace(/([0-9][0-9,.]*)(?:[#%§¤])([0-9][0-9,.]*)/g, '$1±$2');
  text = text.replace(/([0-9][0-9,.]*)\+\/\-?([0-9][0-9,.]*)/g, '$1±$2');
  return text;
}

function parseDimension(value) {
  const symbol = /[Ø⌀]/.test(String(value || '')) ? 'Ø' : '';
  const compact = normalizeTechnicalText(value);
  const asymmetric = compact.match(/^(\d+(?:[,.]\d+)?)(?:mm)?\+(\d+(?:[,.]\d+)?)(?:\/?-(\d+(?:[,.]\d+)?))$/i);
  if (asymmetric) {
    const nominal = number(asymmetric[1]), plus = number(asymmetric[2]), minus = number(asymmetric[3]);
    if (validTolerance(nominal, plus, minus)) return { nominal, tolerancePlus: plus, toleranceMinus: minus, kind: 'ASYMMETRIC', ...(symbol ? { symbol } : {}) };
  }
  const symmetric = compact.match(/^(\d+(?:[,.]\d+)?)(?:mm)?(?:±|\+)(\d+(?:[,.]\d+)?)(?:mm)?$/i);
  if (symmetric) {
    const nominal = number(symmetric[1]), tolerance = number(symmetric[2]);
    if (validTolerance(nominal, tolerance, tolerance)) return { nominal, tolerancePlus: tolerance, toleranceMinus: tolerance, kind: 'SYMMETRIC', ...(symbol ? { symbol } : {}) };
  }
  const plain = compact.match(/^\d+(?:[,.]\d+)?$/);
  if (plain) return { nominal: number(plain[0]), tolerancePlus: null, toleranceMinus: null, kind: 'PLAIN', ...(symbol ? { symbol } : {}) };
  return null;
}

function focusedOnlyForPage(options, pageNumber) {
  if (options.focusedOnly !== true) return false;
  return !(options.fullScanPages || []).some(page => Number(page) === Number(pageNumber));
}

function parseRadiusDimension(value, maxRadius = 100) {
  const compact = String(value || '').replace(/[°]/g, '').replace(/[|]/g, '1').trim();
  const match = compact.match(/\bR\s*(\d+(?:[,.]\d+)?)(?![A-Z0-9])/i);
  if (!match) return null;
  const nominal = number(match[1]);
  if (!Number.isFinite(nominal) || nominal <= 0 || nominal > maxRadius) return null;
  return { nominal, tolerancePlus: null, toleranceMinus: null, kind: 'RADIUS', symbol: 'R' };
}

function parseCompactSymmetric(value) {
  const compact = normalizeTechnicalText(value);
  // Typical OCR recovery: 1,6±0,15 becomes 1,60,15; 8,3±0,2 becomes
  // 8,310,2. A stray digit can also be read from profile edges next to ±,
  // e.g. 1,78±0,15 -> 1,7840,15. The tolerance bounds keep this recovery safe.
  let match = compact.match(/^(\d+(?:[,.]\d{1,2}?))(?:[1-9])?0[,.](\d{1,2})$/);
  if (match) {
    const nominal = number(match[1]), tolerance = number(`0,${match[2]}`);
    if (validTolerance(nominal, tolerance, tolerance)) return { nominal, tolerancePlus: tolerance, toleranceMinus: tolerance, kind: 'SYMMETRIC_COMPACT' };
  }
  // The same loss can occur when the nominal is an integer: 2±0,15 -> 210,15.
  match = compact.match(/^(\d{1,2}?)(?:1)?0[,.](\d{1,2})$/);
  if (match) {
    const nominal = number(match[1]), tolerance = number(`0,${match[2]}`);
    if (validTolerance(nominal, tolerance, tolerance)) return { nominal, tolerancePlus: tolerance, toleranceMinus: tolerance, kind: 'SYMMETRIC_COMPACT' };
  }
  return null;
}

function parseNearbyDimension(value) {
  const direct = parseRadiusDimension(value, 25) || parseDimension(value);
  if (direct && direct.kind !== 'PLAIN') return direct;
  // Only use this ambiguous recovery inside a crop anchored to another known
  // dimension. For example, OCR may flatten "6 ± 0,13" into "60,13".
  return parseCompactSymmetric(value) || direct;
}

function isDimensionInk(red, green, blueChannel) {
  const blueInk = blueChannel > red + 35 && blueChannel > green + 22;
  const darkest = Math.min(red, green, blueChannel);
  const lightest = Math.max(red, green, blueChannel);
  const neutralDarkInk = lightest < 210 && lightest - darkest < 48;
  return blueInk || neutralDarkInk;
}

function buildBlueTextMask(context) {
  const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const { width, height, data } = image;
  const blue = new Uint8Array(width * height);

  for (let index = 0; index < blue.length; index += 1) {
    const offset = index * 4;
    // Drawings do not use a consistent color convention: some have blue
    // dimensions over black/blue geometry, while others (such as DIN-004)
    // have black dimensions over a blue profile. Keep both blue ink and
    // neutral dark ink, then remove long construction lines below.
    if (isDimensionInk(data[offset], data[offset + 1], data[offset + 2])) blue[index] = 1;
  }

  // Extension lines are much longer than a character. Delete only long
  // uninterrupted runs, preserving the short strokes that form ± and digits.
  const filtered = blue.slice();
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      if (x < width && blue[y * width + x]) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        if (x - start > 110) for (let cursor = start; cursor < x; cursor += 1) filtered[y * width + cursor] = 0;
        start = -1;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let start = -1;
    for (let y = 0; y <= height; y += 1) {
      if (y < height && blue[y * width + x]) {
        if (start < 0) start = y;
      } else if (start >= 0) {
        if (y - start > 110) for (let cursor = start; cursor < y; cursor += 1) filtered[cursor * width + x] = 0;
        start = -1;
      }
    }
  }

  for (let index = 0; index < filtered.length; index += 1) {
    const offset = index * 4;
    const ink = filtered[index] ? 0 : 255;
    data[offset] = ink;
    data[offset + 1] = ink;
    data[offset + 2] = ink;
    data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function findRedFrames(context) {
  const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const { width, height, data } = image;
  const red = new Uint8Array(width * height);
  for (let index = 0; index < red.length; index += 1) {
    const offset = index * 4;
    if (data[offset] > 155 && data[offset] > data[offset + 1] + 55 && data[offset] > data[offset + 2] + 55) red[index] = 1;
  }
  const visited = new Uint8Array(red.length), frames = [];
  for (let start = 0; start < red.length; start += 1) {
    if (!red[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let left = width, right = 0, top = height, bottom = 0, count = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const point = queue[cursor], x = point % width, y = Math.floor(point / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); count += 1;
      for (const next of [point - 1, point + 1, point - width, point + width]) {
        if (next >= 0 && next < red.length && red[next] && !visited[next]) { visited[next] = 1; queue.push(next); }
      }
    }
    const boxWidth = right - left + 1, boxHeight = bottom - top + 1;
    // Frames around critical cotas are rectangular and thin. Red hatching from
    // the profile is excluded by its narrow, long components.
    if (count >= 40 && boxWidth >= 80 && boxHeight >= 20 && boxWidth <= 420 && boxHeight <= 180
      && boxWidth / boxHeight <= 12 && count <= (boxWidth + boxHeight) * 8) frames.push({ x0: left, y0: top, x1: right, y1: bottom });
  }
  return frames.slice(0, 40);
}

function crop(factory, canvas, box, padding = 8) {
  const x0 = Math.max(0, Math.floor(box.x0 - padding)), y0 = Math.max(0, Math.floor(box.y0 - padding));
  const x1 = Math.min(canvas.width, Math.ceil(box.x1 + padding)), y1 = Math.min(canvas.height, Math.ceil(box.y1 + padding));
  const result = factory.create(x1 - x0, y1 - y0);
  result.context.fillStyle = 'white';
  result.context.fillRect(0, 0, result.canvas.width, result.canvas.height);
  result.context.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return result;
}

function firstNumericValue(text) {
  const values = [...normalizeTechnicalText(text).matchAll(/\d+(?:[,.]\d+)?/g)]
    .map(match => number(match[0]))
    .filter(value => value !== null && value >= .5 && value <= 500);
  return values[0] ?? null;
}

function toleranceValue(text) {
  const value = firstNumericValue(text);
  if (value === null) return null;
  if (value <= 5) return value;
  // On compact boxed cotas, an adjacent line can become a leading "1" in
  // OCR output: "10,3" for "0,3". This recovery is deliberately limited to
  // values that cannot be a plausible profile tolerance.
  const compact = normalizeTechnicalText(text);
  const artifact = compact.match(/^1?0[,.](\d{1,2})$/);
  return artifact ? number(`0,${artifact[1]}`) : value;
}

function parseFocusedDimension(fullText, leftText, rightText) {
  for (const value of [fullText, leftText, rightText]) {
    const direct = parseDimension(String(value || '').replace(/\s+/g, ''));
    if (direct && direct.kind !== 'PLAIN') return { parsed: direct, inferred: false };
  }
  // Keep line breaks here. Removing them can merge two OCR passes and turn
  // "+0,3" followed by "8,213" into the false tolerance "+0,38".
  const source = String(fullText || '').replace(/[−–—]/g, '-');
  const nominal = firstNumericValue(leftText);
  const plusMatch = source.match(/\+(\d+(?:[,.]\d+)?)/);
  const minusMatch = source.match(/-(\d+(?:[,.]\d+)?)/);
  const plus = plusMatch ? number(plusMatch[1]) : null;
  const minus = minusMatch ? number(minusMatch[1]) : null;
  if (nominal !== null && plus !== null && minus !== null && validTolerance(nominal, plus, minus)) {
    return { parsed: { nominal, tolerancePlus: plus, toleranceMinus: minus, kind: 'ASYMMETRIC' }, inferred: true };
  }
  // A framed label containing exactly one nominal on the left and one small
  // value on the right is the CAD convention for a symmetric tolerance. The
  // result remains in review because the ± glyph itself was not read safely.
  const tolerance = toleranceValue(rightText);
  if (nominal !== null && tolerance !== null && validTolerance(nominal, tolerance, tolerance)) {
    return { parsed: { nominal, tolerancePlus: tolerance, toleranceMinus: tolerance, kind: 'SYMMETRIC' }, inferred: true };
  }
  return null;
}

function rotate(factory, canvas, angle) {
  if (!angle) return { canvas, width: canvas.width, height: canvas.height, owned: false };
  const result = factory.create(canvas.height, canvas.width);
  result.context.translate(canvas.height, 0);
  result.context.rotate(Math.PI / 2);
  result.context.drawImage(canvas, 0, 0);
  return { canvas: result.canvas, width: result.canvas.width, height: result.canvas.height, owned: true, surface: result };
}

function originalBox(box, angle, originalHeight) {
  if (!angle) return box;
  return { x0: box.y0, y0: originalHeight - box.x1, x1: box.y1, y1: originalHeight - box.x0 };
}

function center(box) {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

function isBalloonToken(context, box) {
  const width = context.canvas.width, height = context.canvas.height;
  const pixels = context.getImageData(0, 0, width, height).data;
  const ink = (x, y) => x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4] < 128;
  const margin = Math.max(8, Math.round((box.y1 - box.y0) * 0.8));
  const left = Math.max(0, Math.floor(box.x0 - margin)), right = Math.min(width - 1, Math.ceil(box.x1 + margin));
  const top = Math.max(0, Math.floor(box.y0 - margin)), bottom = Math.min(height - 1, Math.ceil(box.y1 + margin));
  const probes = [
    [Math.round((left + right) / 2), top], [Math.round((left + right) / 2), bottom],
    [left, Math.round((top + bottom) / 2)], [right, Math.round((top + bottom) / 2)],
  ];
  const hits = probes.filter(([x, y]) => {
    for (let dx = -3; dx <= 3; dx += 1) for (let dy = -3; dy <= 3; dy += 1) if (ink(x + dx, y + dy)) return true;
    return false;
  }).length;
  return hits >= 3;
}

function makeCandidate(parsed, rawText, box, page, angle, originalHeight, confidence, reason) {
  const original = originalBox(box, angle, originalHeight);
  const symmetric = parsed.tolerancePlus !== null && Math.abs(parsed.tolerancePlus - parsed.toleranceMinus) < 1e-9;
  const canonical = parsed.kind === 'RADIUS'
    ? `R${printable(parsed.nominal)}`
    : `${parsed.symbol === 'Ø' ? 'Ø' : ''}${parsed.tolerancePlus === null
      ? printable(parsed.nominal)
      : `${printable(parsed.nominal)}${symmetric ? ' ± ' : ' +'}${printable(parsed.tolerancePlus)}${symmetric ? '' : ` / -${printable(parsed.toleranceMinus)}`}`}`;
  return {
    rawText: canonical,
    recognizedText: canonical,
    nominal: parsed.nominal,
    tolerancePlus: parsed.tolerancePlus,
    toleranceMinus: parsed.toleranceMinus,
    symbol: parsed.symbol || '',
    page,
    x: original.x0 / SCALE,
    y: (originalHeight - original.y1) / SCALE,
    width: (original.x1 - original.x0) / SCALE,
    height: (original.y1 - original.y0) / SCALE,
    rotation: angle,
    confidence: Math.max(0, Math.min(.98, confidence)),
    dimensionType: parsed.kind === 'RADIUS' ? 'RADIUS' : 'LINEAR',
    source: 'OCR_LAB',
    status: 'REVISAR',
    reviewReason: reason,
  };
}

function nearbyCompound(words, index) {
  const base = words[index], parsedBase = parseDimension(base.text);
  if (!parsedBase || parsedBase.kind !== 'PLAIN') return null;
  const baseCenter = center(base.bbox), height = Math.max(16, base.bbox.y1 - base.bbox.y0);
  const candidates = words
    .filter((word, candidateIndex) => candidateIndex !== index)
    .map(word => ({ word, parsed: normalizeTechnicalText(word.text), c: center(word.bbox) }))
    .filter(({ word, c }) => c.x > baseCenter.x + height * .25
      && c.x <= baseCenter.x + height * 8
      && Math.abs(c.y - baseCenter.y) <= height * 1.6)
    .sort((a, b) => Math.hypot(a.c.x - baseCenter.x, a.c.y - baseCenter.y) - Math.hypot(b.c.x - baseCenter.x, b.c.y - baseCenter.y));

  const plus = candidates.find(({ parsed }) => /^\+\d+(?:[,.]\d+)?$/.test(parsed));
  if (!plus) return null;
  const minus = candidates.find(({ parsed, c }) => /^-\d+(?:[,.]\d+)?$/.test(parsed)
    && Math.abs(c.x - plus.c.x) <= height * 1.6
    && Math.abs(c.y - plus.c.y) <= height * 4);
  const assembled = `${base.text}${plus.parsed}${minus ? `/${minus.parsed}` : ''}`;
  const parsed = parseDimension(assembled);
  if (!parsed || parsed.kind === 'PLAIN') return null;
  const boxes = [base.bbox, plus.word.bbox, minus?.word.bbox].filter(Boolean);
  return { parsed, rawText: assembled, bbox: { x0: Math.min(...boxes.map(item => item.x0)), y0: Math.min(...boxes.map(item => item.y0)), x1: Math.max(...boxes.map(item => item.x1)), y1: Math.max(...boxes.map(item => item.y1)) }, confidence: Math.min(base.confidence, plus.word.confidence, minus?.word.confidence ?? 100) / 100 };
}

function nearbyRadius(words, index) {
  const base = words[index];
  if (!/^R$/i.test(String(base?.text || '').trim())) return null;
  const origin = center(base.bbox), height = Math.max(12, base.bbox.y1 - base.bbox.y0);
  const candidate = words.map((word, candidateIndex) => ({ word, candidateIndex, center: center(word.bbox), parsed: parseDimension(word.text) }))
    .filter(item => item.candidateIndex !== index && item.parsed?.kind === 'PLAIN'
      && item.parsed.nominal > 0 && item.parsed.nominal <= 25
      && item.center.x > origin.x && item.center.x - origin.x <= height * 4
      && Math.abs(item.center.y - origin.y) <= height * 1.5)
    .sort((a, b) => Math.hypot(a.center.x - origin.x, a.center.y - origin.y) - Math.hypot(b.center.x - origin.x, b.center.y - origin.y))[0];
  if (!candidate) return null;
  const parsed = { nominal: candidate.parsed.nominal, tolerancePlus: null, toleranceMinus: null, kind: 'RADIUS', symbol: 'R' };
  return { parsed, bbox: { x0: Math.min(base.bbox.x0, candidate.word.bbox.x0), y0: Math.min(base.bbox.y0, candidate.word.bbox.y0), x1: Math.max(base.bbox.x1, candidate.word.bbox.x1), y1: Math.max(base.bbox.y1, candidate.word.bbox.y1) }, confidence: Math.min(base.confidence, candidate.word.confidence) / 100 };
}

async function scanNearDetectedDimensions(document, worker, surface, all, pageNumber) {
  // Sample the page by region, preferring linear/toleranced dimensions over
  // radii. A page with many radius callouts must not spend every recovery crop
  // around those callouts and miss the profile's other dimensions.
  const pageItems = all.filter(item => item.page === pageNumber && Number.isFinite(Number(item.x)));
  const ranked = pageItems.sort((a, b) => {
    const score = item => item.symbol === 'R' ? 2 : item.tolerancePlus !== null || item.toleranceMinus !== null ? 0 : 1;
    return score(a) - score(b) || b.confidence - a.confidence;
  });
  const anchors = [];
  const occupiedCells = new Set();
  for (const item of ranked) {
    const cell = `${Math.min(2, Math.floor((item.x + (item.width || 0) / 2) / Math.max(1, surface.canvas.width / SCALE) * 3))}:${Math.min(2, Math.floor((item.y + (item.height || 0) / 2) / Math.max(1, surface.canvas.height / SCALE) * 3))}`;
    if (occupiedCells.has(cell)) continue;
    occupiedCells.add(cell);
    anchors.push(item);
    if (anchors.length >= 9) break;
  }
  const scanned = new Set();
  for (const anchor of anchors) {
    const signature = `${Math.round(anchor.x)}|${Math.round(anchor.y)}`;
    if (scanned.has(signature)) continue;
    scanned.add(signature);
    const marginX = Math.max(180, Math.min(240, Math.max(anchor.width || 0, anchor.height || 0) * 8));
    const marginY = Math.max(100, Math.min(150, Math.max(anchor.width || 0, anchor.height || 0) * 5));
    const region = {
      x0: Math.max(0, Math.floor((anchor.x - marginX) * SCALE)),
      x1: Math.min(surface.canvas.width, Math.ceil((anchor.x + anchor.width + marginX) * SCALE)),
      y0: Math.max(0, Math.floor(surface.canvas.height - (anchor.y + anchor.height + marginY) * SCALE)),
      y1: Math.min(surface.canvas.height, Math.ceil(surface.canvas.height - (anchor.y - marginY) * SCALE)),
    };
    if (region.x1 <= region.x0 || region.y1 <= region.y0) continue;
    const focused = crop(document.canvasFactory, surface.canvas, region, 0);
    const scale = 2;
    const enlarged = document.canvasFactory.create(focused.canvas.width * scale, focused.canvas.height * scale);
    enlarged.context.imageSmoothingEnabled = false;
    enlarged.context.drawImage(focused.canvas, 0, 0, focused.canvas.width, focused.canvas.height, 0, 0, enlarged.canvas.width, enlarged.canvas.height);
    try {
      for (const psm of [11, 6]) {
        await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '0123456789.,+-±Rr' });
        const { data } = await worker.recognize(enlarged.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
        const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []));
        for (const line of lines) {
          if (!line.bbox) continue;
          const text = String(line.text || '').trim();
          const parsed = parseNearbyDimension(text);
          if (!parsed) continue;
          if (parsed.kind === 'PLAIN' && (parsed.nominal < .5 || parsed.nominal > 500)) continue;
          const box = { x0: region.x0 + line.bbox.x0 / scale, y0: region.y0 + line.bbox.y0 / scale, x1: region.x0 + line.bbox.x1 / scale, y1: region.y0 + line.bbox.y1 / scale };
          const reason = parsed.kind === 'RADIUS'
            ? 'Raio identificado pelo símbolo R em uma região ampliada. Confira a leitura.'
            : parsed.kind === 'PLAIN'
              ? 'Cota linear sem tolerância recuperada em uma região ampliada. Confira a associação com as linhas de cota.'
            : parsed.kind === 'SYMMETRIC_COMPACT'
              ? 'Tolerância simétrica reconstruída em uma região ampliada. Confira a leitura.'
              : 'Cota técnica adicional lida perto de outra cota. Confira a posição no desenho.';
          const candidate = makeCandidate(parsed, text, box, pageNumber, 0, surface.canvas.height, Number(line.confidence || data.confidence || 0) / 100, reason);
          if (parsed.kind === 'PLAIN') candidate.confidence = Math.min(candidate.confidence, .65);
          all.push(candidate);
        }
      }
    } finally {
      document.canvasFactory.destroy(enlarged);
      document.canvasFactory.destroy(focused);
    }
  }
}

function shouldRunNeighborhoodRecovery({ flatBarRecovery = false, pageDimensionCount = 0, radiusCount = 0, linearCount = 0 } = {}) {
  return flatBarRecovery || pageDimensionCount < 5 || (radiusCount >= 3 && linearCount < radiusCount);
}

async function scanFlatBarFineTiles(document, worker, surface, all, pageNumber) {
  // A few legacy BC sheets have garbled vector text and very small dimensions
  // embedded in the page image. Only invoke this slower recovery when the
  // normal page and neighborhood passes found nothing.
  for (const angle of [0, 90]) {
    const view = rotate(document.canvasFactory, surface.canvas, angle);
    const overlap = Math.max(36, Math.round(Math.min(view.width, view.height) * .025));
    const tileWidth = Math.ceil(view.width / 4), tileHeight = Math.ceil(view.height / 4);
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const tile = {
        x0: Math.max(0, column * tileWidth - overlap),
        y0: Math.max(0, row * tileHeight - overlap),
        x1: Math.min(view.width, (column + 1) * tileWidth + overlap),
        y1: Math.min(view.height, (row + 1) * tileHeight + overlap),
      };
      const focused = crop(document.canvasFactory, view.canvas, tile, 0);
      try {
        for (const psm of (angle === 0 ? [11, 6] : [11])) {
          await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '0123456789.,+-±Rr' });
          const { data } = await worker.recognize(focused.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
          const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []));
          for (const line of lines) {
            if (!line.bbox) continue;
            const text = String(line.text || '').trim();
            const parsed = parseNearbyDimension(text);
            if (!parsed || parsed.kind === 'PLAIN') continue;
            const box = { x0: tile.x0 + line.bbox.x0, y0: tile.y0 + line.bbox.y0, x1: tile.x0 + line.bbox.x1, y1: tile.y0 + line.bbox.y1 };
            const reason = parsed.kind === 'RADIUS'
              ? 'Raio candidato localizado na varredura ampliada da barra. Confira no desenho.'
              : parsed.kind === 'SYMMETRIC_COMPACT'
                ? 'Tolerância reconstruída na varredura ampliada da barra. Confira no desenho.'
                : 'Cota localizada na varredura ampliada da barra. Confira no desenho.';
            all.push(makeCandidate(parsed, text, box, pageNumber, angle, surface.canvas.height, Number(line.confidence || data.confidence || 0) / 100, reason));
          }
        }
      } finally {
        document.canvasFactory.destroy(focused);
      }
    }
    if (view.owned) document.canvasFactory.destroy(view.surface);
  }
}

function distinct(candidates) {
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    const duplicate = accepted.some(other => other.page === candidate.page
      && Math.hypot(other.x - candidate.x, other.y - candidate.y) < 14
      && String(other.symbol || '') === String(candidate.symbol || '')
      && Math.abs(other.nominal - candidate.nominal) < .1
      && (other.tolerancePlus ?? null) === (candidate.tolerancePlus ?? null)
      && (other.toleranceMinus ?? null) === (candidate.toleranceMinus ?? null));
    if (!duplicate) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

async function extractLabDimensions(buffer, options = {}) {
  const pdfjs = await loadPdfJs();
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true, useSystemFonts: true }).promise;
  // Vercel's deployed bundle is read-only. Its temporary directory is writable
  // for the lifetime of the function and lets Tesseract reuse the language data.
  const cachePath = process.env.VERCEL ? path.join(os.tmpdir(), 'draw2data-cache', 'lab') : path.join(__dirname, '..', '.draw2data-cache', 'lab');
  fs.mkdirSync(cachePath, { recursive: true });
  let worker;
  const all = [];
  try {
    const maxPages = Math.min(document.numPages, Math.max(1, Math.min(MAX_PAGES, Number(options.maxPages) || MAX_PAGES)));
    worker = await createWorker('eng', 1, { cachePath });
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const focusedOnlyPage = focusedOnlyForPage(options, pageNumber);
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: SCALE });
      if (viewport.width * viewport.height > 32000000) throw Error('Página grande demais para a leitura experimental.');
      const surface = document.canvasFactory.create(viewport.width, viewport.height);
      await page.render({ canvasContext: surface.context, viewport }).promise;
      const redFrames = findRedFrames(surface.context);
      buildBlueTextMask(surface.context);

      // Some customers mark critical cotas with a red rectangular frame. The
      // frame provides an exact crop for stacked tolerances that general OCR
      // often splits into separate, unrelated lines.
      const framedNominals = [];
      for (const frame of redFrames) {
        const focused = crop(document.canvasFactory, surface.canvas, frame, 30);
        try {
          const readings = [];
          let focusedDimension = null;
          for (const psm of focusedOnlyPage ? [6] : [6, 11]) {
            await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '0123456789.,+-±' });
            const { data } = await worker.recognize(focused.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
            readings.push(String(data.text || ''));
            const parsed = parseDimension(String(data.text || '').replace(/\s+/g, ''));
            if (parsed && parsed.kind !== 'PLAIN') {
              focusedDimension = parsed;
              framedNominals.push({ nominal: parsed.nominal, frame });
              all.push(makeCandidate(parsed, data.text, frame, pageNumber, 0, surface.canvas.height, Math.max(.55, Number(data.confidence || 0) / 100), 'Cota crítica lida dentro da marcação do desenho. Confira a leitura.'));
            }
          }
          if (!focusedDimension) {
            const middle = (frame.x0 + frame.x1) / 2;
            const left = crop(document.canvasFactory, surface.canvas, { x0: frame.x0, y0: frame.y0, x1: middle, y1: frame.y1 }, 6);
            const right = crop(document.canvasFactory, surface.canvas, { x0: middle, y0: frame.y0, x1: frame.x1, y1: frame.y1 }, 6);
            try {
              await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.,+-±' });
              const leftResult = await worker.recognize(left.canvas.toBuffer('image/png'));
              const rightResult = await worker.recognize(right.canvas.toBuffer('image/png'));
              const leftNominal = firstNumericValue(leftResult.data.text);
              if (leftNominal !== null) framedNominals.push({ nominal: leftNominal, frame });
              const focusedResult = parseFocusedDimension(readings.join('|'), leftResult.data.text, rightResult.data.text);
              if (focusedResult) {
                all.push(makeCandidate(focusedResult.parsed, readings.join(' '), frame, pageNumber, 0, surface.canvas.height, focusedResult.inferred ? .58 : .72, focusedResult.inferred ? 'Tolerância reconstruída dentro da marcação crítica. Confira a leitura.' : 'Cota crítica lida dentro da marcação do desenho. Confira a leitura.'));
              }
            } finally {
              document.canvasFactory.destroy(left);
              document.canvasFactory.destroy(right);
            }
          }
        } finally {
          document.canvasFactory.destroy(focused);
        }
      }

      // Repeated framed labels commonly appear on symmetrical walls of the
      // same profile. When one copy exposes the stacked tolerance and the
      // other exposes only its nominal, carry the matched tolerance over as a
      // low-confidence review item instead of silently dropping that cota.
      for (const framed of framedNominals) {
        const x = framed.frame.x0 / SCALE, y = (surface.canvas.height - framed.frame.y1) / SCALE;
        const alreadyRead = all.some(item => item.page === pageNumber && item.tolerancePlus !== null && Math.hypot(item.x - x, item.y - y) < 16);
        if (alreadyRead) continue;
        const matching = all.find(item => item.page === pageNumber && item.tolerancePlus !== null && Math.abs(item.nominal - framed.nominal) < .001);
        if (matching) {
          all.push(makeCandidate({ nominal: framed.nominal, tolerancePlus: matching.tolerancePlus, toleranceMinus: matching.toleranceMinus }, printable(framed.nominal), framed.frame, pageNumber, 0, surface.canvas.height, .4, 'Tolerância repetida de uma cota crítica simétrica. Confira a leitura.'));
        }
      }

      if (focusedOnlyPage) {
        document.canvasFactory.destroy(surface);
        continue;
      }

      // A whole-sheet read can skip small labels that are close to profile
      // lines. Four overlapping tiles give those compact cotas their own OCR
      // context while only accepting an explicit tolerance pattern.
      const overlap = Math.max(50, Math.round(Math.min(surface.canvas.width, surface.canvas.height) * .035));
      const halfWidth = Math.round(surface.canvas.width / 2), halfHeight = Math.round(surface.canvas.height / 2);
      const tiles = [
        { x0: 0, y0: 0, x1: halfWidth + overlap, y1: halfHeight + overlap },
        { x0: halfWidth - overlap, y0: 0, x1: surface.canvas.width, y1: halfHeight + overlap },
        { x0: 0, y0: halfHeight - overlap, x1: halfWidth + overlap, y1: surface.canvas.height },
        { x0: halfWidth - overlap, y0: halfHeight - overlap, x1: surface.canvas.width, y1: surface.canvas.height },
      ];
      for (const tile of tiles) {
        const cropped = crop(document.canvasFactory, surface.canvas, tile, 0);
        try {
          for (const psm of [11, 6]) {
            await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '0123456789.,+-±' });
            const { data } = await worker.recognize(cropped.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
            const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []));
            for (const line of lines) {
              const parsed = parseDimension(line.text) || parseCompactSymmetric(line.text);
              if (!parsed || parsed.kind === 'PLAIN' || !line.bbox) continue;
              const box = { x0: tile.x0 + line.bbox.x0, y0: tile.y0 + line.bbox.y0, x1: tile.x0 + line.bbox.x1, y1: tile.y0 + line.bbox.y1 };
              const reason = parsed.kind === 'SYMMETRIC_COMPACT'
                ? 'Símbolo de tolerância reconstruído da escrita compacta. Confira a leitura.'
                : 'Cota compacta lida em uma região ampliada do desenho. Confira a leitura.';
              all.push(makeCandidate(parsed, line.text, box, pageNumber, 0, surface.canvas.height, Number(line.confidence || 0) / 100, reason));
            }
          }
        } finally {
          document.canvasFactory.destroy(cropped);
        }
      }

      const pageDimensionCount = distinct(all.filter(item => item.page === pageNumber)).length;
      const pageItems = all.filter(item => item.page === pageNumber);
      const radiusCount = pageItems.filter(item => item.symbol === 'R' || item.dimensionType === 'RADIUS').length;
      const linearCount = pageItems.length - radiusCount;
      if (options.focusedNeighbors && shouldRunNeighborhoodRecovery({ flatBarRecovery: options.flatBarRecovery, pageDimensionCount, radiusCount, linearCount })) {
        await scanNearDetectedDimensions(document, worker, surface, all, pageNumber);
      }
      if (options.flatBarRecovery && !all.some(item => item.page === pageNumber)) await scanFlatBarFineTiles(document, worker, surface, all, pageNumber);

      for (const angle of [0, 90]) {
        const view = rotate(document.canvasFactory, surface.canvas, angle);
        for (const psm of [11, 6]) {
          await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '' });
          const { data } = await worker.recognize(view.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
          const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []));
          // Tesseract v6 does not always materialize data.words when block output
          // is requested. Lines retain their bounding boxes and are a stable
          // geometric unit for CAD text, so they are a safe fallback.
          const sourceTokens = data.words?.length ? data.words : lines;
          const words = sourceTokens
            .filter(word => (/\d/.test(word.text || '') || /^R$/i.test(String(word.text || '').trim())) && word.bbox)
            .map(word => ({ text: String(word.text).trim(), bbox: word.bbox, confidence: Number(word.confidence || 0) }));
          for (let index = 0; index < words.length; index += 1) {
            const word = words[index];
            const radius = parseRadiusDimension(word.text, 25);
            const splitRadius = !radius ? nearbyRadius(words, index) : null;
            if (splitRadius) {
              all.push(makeCandidate(splitRadius.parsed, `R${printable(splitRadius.parsed.nominal)}`, splitRadius.bbox, pageNumber, angle, surface.canvas.height, splitRadius.confidence, 'Raio identificado pelo símbolo R e pelo número adjacente. Confira a leitura.'));
              continue;
            }
            const parsed = radius || parseDimension(word.text);
            const compound = !radius && parsed?.kind === 'PLAIN' ? nearbyCompound(words, index) : null;
            if (compound) {
              all.push(makeCandidate(compound.parsed, compound.rawText, compound.bbox, pageNumber, angle, surface.canvas.height, compound.confidence, 'Tolerância agrupada pela posição no desenho. Confira a leitura.'));
              continue;
            }
            if (!parsed) continue;
            // PSM 6 is a recovery pass for compact technical text. Plain values
            // from this mode are too prone to profile geometry and are ignored.
            if (psm === 6 && parsed.kind === 'PLAIN') continue;
            if (parsed.kind === 'PLAIN') {
              // A short, low-confidence number is commonly a fragment of a
              // tolerance or arrow, never a safe production control point.
              if (word.confidence < 60 || parsed.nominal < .5 || parsed.nominal > 500) continue;
              const isInteger = Number.isInteger(parsed.nominal);
              if ((isInteger && parsed.nominal <= 99) && isBalloonToken(view.surface?.context || surface.context, word.bbox)) continue;
              if (isInteger && parsed.nominal <= 12) continue;
            }
            const reason = parsed.kind === 'RADIUS'
              ? 'Raio identificado pelo símbolo R. Confira o valor e a posição no desenho.'
              : parsed.kind === 'PLAIN'
              ? 'Cota sem tolerância explícita. Confira no desenho.'
              : 'Leitura técnica pela posição de nominal e tolerância. Confira no desenho.';
            all.push(makeCandidate(parsed, word.text, word.bbox, pageNumber, angle, surface.canvas.height, word.confidence / 100, reason));
          }
        }
        if (view.owned) document.canvasFactory.destroy(view.surface);
      }
      document.canvasFactory.destroy(surface);
    }
  } finally {
    await worker?.terminate();
    await document.destroy();
  }
  const result = distinct(all).map((candidate, index) => ({ ...candidate, id: `lab-${candidate.page}-${index + 1}` }));
  return result;
}

module.exports = { extractLabDimensions, parseDimension, parseRadiusDimension, parseCompactSymmetric, parseNearbyDimension, normalizeTechnicalText, focusedOnlyForPage, shouldRunNeighborhoodRecovery, isDimensionInk };
