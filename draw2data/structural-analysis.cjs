const FEATURE_ID = /^(?:\d{1,3})$/;
const TECHNICAL_PROPERTY_PATTERNS = [
  { property: 'UNSPECIFIED_TOLERANCE', pattern: /toler[aâ]ncia\s+n[aã]o\s+especificada\s*:?\s*(±\s*[\d,.]+\s*mm?)/i },
  { property: 'UNSPECIFIED_RADIUS', pattern: /raios?\s+n[aã]o\s+indicados?\s*:?\s*(?:R\s*)?([\d,.]+\s*mm?)/i },
  { property: 'UNSPECIFIED_THICKNESS', pattern: /espessura\s+n[aã]o\s+indicada\s*:?\s*([\d,.]+\s*(?:±\s*[\d,.]+)?\s*mm?)/i },
  { property: 'FLATNESS', pattern: /planicidade\s*:?\s*([\d,.]+\s*mm?)/i },
  { property: 'ANGULAR_TOLERANCE', pattern: /toler[aâ]ncia\s+angular\s*:?\s*([\d,.]+\s*°?)/i },
  { property: 'DEVELOPED_LENGTH', pattern: /comprimento\s+desenvolvido\s*:?\s*([\d,.]+\s*(?:±\s*[\d,.]+)?\s*mm?)/i, dimension: true },
];
const PARAGRAPH_WORDS = /\b(?:termo|responsabilidade|declaro|declara|lei|dispositivo|legal|fiscal|cont[aá]bil|financeiro|produto|origina|empresa|cliente|observa[cç][aã]o|aten[cç][aã]o|embalagem|inspe[cç][aã]o|intercalar|pe[cç]as?|amarrado)\b/i;
const TECHNICAL_NOTE_WORDS = /\b(?:toler[aâ]ncia|raios?\s+n[aã]o\s+indicados?|espessura\s+n[aã]o\s+indicada|planicidade|comprimento\s+desenvolvido|acabamento|material)\b/i;

function textOf(item) { return String(item?.text ?? item?.rawText ?? item?.recognizedText ?? '').trim(); }
function center(box) { return { x: Number(box.x0 ?? box.x ?? 0) + Number(box.width ?? (Number(box.x1) - Number(box.x0)) ?? 0) / 2, y: Number(box.y0 ?? box.y ?? 0) + Number(box.height ?? (Number(box.y1) - Number(box.y0)) ?? 0) / 2 }; }
function normalizedBBox(box) { const x0=Number(box.x0 ?? box.x ?? 0),y0=Number(box.y0 ?? box.y ?? 0),x1=Number(box.x1 ?? (x0+Number(box.width||0))),y1=Number(box.y1 ?? (y0+Number(box.height||0)));return{x0,y0,x1,y1,width:Math.max(0,x1-x0),height:Math.max(0,y1-y0)}; }

