const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWorker } = require('tesseract.js');
const { loadPdfJs } = require('./pdfjs.cjs');
const { isSameDimensionComponent, parseTechnicalDimension } = require('./dimension-decision.cjs');
const { DEFAULT_OCR_PIPELINE_CONFIG, expandBox, incompleteReadingSignals, chooseBestOCRCandidate, ocrCacheKey, OCRAttemptCache } = require('./dimension-pipeline.cjs');
const { detectTextContainer, classifyFeatureId, scoreStructuralMerge, flagSuspiciousNumericPrefix, splitSuspiciousOCR } = require('./structural-analysis.cjs');

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
  const angle=compact.match(/^(\d+(?:[,.]\d+)?)(?:°|DEG)$/i);if(angle&&number(angle[1])<=360)return{nominal:number(angle[1]),tolerancePlus:null,toleranceMinus:null,kind:'ANGLE',type:'ANGLE',symbol:'°'};
  const diameter=compact.match(/^[Ø⌀](\d+(?:[,.]\d+)?)(?:±(\d+(?:[,.]\d+)?))?$/i);if(diameter)return{nominal:number(diameter[1]),tolerancePlus:diameter[2]?number(diameter[2]):null,toleranceMinus:diameter[2]?number(diameter[2]):null,kind:'DIAMETER',type:'DIAMETER',symbol:'Ø'};
  const thread=compact.match(/^M(\d+(?:[,.]\d+)?)(?:[Xx](\d+(?:[,.]\d+)?))?$/);if(thread)return{nominal:number(thread[1]),pitch:thread[2]?number(thread[2]):null,tolerancePlus:null,toleranceMinus:null,kind:'THREAD',type:'THREAD',symbol:'M'};
  const chamfer=compact.match(/^(?:C(\d+(?:[,.]\d+)?)|(\d+(?:[,.]\d+)?)X(\d+(?:[,.]\d+)?)(?:°|DEG))$/i);if(chamfer)return{nominal:number(chamfer[1]||chamfer[2]),angle:chamfer[3]?number(chamfer[3]):null,tolerancePlus:null,toleranceMinus:null,kind:'CHAMFER',type:'CHAMFER',symbol:chamfer[1]?'C':'×'};
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
  if (Math.abs(angle) === 180) {
    const result = factory.create(canvas.width, canvas.height);
    result.context.translate(canvas.width, canvas.height); result.context.rotate(Math.PI); result.context.drawImage(canvas, 0, 0);
    return { canvas: result.canvas, width: result.canvas.width, height: result.canvas.height, owned: true, surface: result };
  }
  const result = factory.create(canvas.height, canvas.width);
  if(angle<0){result.context.translate(0,canvas.width);result.context.rotate(-Math.PI/2)}
  else{result.context.translate(canvas.height,0);result.context.rotate(Math.PI/2)}
  result.context.drawImage(canvas, 0, 0);
  return { canvas: result.canvas, width: result.canvas.width, height: result.canvas.height, owned: true, surface: result };
}

function originalBox(box, angle, originalHeight, originalWidth) {
  if (!angle) return box;
  if(Math.abs(angle)===180)return {x0:originalWidth-box.x1,y0:originalHeight-box.y1,x1:originalWidth-box.x0,y1:originalHeight-box.y0};
  if(angle<0)return {x0:originalWidth-box.y1,y0:box.x0,x1:originalWidth-box.y0,y1:box.x1};
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

function makeCandidate(parsed, rawText, box, page, angle, originalHeight, confidence, reason, originalWidth) {
  const original = originalBox(box, angle, originalHeight, originalWidth);
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
    ocrConfidence: Math.max(0, Math.min(.98, confidence)),
    dimensionType: parsed.kind === 'RADIUS' ? 'RADIUS' : 'LINEAR',
    source: 'OCR_LAB',
    status: 'REVISAR',
    reviewReason: reason,
  };
}

