const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

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
    && plus <= Math.max(5, nominal * 0.35) && minus <= Math.max(5, nominal * 0.35);
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
  const compact = normalizeTechnicalText(value);
  const asymmetric = compact.match(/^(\d+(?:[,.]\d+)?)(?:mm)?\+(\d+(?:[,.]\d+)?)(?:\/?-(\d+(?:[,.]\d+)?))$/i);
  if (asymmetric) {
    const nominal = number(asymmetric[1]), plus = number(asymmetric[2]), minus = number(asymmetric[3]);
    if (validTolerance(nominal, plus, minus)) return { nominal, tolerancePlus: plus, toleranceMinus: minus, kind: 'ASYMMETRIC' };
  }
  const symmetric = compact.match(/^(\d+(?:[,.]\d+)?)(?:mm)?(?:±|\+)(\d+(?:[,.]\d+)?)(?:mm)?$/i);
  if (symmetric) {
    const nominal = number(symmetric[1]), tolerance = number(symmetric[2]);
    if (validTolerance(nominal, tolerance, tolerance)) return { nominal, tolerancePlus: tolerance, toleranceMinus: tolerance, kind: 'SYMMETRIC' };
  }
  const plain = compact.match(/^\d+(?:[,.]\d+)?$/);
  if (plain) return { nominal: number(plain[0]), tolerancePlus: null, toleranceMinus: null, kind: 'PLAIN' };
  return null;
}

function buildBlueTextMask(context) {
  const image = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  const { width, height, data } = image;
  const blue = new Uint8Array(width * height);

  for (let index = 0; index < blue.length; index += 1) {
    const offset = index * 4;
    // The technical dimensions in our drawings are blue. Keeping this layer
    // removes the black profile geometry and the tolerance table.
    if (data[offset + 2] > data[offset] + 35 && data[offset + 2] > data[offset + 1] + 22) blue[index] = 1;
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
  const canonical = parsed.tolerancePlus === null
    ? printable(parsed.nominal)
    : `${printable(parsed.nominal)}${symmetric ? ' ± ' : ' +'}${printable(parsed.tolerancePlus)}${symmetric ? '' : ` / -${printable(parsed.toleranceMinus)}`}`;
  return {
    rawText: canonical,
    recognizedText: canonical,
    nominal: parsed.nominal,
    tolerancePlus: parsed.tolerancePlus,
    toleranceMinus: parsed.toleranceMinus,
    page,
    x: original.x0 / SCALE,
    y: (originalHeight - original.y1) / SCALE,
    width: (original.x1 - original.x0) / SCALE,
    height: (original.y1 - original.y0) / SCALE,
    rotation: angle,
    confidence: Math.max(0, Math.min(.98, confidence)),
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

function distinct(candidates) {
  const accepted = [];
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    const duplicate = accepted.some(other => other.page === candidate.page
      && Math.hypot(other.x - candidate.x, other.y - candidate.y) < 7
      && other.nominal === candidate.nominal);
    if (!duplicate) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
}

async function extractLabDimensions(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const cachePath = path.join(__dirname, '..', '.draw2data-cache', 'lab');
  fs.mkdirSync(cachePath, { recursive: true });
  let worker;
  const all = [];
  try {
    if (document.numPages > MAX_PAGES) throw Error('Separe o desenho em arquivos de até 10 páginas para a leitura experimental.');
    worker = await createWorker('eng', 1, { cachePath });
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: SCALE });
      if (viewport.width * viewport.height > 32000000) throw Error('Página grande demais para a leitura experimental.');
      const surface = document.canvasFactory.create(viewport.width, viewport.height);
      await page.render({ canvasContext: surface.context, viewport }).promise;
      buildBlueTextMask(surface.context);
      for (const angle of [0, 90]) {
        const view = rotate(document.canvasFactory, surface.canvas, angle);
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        const { data } = await worker.recognize(view.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
        const lines = (data.blocks || []).flatMap(block => (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []));
        // Tesseract v6 does not always materialize data.words when block output
        // is requested. Lines retain their bounding boxes and are a stable
        // geometric unit for CAD text, so they are a safe fallback.
        const sourceTokens = data.words?.length ? data.words : lines;
        const words = sourceTokens
          .filter(word => /\d/.test(word.text || '') && word.bbox)
          .map(word => ({ text: String(word.text).trim(), bbox: word.bbox, confidence: Number(word.confidence || 0) }));
        for (let index = 0; index < words.length; index += 1) {
          const word = words[index];
          const parsed = parseDimension(word.text);
          const compound = parsed?.kind === 'PLAIN' ? nearbyCompound(words, index) : null;
          if (compound) {
            all.push(makeCandidate(compound.parsed, compound.rawText, compound.bbox, pageNumber, angle, surface.canvas.height, compound.confidence, 'Tolerância agrupada pela posição no desenho. Confira a leitura.'));
            continue;
          }
          if (!parsed) continue;
          if (parsed.kind === 'PLAIN') {
            // A short, low-confidence number is commonly a fragment of a
            // tolerance or arrow, never a safe production control point.
            if (word.confidence < 60 || parsed.nominal < .5 || parsed.nominal > 500) continue;
            const isInteger = Number.isInteger(parsed.nominal);
            if ((isInteger && parsed.nominal <= 99) && isBalloonToken(view.surface?.context || surface.context, word.bbox)) continue;
            if (isInteger && parsed.nominal <= 12) continue;
          }
          const reason = parsed.kind === 'PLAIN'
            ? 'Cota sem tolerância explícita. Confira no desenho.'
            : 'Leitura técnica pela posição de nominal e tolerância. Confira no desenho.';
          all.push(makeCandidate(parsed, word.text, word.bbox, pageNumber, angle, surface.canvas.height, word.confidence / 100, reason));
        }
        if (view.owned) document.canvasFactory.destroy(view.surface);
      }
      document.canvasFactory.destroy(surface);
    }
  } finally {
    await worker?.terminate();
    await document.destroy();
  }
  return distinct(all).map((candidate, index) => ({ ...candidate, id: `lab-${candidate.page}-${index + 1}` }));
}

module.exports = { extractLabDimensions, parseDimension, normalizeTechnicalText };