function detectTextContainer(context, inputBox, { paddingFactor = .65 } = {}) {
  if (!context?.canvas || !inputBox) return { type: 'NONE', containerId: null, confidence: 0, bbox: null };
  const { x0, y0, x1, y1, width: textWidth, height: textHeight } = normalizedBBox(inputBox);
  if (textWidth <= 0 || textHeight <= 0) return { type: 'NONE', containerId: null, confidence: 0, bbox: null };
  const canvas=context.canvas, padding=Math.max(5,Math.min(32,Math.round(Math.max(textWidth,textHeight)*paddingFactor)));
  const left=Math.max(0,Math.floor(x0-padding)),right=Math.min(canvas.width-1,Math.ceil(x1+padding)),top=Math.max(0,Math.floor(y0-padding)),bottom=Math.min(canvas.height-1,Math.ceil(y1+padding));
  const data=context.getImageData(left,top,right-left+1,bottom-top+1).data,w=right-left+1,h=bottom-top+1;
  const ink=(x,y)=>{if(x<0||x>=w||y<0||y>=h)return false;const i=(y*w+x)*4,r=data[i],g=data[i+1],b=data[i+2],lo=Math.min(r,g,b),hi=Math.max(r,g,b);return lo<170||hi-lo>55};
  const cx=(x0+x1)/2-left,cy=(y0+y1)/2-top;
  let ellipseRatio=0,rectRatio=0,ellipseRadii=null,rectRadii=null;
  for(let xFactor=.25;xFactor<=1.25;xFactor+=.1)for(let yFactor=.25;yFactor<=1.25;yFactor+=.1){const rx=(textWidth/2)+Math.max(2,Math.round(textWidth*xFactor)),ry=(textHeight/2)+Math.max(2,Math.round(textHeight*yFactor));let ellipseHits=0,rectHits=0;for(let i=0;i<48;i++){const theta=2*Math.PI*i/48;if(ink(Math.round(cx+rx*Math.cos(theta)),Math.round(cy+ry*Math.sin(theta))))ellipseHits++;}for(let i=0;i<12;i++){const u=(i+.5)/12;for(const [px,py] of [[cx-rx+2*rx*u,cy-ry],[cx-rx+2*rx*u,cy+ry],[cx-rx,cy-ry+2*ry*u],[cx+rx,cy-ry+2*ry*u]])if(ink(Math.round(px),Math.round(py)))rectHits++;}if(ellipseHits/48>ellipseRatio){ellipseRatio=ellipseHits/48;ellipseRadii={rx,ry};}if(rectHits/48>rectRatio){rectRatio=rectHits/48;rectRadii={rx,ry};}}
  let type='NONE',confidence=0;
  if(ellipseRatio>=.42){type=Math.abs(ellipseRadii.rx-ellipseRadii.ry)/Math.max(ellipseRadii.rx,ellipseRadii.ry)<.18?'CIRCLE':'ELLIPSE';confidence=ellipseRatio;}
  if(rectRatio>=.55&&rectRatio>ellipseRatio+.05){type='BOX';confidence=rectRatio;}
  if(type!=='NONE'&&Math.min((type==='BOX'?rectRadii:ellipseRadii).rx,(type==='BOX'?rectRadii:ellipseRadii).ry)>Math.max(textWidth,textHeight)*3.5){type='OTHER';confidence*=.7;}
  const radii=type==='BOX'?rectRadii:ellipseRadii,bbox=type==='NONE'?{x0:left,y0:top,x1:right,y1:bottom}:{x0:Math.max(0,Math.round(left+cx-radii.rx)),y0:Math.max(0,Math.round(top+cy-radii.ry)),x1:Math.min(canvas.width-1,Math.round(left+cx+radii.rx)),y1:Math.min(canvas.height-1,Math.round(top+cy+radii.ry))};
  return { type, containerId:type==='NONE'?null:`container-${Math.round(left/4)}-${Math.round(top/4)}-${Math.round(right/4)}-${Math.round(bottom/4)}`, confidence:Number(confidence.toFixed(3)), bbox, evidence:{ellipseRatio:Number(ellipseRatio.toFixed(3)),rectRatio:Number(rectRatio.toFixed(3))} };
}

function classifyFeatureId(value, { container = null, separatedFromDimension = false, calloutContext = false } = {}) {
  const text=textOf({text:value}).replace(/[\[\](){}<>]/g,'');
  if(!FEATURE_ID.test(text))return{classification:'OTHER',featureId:null};
  const hasContainer=container&&container.type&&container.type!=='NONE';
  const plausible=hasContainer||separatedFromDimension||calloutContext;
  return{classification:plausible?'FEATURE_ID':'OTHER',featureId:plausible?text:null,confidence:hasContainer?Math.max(.75,Number(container.confidence)||0):plausible?.62:0};
}

function classifyTextSemantics(value) {
  const text=String(value||'').replace(/\s+/g,' ').trim();
  for(const entry of TECHNICAL_PROPERTY_PATTERNS){const match=text.match(entry.pattern);if(match)return{classification:entry.dimension?'TECHNICAL_DIMENSION':'TECHNICAL_PROPERTY',property:entry.property,value:match[1],rawText:text};}
  if(PARAGRAPH_WORDS.test(text)&&(/[.!;:]\s|\b\w{3,}\s+\w{3,}\s+\w{3,}/i.test(text)||text.length>48))return{classification:/\b(?:aten[cç][aã]o|observa[cç][aã]o|embalagem|inspe[cç][aã]o)\b/i.test(text)?'NOTE':'PARAGRAPH',rawText:text};
  if(TECHNICAL_NOTE_WORDS.test(text))return{classification:'TECHNICAL_PROPERTY',property:'TECHNICAL_NOTE',rawText:text};
  return{classification:'OTHER',rawText:text};
}