function geometryEvidenceForCandidate(context, candidate) {
  const width=context.canvas.width,height=context.canvas.height,x0=Math.max(0,Math.floor(Number(candidate.x)*SCALE)),x1=Math.min(width-1,Math.ceil((Number(candidate.x)+Number(candidate.width||0))*SCALE));
  const y0=Math.max(0,Math.floor(height-(Number(candidate.y)+Number(candidate.height||0))*SCALE)),y1=Math.min(height-1,Math.ceil(height-Number(candidate.y)*SCALE));
  const margin=Math.max(24,Math.round(Math.max(x1-x0,y1-y0)*3)),left=Math.max(0,x0-margin),right=Math.min(width-1,x1+margin),top=Math.max(0,y0-margin),bottom=Math.min(height-1,y1+margin);
  const pixels=context.getImageData(left,top,right-left+1,bottom-top+1).data,regionWidth=right-left+1,regionHeight=bottom-top+1;
  const ink=(x,y)=>{const offset=(y*regionWidth+x)*4,r=pixels[offset],g=pixels[offset+1],b=pixels[offset+2];return Math.min(r,g,b)<170||Math.max(r,g,b)-Math.min(r,g,b)>55};
  const local={x0:x0-left,x1:x1-left,y0:y0-top,y1:y1-top};let horizontal=0,vertical=0,horizontalLine=null,verticalLine=null,inkOutside=0,outside=0;
  for(let y=0;y<regionHeight;y++){let run=0,start=0;for(let x=0;x<=regionWidth;x++){const inside=x<regionWidth&&x>=local.x0&&x<=local.x1&&y>=local.y0&&y<=local.y1;if(x<regionWidth&&ink(x,y)&&!inside){if(!run)start=x;run++}else{if(run>horizontal){horizontal=run;horizontalLine={start,end:x-1,axis:y}}run=0}}}
  for(let y=0;y<regionHeight;y++)for(let x=0;x<regionWidth;x++){const inside=x>=local.x0&&x<=local.x1&&y>=local.y0&&y<=local.y1;if(!inside){outside++;if(ink(x,y))inkOutside++;}}
  for(let x=0;x<regionWidth;x++){let run=0,start=0;for(let y=0;y<=regionHeight;y++){const inside=y<regionHeight&&x>=local.x0&&x<=local.x1&&y>=local.y0&&y<=local.y1;if(y<regionHeight&&ink(x,y)&&!inside){if(!run)start=y;run++}else{if(run>vertical){vertical=run;verticalLine={start,end:y-1,axis:x}}run=0}}}
  const textSpan=Math.max(8,Math.min(Math.max(1,x1-x0),Math.max(1,y1-y0))),horizontalAligned=horizontalLine&&horizontalLine.end>=local.x0&&horizontalLine.start<=local.x1&&Math.min(Math.abs(horizontalLine.axis-local.y0),Math.abs(horizontalLine.axis-local.y1))<=Math.max(24,(local.y1-local.y0)*4),verticalAligned=verticalLine&&verticalLine.end>=local.y0&&verticalLine.start<=local.y1&&Math.min(Math.abs(verticalLine.axis-local.x0),Math.abs(verticalLine.axis-local.x1))<=Math.max(24,(local.x1-local.x0)*4),dimensionLine=(horizontal>=vertical?horizontalAligned:verticalAligned)&&Math.max(horizontal,vertical)>=Math.max(28,textSpan*1.4),density=inkOutside/Math.max(1,outside),nearbyProfile=density>.012;
  const diagonalHits=(line,verticalAxis=false)=>{if(!line)return 0;let hits=0;for(const endpoint of [{value:line.start,direction:1},{value:line.end,direction:-1}]){let upper=0,lower=0;for(let distance=2;distance<=12;distance+=2){const offset=Math.max(1,Math.round(distance*.55));if(verticalAxis){if(ink(line.axis-offset,endpoint.value+endpoint.direction*distance))upper++;if(ink(line.axis+offset,endpoint.value+endpoint.direction*distance))lower++;}else{if(ink(endpoint.value+endpoint.direction*distance,line.axis-offset))upper++;if(ink(endpoint.value+endpoint.direction*distance,line.axis+offset))lower++;}}if(upper>=2&&lower>=2)hits++;}return hits};
  const horizontalPrimary=horizontal>=vertical,primaryLine=horizontalPrimary?horizontalLine:verticalLine,terminationCount=dimensionLine?(horizontalPrimary?diagonalHits(horizontalLine):diagonalHits(verticalLine,true)):0;
  const extensionCount=(()=>{if(!dimensionLine||!primaryLine)return 0;let count=0;const endpoints=[primaryLine.start,primaryLine.end];for(const endpoint of endpoints){let best=0;for(let offset=-7;offset<=7;offset++){let run=0;if(horizontalPrimary){const x=endpoint+offset;for(let y=0;y<regionHeight;y++){if(ink(x,y))run++;else{best=Math.max(best,run);run=0}}}else{const y=endpoint+offset;for(let x=0;x<regionWidth;x++){if(ink(x,y))run++;else{best=Math.max(best,run);run=0}}}}if(best>=Math.max(16,textSpan*.8))count++;}return count})();
  const orientation=horizontalPrimary?'HORIZONTAL':'VERTICAL',absoluteLine=primaryLine?(horizontalPrimary?{x0:left+primaryLine.start,y0:top+primaryLine.axis,x1:left+primaryLine.end,y1:top+primaryLine.axis}:{x0:left+primaryLine.axis,y0:top+primaryLine.start,x1:left+primaryLine.axis,y1:top+primaryLine.end}):null;
  const dimensionLineId=absoluteLine?`p${candidate.page}-${orientation[0]}-${Math.round(absoluteLine.x0/10)}-${Math.round(absoluteLine.y0/10)}-${Math.round(absoluteLine.x1/10)}-${Math.round(absoluteLine.y1/10)}`:null;
  const leader=(()=>{let best=null;const directions=[[-1,-1],[1,-1],[-1,1],[1,1],[-1,-.5],[1,-.5],[-1,.5],[1,.5]],textHeight=Math.max(6,local.y1-local.y0),maxDistance=Math.max(44,Math.min(180,textHeight*9));for(const [dx,dy] of directions){const anchorXs=[local.x0+2,Math.round((local.x0+local.x1)/2),local.x1-2],anchorYs=[local.y0+2,Math.round((local.y0+local.y1)/2),local.y1-2];for(const ax of anchorXs)for(const ay of anchorYs){if(ax<0||ay<0||ax>=regionWidth||ay>=regionHeight)continue;let hits=0,last=0,first=0;for(let step=4;step<=maxDistance;step+=3){const x=Math.round(ax+dx*step),y=Math.round(ay+dy*step);if(x<0||x>=regionWidth||y<0||y>=regionHeight)break;let localHit=false;for(let ox=-1;ox<=1;ox++)for(let oy=-1;oy<=1;oy++)if(ink(x+ox,y+oy))localHit=true;if(localHit){if(!first)first=step;hits++;last=step}}const span=last-first,ratio=hits/Math.max(1,Math.ceil(span/3));if(span>=Math.max(24,textHeight*1.35)&&ratio>.62&&(!best||span>best.span))best={dx,dy,ax,ay,span,confidence:Math.min(.96,.5+ratio*.45),x1:Math.round(ax+dx*last),y1:Math.round(ay+dy*last)};}}return best})();
  const associatedLeaderLineId=leader?`p${candidate.page}-leader-${Math.round((left+leader.ax)/12)}-${Math.round((top+leader.ay)/12)}-${Math.round((left+leader.x1)/12)}-${Math.round((top+leader.y1)/12)}`:null;
  return {dimensionLine,dimensionLineId,orientation,line:absoluteLine,arrowTermination:terminationCount>0,terminationCount,dimensionTermination:{startProbability:terminationCount>0?.72:.15,endProbability:terminationCount>1?.72:terminationCount>0?.42:.15,type:terminationCount?'ARROW_OR_MARK':'UNKNOWN'},extensionLines:extensionCount>0,extensionLineCount:extensionCount,associatedLeaderLineId,leaderLine:leader?{id:associatedLeaderLineId,confidence:leader.confidence,segment:{x0:left+leader.ax,y0:top+leader.ay,x1:left+leader.x1,y1:top+leader.y1},target:'PROFILE_OR_CURVE_UNCONFIRMED'}:null,compatibleAlignment:dimensionLine,nearbyProfile,farFromProfile:!nearbyProfile,longestHorizontal:horizontal,longestVertical:vertical,inkDensity:Number(density.toFixed(4))};
}