function detectParagraphRegions(pages=[]) {
  const regions=[];
  for(const page of pages){const items=(page.items||[]).filter(item=>Number.isFinite(Number(item.x))&&Number.isFinite(Number(item.y))),long=items.filter(item=>textOf(item).length>=42||PARAGRAPH_WORDS.test(textOf(item))&&textOf(item).split(/\s+/).length>=5);
    for(const item of long){const words=textOf(item).split(/\s+/).length,lineHeight=Math.max(6,Math.min(15,Number(item.fontSize)||Number(item.height||0)*.18||8));if(words<5&&textOf(item).length<60)continue;regions.push({page:Number(page.page),type:/\b(?:nota|aten[cç][aã]o|observa[cç][aã]o|embalagem|inspe[cç][aã]o)\b/i.test(textOf(item))?'NOTE':'PARAGRAPH',x0:Math.max(0,Number(item.x)-4),y0:Math.max(0,Number(item.y)-lineHeight*.8),x1:Math.min(Number(page.width||842),Number(item.x)+Number(item.width||0)+5),y1:Math.min(Number(page.height||595),Number(item.y)+lineHeight*.8),evidence:textOf(item).slice(0,180),visualEvidence:{wordCount:words,lineEstimate:1}});}}
  return regions;
}

function isInside(a,b) { const x=center(a),box=normalizedBBox(b);return x.x>=box.x0&&x.x<=box.x1&&x.y>=box.y0&&x.y<=box.y1; }
function mergeBarrierScore(a,b,{containerA,containerB,zoneA='DRAWING_AREA',zoneB='DRAWING_AREA',paragraphA=false,paragraphB=false,graphicBarrier=false}={}) {
  let barrier=0;
  const fa=a.classification==='FEATURE_ID'||a.featureId||a.semanticClass==='FEATURE_ID',fb=b.classification==='FEATURE_ID'||b.featureId||b.semanticClass==='FEATURE_ID';
  if(fa||fb)barrier+=100;
  const hasA=Boolean(containerA?.type&&containerA.type!=='NONE'),hasB=Boolean(containerB?.type&&containerB.type!=='NONE');
  if(hasA!==hasB)barrier+=45;
  if(hasA&&hasB&&containerA?.containerId&&containerB?.containerId&&containerA.containerId!==containerB.containerId)barrier+=35;
  if((a.dimensionLineId||null)!==(b.dimensionLineId||null)&&(a.dimensionLineId||b.dimensionLineId))barrier+=40;
  if((a.associatedLeaderLineId||null)!==(b.associatedLeaderLineId||null)&&(a.associatedLeaderLineId||b.associatedLeaderLineId))barrier+=40;
  if(zoneA!==zoneB)barrier+=45;
  if(paragraphA||paragraphB)barrier+=75;
  if(graphicBarrier)barrier+=65;
  const scaleA=Math.max(1,Number(a.height||0)),scaleB=Math.max(1,Number(b.height||0));if(Math.max(scaleA,scaleB)/Math.min(scaleA,scaleB)>2.5)barrier+=25;
  return Math.min(100,barrier);
}

function scoreStructuralMerge(a,b,evidence={}) {
  const barrier=mergeBarrierScore(a,b,evidence),aa=normalizedBBox(a.bbox||a),bb=normalizedBBox(b.bbox||b),ac=center(aa),bc=center(bb),h=Math.max(1,aa.height,bb.height);let positive=0;
  if(Math.abs(ac.y-bc.y)<=h*.65)positive+=20;
  if(Math.abs(Number(a.rotation||0)-Number(b.rotation||0))<=5)positive+=10;
  if(Math.max(aa.height,bb.height)/Math.max(1,Math.min(aa.height,bb.height))<=1.4)positive+=10;
  if(a.dimensionLineId&&a.dimensionLineId===b.dimensionLineId)positive+=25;
  if(a.associatedLeaderLineId&&a.associatedLeaderLineId===b.associatedLeaderLineId)positive+=20;
  if(evidence.sameVisualComponent)positive+=15;
  if(evidence.compatibleSemanticSequence)positive+=20;
  const distance=Math.hypot(ac.x-bc.x,ac.y-bc.y);positive+=Math.max(0,15-distance/(h*2));
  return {score:Math.max(0,Math.min(100,positive-barrier)),positive,mergeBarrierScore:barrier,allowed:barrier<40&&positive-barrier>=55};
}

function flagSuspiciousNumericPrefix(text, tokens=[]) {
  const match=String(text||'').match(/^([0-9])((?:\d+[,.]?\d*))(±|\+\/\-|\+)(\d+(?:[,.]\d+)?)(.*)$/);
  if(!match)return null;
  const prefixToken=tokens.find(token=>String(token.text||'').replace(/\D/g,'')===match[1]||token.possibleFeatureId===true);
  if(!prefixToken)return null;
  return {flag:'SUSPICIOUS_PREFIX',originalText:text,alternatives:[`${match[2]}${match[3]}${match[4]}${match[5]}`,match[1]],prefixToken,requiresReview:true};
}

function buildAssociationGraph(candidates=[],extraNodes=[]) {
  const nodes=[...extraNodes],edges=[];
  for(const candidate of candidates){const id=candidate.id||`text-${nodes.length+1}`;nodes.push({id,type:'TEXT',text:textOf(candidate),bbox:candidate.bbox||normalizedBBox(candidate),semanticClass:candidate.semanticClass||null,zoneId:candidate.zoneId||null,visualComponentId:candidate.visualComponentId||null});for(const [field,type] of [['dimensionLineId','DIMENSION_LINE'],['associatedLeaderLineId','LEADER_LINE'],['containerId','CONTAINER'],['geometryTargetId','GEOMETRY'],['curveId','CURVE'],['arcId','ARC']])if(candidate[field]){if(!nodes.some(node=>node.id===candidate[field]))nodes.push({id:candidate[field],type});edges.push({from:id,to:candidate[field],relation:field==='containerId'?'TEXT_TO_CONTAINER':field==='dimensionLineId'?'TEXT_TO_DIMENSION_LINE':field==='associatedLeaderLineId'?'TEXT_TO_LEADER_LINE':`TEXT_TO_${type}`});}}
  return {nodes,edges};
}

function splitSuspiciousOCR(text, tokens=[]) {
  const raw=String(text||'');return {rawOCRText:raw,rawOCRTokens:tokens.map(token=>({...token})),normalizedText:raw.replace(/[−–—]/g,'-').replace(/\s+/g,' ').trim(),mergedText:null,finalText:null};
}

function extractTechnicalAnnotations(pages=[]) {
  const annotations=[];
  for(const page of pages){const text=(page.items||[]).map(textOf).join(' ').replace(/\s+/g,' ').trim();for(const entry of TECHNICAL_PROPERTY_PATTERNS){const flags=entry.pattern.flags.includes('g')?entry.pattern.flags:`${entry.pattern.flags}g`;const pattern=new RegExp(entry.pattern.source,flags);for(const match of text.matchAll(pattern)){annotations.push({type:entry.dimension?'TECHNICAL_DIMENSION':'TECHNICAL_PROPERTY',property:entry.property,value:match[1],rawText:match[0],page:Number(page.page),zone:'TECHNICAL_NOTE',geometricDimension:false,exportAsGeometric:false});}}}
  return annotations;
}

module.exports={TECHNICAL_PROPERTY_PATTERNS,detectTextContainer,classifyFeatureId,classifyTextSemantics,detectParagraphRegions,mergeBarrierScore,scoreStructuralMerge,flagSuspiciousNumericPrefix,buildAssociationGraph,splitSuspiciousOCR,extractTechnicalAnnotations};