function technicalToLab(parsed) {
  if (!parsed) return null;
  return { nominal: parsed.nominal, tolerancePlus: parsed.upperTolerance == null ? null : parsed.upperTolerance, toleranceMinus: parsed.lowerTolerance == null ? null : Math.abs(parsed.lowerTolerance), kind: parsed.kind, symbol: parsed.symbol || '', type: parsed.type };
}

async function progressiveOCRCandidate(document, worker, canvas, candidate, options = {}) {
  const config = { ...DEFAULT_OCR_PIPELINE_CONFIG, ...(options.config || {}) }, cache = options.cache || new OCRAttemptCache();
  const page = Number(candidate.page), documentId = options.documentId || 'document';
  const baseBox = { x0: Number(candidate.x) * SCALE, x1: (Number(candidate.x) + Number(candidate.width || 0)) * SCALE, y0: canvas.height - (Number(candidate.y) + Number(candidate.height || 0)) * SCALE, y1: canvas.height - Number(candidate.y) * SCALE };
  const attempts = [];
  for (const expansion of config.cropExpansionLevels) {
    const box = expandBox(baseBox, expansion, canvas.width, canvas.height), focused = crop(document.canvasFactory, canvas, box, 0);
    try {
      for (const rotation of [0]) {
        const key = ocrCacheKey({ documentId, page, bbox: box, rotation, expansion, psm: 7 });
        const data = await cache.getOrCreate(key, async () => { await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.,+-±RrØ⌀MmXxCc°' }); return (await worker.recognize(focused.canvas.toBuffer('image/png'))).data; });
        attempts.push({ text: String(data.text || '').trim(), confidence: Number(data.confidence || 0) / 100, bbox: data.words?.[0]?.bbox || { x0: 0, y0: 0, x1: focused.canvas.width, y1: focused.canvas.height }, cropBox: { x0: 0, y0: 0, x1: focused.canvas.width, y1: focused.canvas.height }, expansion, rotation });
      }
    } finally { document.canvasFactory.destroy(focused); }
    const best = chooseBestOCRCandidate(attempts, parseTechnicalDimension);
    if (best?.finalScore >= config.acceptScore && !best.incompleteSignals.length) return { best, attempts, cache: cache.diagnostics() };
  }
  let best = chooseBestOCRCandidate(attempts, parseTechnicalDimension);
  if (!best || best.finalScore < config.rotationTriggerScore || best.incompleteSignals.length) {
    const box = expandBox(baseBox, config.cropExpansionLevels.at(-1), canvas.width, canvas.height), focused = crop(document.canvasFactory, canvas, box, 0);
    try {
      for (const rotation of config.rotations.filter(value => value !== 0)) {
        const view = rotate(document.canvasFactory, focused.canvas, rotation), key = ocrCacheKey({ documentId, page, bbox: box, rotation, expansion: config.cropExpansionLevels.at(-1), psm: 7 });
        try { const data = await cache.getOrCreate(key, async () => { await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.,+-±RrØ⌀MmXxCc°' }); return (await worker.recognize(view.canvas.toBuffer('image/png'))).data; }); attempts.push({ text: String(data.text || '').trim(), confidence: Number(data.confidence || 0) / 100, expansion: config.cropExpansionLevels.at(-1), rotation, bbox: data.words?.[0]?.bbox || {}, cropBox: { x0: 0, y0: 0, x1: view.width, y1: view.height } }); } finally { if (view.owned) document.canvasFactory.destroy(view.surface); }
      }
    } finally { document.canvasFactory.destroy(focused); }
    best = chooseBestOCRCandidate(attempts, parseTechnicalDimension);
  }
  return { best, attempts, cache: cache.diagnostics() };
}

function nearbyCompound(words, index, context = null, structural = {}) {
  const base = words[index], parsedBase = parseDimension(base.text);
  if (!parsedBase || parsedBase.kind !== 'PLAIN') return null;
  const baseCenter = center(base.bbox), height = Math.max(16, base.bbox.y1 - base.bbox.y0);
  const component=word=>({x:word.bbox.x0,y:word.bbox.y0,width:word.bbox.x1-word.bbox.x0,height:word.bbox.y1-word.bbox.y0,rotation:0});
  const candidates = words
    .filter((word, candidateIndex) => candidateIndex !== index)
    .map(word => ({ word, parsed: normalizeTechnicalText(word.text), c: center(word.bbox) }))
    .filter(({ word, c }) => {
      const containerA=context?detectTextContainer(context,base.bbox):null,containerB=context?detectTextContainer(context,word.bbox):null;
      const featureA=classifyFeatureId(base.text,{container:containerA}),featureB=classifyFeatureId(word.text,{container:containerB});
      if(featureA.classification==='FEATURE_ID'||featureB.classification==='FEATURE_ID')return false;
      const relation=scoreStructuralMerge({text:base.text,bbox:base.bbox,rotation:0},{text:word.text,bbox:word.bbox,rotation:0},{containerA,containerB,zoneA:structural.zone||'DRAWING_AREA',zoneB:structural.zone||'DRAWING_AREA',sameVisualComponent:isSameDimensionComponent(component(base),component(word))>=55,compatibleSemanticSequence:true});
      return relation.allowed
        && isSameDimensionComponent(component(base),component(word))>=55
      && c.x > baseCenter.x + height * .25
      && c.x <= baseCenter.x + height * 8
      && Math.abs(c.y - baseCenter.y) <= height * 1.6;
    })
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
  const groupingConfidence=Math.min(isSameDimensionComponent(component(base),component(plus.word)),minus?isSameDimensionComponent(component(plus.word),component(minus.word)):100)/100;
  return { parsed, rawText: assembled, rawOCRTokens:[base,plus.word,minus?.word].filter(Boolean).map(word=>({text:word.text,bbox:{...word.bbox},confidence:word.confidence})), bbox: { x0: Math.min(...boxes.map(item => item.x0)), y0: Math.min(...boxes.map(item => item.y0)), x1: Math.max(...boxes.map(item => item.x1)), y1: Math.max(...boxes.map(item => item.y1)) }, confidence: Math.min(base.confidence, plus.word.confidence, minus?.word.confidence ?? 100) / 100, groupingConfidence };
}

function nearbyRadius(words, index, context = null) {
  const base = words[index];
  if (!/^R$/i.test(String(base?.text || '').trim())) return null;
  const origin = center(base.bbox), height = Math.max(12, base.bbox.y1 - base.bbox.y0);
  const candidate = words.map((word, candidateIndex) => ({ word, candidateIndex, center: center(word.bbox), parsed: parseDimension(word.text), container:context?detectTextContainer(context,word.bbox):null }))
    .filter(item => item.candidateIndex !== index && item.parsed?.kind === 'PLAIN'
      && classifyFeatureId(item.word.text,{container:item.container}).classification!=='FEATURE_ID'
      && !(item.container?.type&&item.container.type!=='NONE')
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
          // A vizinhança ampliada serve para recuperar tolerâncias e raios
          // explícitos. Um número simples nesta passagem não prova que exista
          // uma linha de cota e gerava falsos positivos em carimbos e tabelas.
          if (parsed.kind === 'PLAIN') continue;
          const box = { x0: region.x0 + line.bbox.x0 / scale, y0: region.y0 + line.bbox.y0 / scale, x1: region.x0 + line.bbox.x1 / scale, y1: region.y0 + line.bbox.y1 / scale };
          const reason = parsed.kind === 'RADIUS'
            ? 'Raio identificado pelo símbolo R em uma região ampliada. Confira a leitura.'
            : parsed.kind === 'PLAIN'
              ? 'Cota linear sem tolerância recuperada em uma região ampliada. Confira a associação com as linhas de cota.'
            : parsed.kind === 'SYMMETRIC_COMPACT'
              ? 'Tolerância simétrica reconstruída em uma região ampliada. Confira a leitura.'
              : 'Cota técnica adicional lida perto de outra cota. Confira a posição no desenho.';
          const candidate = makeCandidate(parsed, text, box, pageNumber, 0, surface.canvas.height, Number(line.confidence || data.confidence || 0) / 100, reason);
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
  for (const angle of [0, 90, -90]) {
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
            all.push(makeCandidate(parsed, text, box, pageNumber, angle, surface.canvas.height, Number(line.confidence || data.confidence || 0) / 100, reason, surface.canvas.width));
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
  const all = [], featureIds=[], attemptCache = new OCRAttemptCache(), documentId = require('crypto').createHash('sha1').update(buffer).digest('hex').slice(0,16);
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
      const geometrySurface=document.canvasFactory.create(viewport.width,viewport.height);
      geometrySurface.context.drawImage(surface.canvas,0,0);
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
          const focusedCandidates = [];
          for (const psm of focusedOnlyPage ? [6] : [6, 11]) {
            await worker.setParameters({ tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '0123456789.,+-±' });
            const { data } = await worker.recognize(focused.canvas.toBuffer('image/png'), {}, { blocks: true, text: true });
            readings.push(String(data.text || ''));
            const parsed = parseDimension(String(data.text || '').replace(/\s+/g, ''));
            if (parsed && parsed.kind !== 'PLAIN') {
              focusedCandidates.push({ parsed, text: data.text, confidence: Math.max(.55, Number(data.confidence || 0) / 100) });
            }
          }
          const signatures=new Set(focusedCandidates.map(item=>`${item.parsed.nominal}|${item.parsed.tolerancePlus}|${item.parsed.toleranceMinus}`));
          if(signatures.size===1&&focusedCandidates.length){const best=focusedCandidates.sort((a,b)=>b.confidence-a.confidence)[0];focusedDimension=best.parsed;framedNominals.push({nominal:best.parsed.nominal,frame});all.push({...makeCandidate(best.parsed,best.text,frame,pageNumber,0,surface.canvas.height,best.confidence,'Cota crítica selecionada dentro da marcação do desenho. Confira a leitura.'),ocrPass:'RED_FRAME'});}
          else if(signatures.size>1)focusedDimension={conflicted:true};
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
                all.push({...makeCandidate(focusedResult.parsed, readings.join(' '), frame, pageNumber, 0, surface.canvas.height, focusedResult.inferred ? .58 : .72, focusedResult.inferred ? 'Tolerância reconstruída dentro da marcação crítica. Confira a leitura.' : 'Cota crítica lida dentro da marcação do desenho. Confira a leitura.'),ocrPass:'RED_FRAME'});
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
      // Kept as an opt-in compatibility recovery. Copying a tolerance from a
      // different framed label is unsafe by default: a partial OCR such as
      // 156 -> 5 can manufacture a new, plausible-looking dimension.
      for (const framed of options.inferRepeatedFramedTolerance === true ? framedNominals : []) {
        const x = framed.frame.x0 / SCALE, y = (surface.canvas.height - framed.frame.y1) / SCALE;
        const alreadyRead = all.some(item => item.page === pageNumber && item.tolerancePlus !== null && Math.hypot(item.x - x, item.y - y) < 16);
        if (alreadyRead) continue;
        const matching = all.find(item => item.page === pageNumber && item.tolerancePlus !== null && Math.abs(item.nominal - framed.nominal) < .001);
        if (matching) {
          all.push({...makeCandidate({ nominal: framed.nominal, tolerancePlus: matching.tolerancePlus, toleranceMinus: matching.toleranceMinus }, printable(framed.nominal), framed.frame, pageNumber, 0, surface.canvas.height, .4, 'Tolerância repetida de uma cota crítica simétrica. Confira a leitura.'),ocrPass:'RED_FRAME'});
        }
      }

      if (focusedOnlyPage) {
        for(const candidate of all.filter(item=>Number(item.page)===pageNumber))candidate.geometryEvidence=geometryEvidenceForCandidate(geometrySurface.context,candidate);
        document.canvasFactory.destroy(geometrySurface);
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

      for (const angle of [0, 90, -90]) {
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
        const visualContext=view.surface?.context||surface.context;
        for (let index = 0; index < words.length; index += 1) {
           const word = words[index];
            const numericId=/^\d{1,3}$/.test(word.text),container=numericId&&angle===0?detectTextContainer(visualContext,word.bbox):{type:'NONE',containerId:null,confidence:0},feature=classifyFeatureId(word.text,{container});
            if(feature.classification==='FEATURE_ID'){
              const original=originalBox(word.bbox,angle,surface.canvas.height,surface.canvas.width);
              featureIds.push({id:`feature-${pageNumber}-${featureIds.length+1}`,text:word.text,featureId:feature.featureId,classification:'FEATURE_ID',containerType:container.type,containerId:container.containerId,containerConfidence:container.confidence,page:pageNumber,x:original.x0/SCALE,y:(surface.canvas.height-original.y1)/SCALE,width:(original.x1-original.x0)/SCALE,height:(original.y1-original.y0)/SCALE,rotation:angle,bbox:original,rawOCRTokens:[{text:word.text,bbox:word.bbox,confidence:word.confidence}],visualComponentId:`visual-${container.containerId||pageNumber+'-'+Math.round(original.x0/4)+'-'+Math.round(original.y0/4)}`,reviewReason:container.type==='NONE'?'Identificador numérico próximo de uma dimensão e visualmente separado.':'Identificador de característica detectado dentro de um container gráfico; não incorporado à cota.'});
              continue;
            }
           const radius = parseRadiusDimension(word.text, 25);
            const splitRadius = !radius ? nearbyRadius(words, index,visualContext) : null;
            if (splitRadius) {
              all.push(makeCandidate(splitRadius.parsed, `R${printable(splitRadius.parsed.nominal)}`, splitRadius.bbox, pageNumber, angle, surface.canvas.height, splitRadius.confidence, 'Raio identificado pelo símbolo R e pelo número adjacente. Confira a leitura.',surface.canvas.width));
              continue;
            }
            const parsed = radius || parseDimension(word.text);
            const compound = !radius && parsed?.kind === 'PLAIN' ? nearbyCompound(words, index,visualContext) : null;
            if (compound) {
              all.push({...makeCandidate(compound.parsed, compound.rawText, compound.bbox, pageNumber, angle, surface.canvas.height, compound.confidence, 'Tolerância reconstruída a partir de fragmentos OCR estruturalmente compatíveis. Confira a leitura.',surface.canvas.width),groupingConfidence:compound.groupingConfidence,rawOCRText:words.filter(item=>compound.rawOCRTokens.some(token=>token.text===item.text&&token.bbox.x0===item.bbox.x0)).map(item=>item.text).join(' '),rawOCRTokens:compound.rawOCRTokens,mergedText:compound.rawText,finalText:compound.rawText});
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
            const candidate=makeCandidate(parsed, word.text, word.bbox, pageNumber, angle, surface.canvas.height, word.confidence / 100, reason,surface.canvas.width);
            candidate.dimensionType=parsed.type||candidate.dimensionType;candidate.rawOCRText=word.text;candidate.rawOCRTokens=[{text:word.text,bbox:{...word.bbox},confidence:word.confidence,containerId:container.containerId||null}];candidate.normalizedText=normalizeTechnicalText(word.text);candidate.containerId=container.containerId;candidate.containerType=container.type;candidate.visualComponentId=`visual-${container.containerId||pageNumber+'-'+Math.round(candidate.x*4)+'-'+Math.round(candidate.y*4)}`;
            const prefixMatch=String(word.text).match(/^(\d)(?=\d+[,.]\d+(?:±|\+|\/))/),prefixBox=prefixMatch?{x0:word.bbox.x0,y0:word.bbox.y0,x1:word.bbox.x0+(word.bbox.x1-word.bbox.x0)*.16,y1:word.bbox.y1}:null,prefixContainer=prefixBox?detectTextContainer(visualContext,prefixBox):null,prefix=flagSuspiciousNumericPrefix(word.text,[...candidate.rawOCRTokens,...(prefixContainer&&prefixContainer.type!=='NONE'?[{text:prefixMatch[1],bbox:prefixBox,possibleFeatureId:true,containerId:prefixContainer.containerId}]:[])]);if(prefix){candidate.suspiciousPrefix=prefix;candidate.status='REVISAR';candidate.reviewReason='Prefixo numérico suspeito; alternativas preservadas para conferência, sem alteração automática.';candidate.rawOCRTokens.push({text:prefixMatch?.[1]||'',bbox:prefixBox,containerId:prefixContainer?.containerId||null,possibleFeatureId:Boolean(prefixContainer?.type&&prefixContainer.type!=='NONE')});if(prefixContainer?.type&&prefixContainer.type!=='NONE')featureIds.push({id:`feature-${pageNumber}-${featureIds.length+1}`,text:prefixMatch[1],featureId:prefixMatch[1],classification:'FEATURE_ID',containerType:prefixContainer.type,containerId:prefixContainer.containerId,containerConfidence:prefixContainer.confidence,page:pageNumber,bbox:prefixBox,reviewReason:'Prefixo OCR separado estruturalmente por um container gráfico; candidato preservado como identificador.'});}
            all.push(candidate);
          }
        }
        if (view.owned) document.canvasFactory.destroy(view.surface);
      }
      const pageCandidates=all.filter(item=>Number(item.page)===pageNumber);
      for(const candidate of pageCandidates){candidate.geometryEvidence=geometryEvidenceForCandidate(geometrySurface.context,candidate);candidate.dimensionLineId=candidate.geometryEvidence.dimensionLineId;candidate.associatedLeaderLineId=candidate.geometryEvidence.associatedLeaderLineId;}
      const suspects=pageCandidates.filter(candidate=>{const parsed=parseTechnicalDimension(candidate.recognizedText||candidate.rawText),signals=incompleteReadingSignals(candidate.recognizedText||candidate.rawText);return candidate.rotation===0&&candidate.geometryEvidence?.dimensionLine&&(signals.length>0||!parsed)}).slice(0,DEFAULT_OCR_PIPELINE_CONFIG.maxCandidatesPerPage);
      for(const candidate of suspects){const recovered=await progressiveOCRCandidate(document,worker,surface.canvas,candidate,{cache:attemptCache,documentId}),original=chooseBestOCRCandidate([{text:candidate.recognizedText||candidate.rawText,confidence:candidate.ocrConfidence||candidate.confidence||0}],parseTechnicalDimension),parsed=technicalToLab(recovered.best?.parsed);if(!parsed||!recovered.best||recovered.best.finalScore<Number(original?.finalScore||0)+.06)continue;const replacement=makeCandidate(parsed,recovered.best.text,{x0:candidate.x*SCALE,y0:surface.canvas.height-(candidate.y+candidate.height)*SCALE,x1:(candidate.x+candidate.width)*SCALE,y1:surface.canvas.height-candidate.y*SCALE},pageNumber,0,surface.canvas.height,recovered.best.ocrScore,'Leitura recuperada por expansão progressiva do recorte. Confira a leitura.',surface.canvas.width);Object.assign(candidate,replacement,{geometryEvidence:candidate.geometryEvidence,dimensionLineId:candidate.dimensionLineId,rotationUsed:recovered.best.rotation,cropExpansion:recovered.best.expansion,ocrAttemptScore:recovered.best.finalScore,ocrAttempts:recovered.attempts.map(item=>({text:item.text,confidence:item.confidence,rotation:item.rotation,expansion:item.expansion,finalScore:chooseBestOCRCandidate([item],parseTechnicalDimension)?.finalScore||0}))});}
      document.canvasFactory.destroy(geometrySurface);
      document.canvasFactory.destroy(surface);
    }
  } finally {
    await worker?.terminate();
    await document.destroy();
  }
  const reliable=all.filter(candidate=>candidate.ocrPass!=='RED_FRAME'||Number(candidate.confidence)>=.8||all.some(other=>other!==candidate&&other.ocrPass!=='RED_FRAME'&&Number(other.page)===Number(candidate.page)&&Math.abs(Number(other.nominal)-Number(candidate.nominal))<.01&&Math.hypot(Number(other.x)-Number(candidate.x),Number(other.y)-Number(candidate.y))<24));
  const result = distinct(reliable).map((candidate, index) => ({ ...candidate, id: `lab-${candidate.page}-${index + 1}`, rawOCRText:candidate.rawOCRText||candidate.recognizedText||candidate.rawText, rawOCRTokens:candidate.rawOCRTokens||[], normalizedText:candidate.normalizedText||candidate.rawText, mergedText:candidate.mergedText||null, finalText:candidate.finalText||candidate.rawText, ocrCacheDiagnostics: attemptCache.diagnostics() }));
  result.featureIds=featureIds;result.associationGraph={nodes:[],edges:[]};
  return result;
}

module.exports = { extractLabDimensions, parseDimension, parseRadiusDimension, parseCompactSymmetric, parseNearbyDimension, normalizeTechnicalText, focusedOnlyForPage, shouldRunNeighborhoodRecovery, isDimensionInk, originalBox, geometryEvidenceForCandidate, progressiveOCRCandidate, technicalToLab };
