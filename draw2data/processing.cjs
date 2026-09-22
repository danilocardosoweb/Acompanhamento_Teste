const {extractPdf}=require('./reader.cjs');
const {analyze}=require('./detection.cjs');
const {extractVisualDimensions}=require('./ocr.cjs');
const {extractLabDimensions}=require('./lab-engine.cjs');
const {classifyCandidates,deduplicateCandidates,parseTechnicalDimension}=require('./dimension-decision.cjs');
const {assembleStackedTolerance}=require('./dimension-pipeline.cjs');
const {extractTechnicalAnnotations,buildAssociationGraph}=require('./structural-analysis.cjs');
const ENGINE_VERSION='4.4-structural-dimension-association';
const DETAILED_ENGINE_VERSION='4.4-structural-dimension-association';
const FLAT_BAR_ENGINE_VERSION='4.4-structural-dimension-association';
const SPARSE_PAGE_DIMENSION_THRESHOLD=3;
let busy=false;

function classifyDimension(item){
 const text=String(item.rawText||item.recognizedText||'');
 let type,priority,label;
 if(item.reference===true||/\bREF\b/i.test(text)){type='REFERENCE';priority=4;label='Referência';}
 else if(item.symbol==='R'||item.dimensionType==='RADIUS'||/^\s*R\s*\d/i.test(text)){type='RADIUS';priority=3;label='Raio';}
 else if(item.symbol==='Ø'||item.symbol==='⌀'||/[Ø⌀]/.test(text)){type='DIAMETER';priority=2;label='Diâmetro';}
 else if(item.dimensionType==='ANGLE'||/[°]|\bDEG\b/i.test(text)){type='ANGLE';priority=2;label='Ângulo';}
 else if(item.dimensionType==='THREAD'||/^\s*M\d/i.test(text)){type='THREAD';priority=2;label='Rosca';}
 else if(item.dimensionType==='CHAMFER'||/^\s*C\d|\dX\d°/i.test(text)){type='CHAMFER';priority=2;label='Chanfro';}
 else if(item.tolerancePlus!==null&&item.tolerancePlus!==undefined||item.toleranceMinus!==null&&item.toleranceMinus!==undefined){type='TOLERANCED_LINEAR';priority=0;label='Linear · tolerância';}
 else {type='LINEAR';priority=1;label='Linear';}
 return {type,dimensionType:type,priority,label};
}
function prioritizeDimensions(dimensions){
 return dimensions.map((item,index)=>({...item,...classifyDimension(item),_order:index}))
  .sort((a,b)=>a.priority-b.priority||a.page-b.page||b.y-a.y||a.x-b.x)
  .map(({_order,...item})=>item);
}

function reliableFallback(item){
 const nominal=Number(item.nominal),plus=item.tolerancePlus==null?null:Number(item.tolerancePlus),minus=item.toleranceMinus==null?null:Number(item.toleranceMinus);
 if(!Number.isFinite(nominal)||nominal<0)return false;
 if(plus!==null||minus!==null)return Number.isFinite(plus)&&Number.isFinite(minus)&&plus>=0&&minus>=0&&plus<nominal&&minus<nominal;
 return Number(item.confidence||0)>=.45;
}
function mergeDimensions(primary,fallback){
 const merged=[...primary];
 for(const candidate of fallback.filter(reliableFallback)){
  const duplicate=merged.some(current=>current.page===candidate.page&&String(current.symbol||'')===String(candidate.symbol||'')&&Math.hypot((current.x||0)-(candidate.x||0),(current.y||0)-(candidate.y||0))<9);
  if(!duplicate)merged.push(candidate);
 }
 return merged;
}
function normalizeDimension(item){
 const nominal=Number(item.nominal),plus=item.tolerancePlus==null||item.tolerancePlus===''?null:Number(item.tolerancePlus),minus=item.toleranceMinus==null||item.toleranceMinus===''?null:Number(item.toleranceMinus);
 if(!Number.isFinite(nominal)||nominal<0)return null;
 if(plus!==null&&(!Number.isFinite(plus)||plus<0||plus>=nominal))return {...item,status:'REVISAR',reviewReason:'Tolerância positiva inválida ou maior que o nominal.'};
 if(minus!==null&&(!Number.isFinite(minus)||minus<0||minus>=nominal))return {...item,status:'REVISAR',reviewReason:'Tolerância negativa inválida ou maior que o nominal.'};
 const symmetric=plus!==null&&minus!==null&&Math.abs(plus-minus)<1e-9;
 const prefix=item.symbol==='Ø'?'Ø':item.symbol==='R'?'R':'';
 const canonical=plus===null?(item.rawText||`${prefix}${String(nominal).replace('.',',')}`):`${prefix}${String(nominal).replace('.',',')}${symmetric?' ± ':' +'}${String(plus).replace('.',',')}${symmetric?'':' / -'+String(minus).replace('.',',')}`;
 return {...item,nominal,tolerancePlus:plus,toleranceMinus:minus,rawText:canonical,recognizedText:canonical};
}
function findNearbyReadingConflicts(dimensions,threshold=14){
 const conflicts=[];
 for(let left=0;left<dimensions.length;left++)for(let right=left+1;right<dimensions.length;right++){
  const a=dimensions[left],b=dimensions[right];
  if(a.page!==b.page||String(a.symbol||'')!==String(b.symbol||''))continue;
  if(![a.x,a.y,b.x,b.y].every(value=>Number.isFinite(Number(value))))continue;
  if(!(Number(a.width)>0||Number(a.height)>0)||!(Number(b.width)>0||Number(b.height)>0))continue;
  const ax=Number(a.x)+Number(a.width||0)/2,ay=Number(a.y)+Number(a.height||0)/2;
  const bx=Number(b.x)+Number(b.width||0)/2,by=Number(b.y)+Number(b.height||0)/2;
  const sameValue=Math.abs(Number(a.nominal)-Number(b.nominal))<1e-9
   &&(a.tolerancePlus??null)===(b.tolerancePlus??null)&&(a.toleranceMinus??null)===(b.toleranceMinus??null);
  if(!sameValue&&Math.hypot(ax-bx,ay-by)<threshold)conflicts.push({left,right});
 }
 return conflicts;
}
const TITLE_BLOCK_LABEL=/\b(?:peso|[aá]rea|per[ií]metro|escala|desenhista|desenhado\s+por|cliente|classe\s+do\s+perfil|acabamento|liga|d[cç]c|c[oó]digo\s+do\s+perfil|revis[aã]o|aprova[cç][aã]o|aprovad[oa]|verifica[cç][aã]o|data|notas?|estimativa|s[oó]lido|semi[- ]?tubular|tubular|t[ií]tulo|respons[aá]vel|identifica[cç][aã]o|toler[aâ]ncia\s+angular|espessura\s+n[aã]o\s+indicada|raios?\s+n[aã]o\s+indicados|superf[ií]cies\s+vis[ií]veis)\b/i;
function findReferenceTableRegions(page){
 const items=(page?.items||[]).filter(item=>Number.isFinite(Number(item.x))&&Number.isFinite(Number(item.y)));
 const headings=items.filter(item=>/^(?:faixa|limites?|toler[aâ]ncia|±\s*\(?mm\)?|\(?mm\)?)$/i.test(String(item.text||'').trim()));
 const regions=[];
 for(const tolerance of headings.filter(item=>/toler[aâ]ncia/i.test(String(item.text||'')))){
  const nearby=headings.filter(item=>item!==tolerance&&Math.abs(Number(item.y)-Number(tolerance.y))<26&&Math.abs(Number(item.x)-Number(tolerance.x))<115);
  if(!nearby.some(item=>/faixa|limites?|mm/i.test(String(item.text||''))))continue;
  const group=[tolerance,...nearby],minX=Math.min(...group.map(item=>Number(item.x))),maxX=Math.max(...group.map(item=>Number(item.x)+Number(item.width||0))),minY=Math.min(...group.map(item=>Number(item.y))),maxY=Math.max(...group.map(item=>Number(item.y)+Number(item.height||0)));
  const region={page:Number(page.page),type:'TABELA_REFERENCIA',x0:Math.max(0,minX-8),y0:Math.max(0,minY-115),x1:Math.min(Number(page.width)||Infinity,maxX+24),y1:Math.min(Number(page.height)||Infinity,maxY+12)};
  if(!regions.some(existing=>Math.abs(existing.x0-region.x0)<2&&Math.abs(existing.y0-region.y0)<2&&Math.abs(existing.x1-region.x1)<2&&Math.abs(existing.y1-region.y1)<2))regions.push(region);
 }
 return regions;
}
function filterReferenceTableDimensions(dimensions,pages=[]){
 const regions=pages.flatMap(findReferenceTableRegions),kept=[],excluded=[];
 for(const item of dimensions){
  const x=Number(item.x)+Number(item.width||0)/2,y=Number(item.y)+Number(item.height||0)/2;
  const region=regions.find(box=>Number(box.page)===Number(item.page)&&x>=box.x0&&x<=box.x1&&y>=box.y0&&y<=box.y1);
  if(region)excluded.push({...item,excludedRegion:region});else kept.push(item);
 }
 return {dimensions:kept,excluded,regions};
}
function findTitleBlockRegions(page,{minLabels=4,nearX=160,nearY=110,padding=12}={}){
 const labels=(page?.items||[]).filter(item=>TITLE_BLOCK_LABEL.test(String(item.text||''))&&Number.isFinite(Number(item.x))&&Number.isFinite(Number(item.y)));
 const visited=new Set(),regions=[];
 for(let start=0;start<labels.length;start++){
  if(visited.has(start))continue;
  const queue=[start],cluster=[];visited.add(start);
  for(let cursor=0;cursor<queue.length;cursor++){
   const current=labels[queue[cursor]];cluster.push(current);
   for(let index=0;index<labels.length;index++){
    if(visited.has(index))continue;
    const candidate=labels[index];
    if(Math.abs(Number(candidate.x)-Number(current.x))<=nearX&&Math.abs(Number(candidate.y)-Number(current.y))<=nearY){visited.add(index);queue.push(index)}
   }
  }
  if(cluster.length<minLabels)continue;
  const minY=Math.min(...cluster.map(item=>Number(item.y))),maxY=Math.max(...cluster.map(item=>Number(item.y)+Math.max(0,Number(item.height)||0)));
  const verticalPadding=maxY>(Number(page.height)||0)*.75?Math.max(padding,44):padding;
  regions.push({
   page:Number(page.page),
   x0:Math.max(0,Math.min(...cluster.map(item=>Number(item.x)))-padding),
   y0:Math.max(0,minY-verticalPadding),
   x1:Math.min(Number(page.width)||Infinity,Math.max(...cluster.map(item=>Number(item.x)+Math.max(0,Number(item.width)||0)))+padding),
   y1:Math.min(Number(page.height)||Infinity,maxY+padding),
   labels:cluster.length
  });
 }
 return regions;
}
function filterTitleBlockDimensions(dimensions,pages=[]){
 const regions=pages.flatMap(page=>findTitleBlockRegions(page));
 const kept=[],excluded=[];
 for(const item of dimensions){
  const x=Number(item.x)+Number(item.width||0)/2,y=Number(item.y)+Number(item.height||0)/2;
  const region=regions.find(box=>Number(box.page)===Number(item.page)&&x>=box.x0&&x<=box.x1&&y>=box.y0&&y<=box.y1);
  if(region)excluded.push({...item,titleBlockRegion:region});else kept.push(item);
 }
 return {dimensions:kept,excluded,regions};
}
function inferAdministrativeZones(dimensions,pages=[]){
 const pageMap=new Map(pages.map(page=>[Number(page.page),page])),zones=[];
 for(const [pageNumber,page] of pageMap){
  const width=Number(page.width)||0,height=Number(page.height)||0;
  if(!width||!height)continue;
  const candidates=dimensions.filter(item=>Number(item.page)===pageNumber&&item.source==='OCR_LAB');
  const bottom=candidates.filter(item=>{
   const centerY=Number(item.y)+Number(item.height||0)/2;
   return Number.isFinite(centerY)&&centerY<height*.28;
  });
  if(bottom.length>=4){
   const centers=bottom.map(item=>Number(item.x)+Number(item.width||0)/2).filter(Number.isFinite);
   const span=centers.length?Math.max(...centers)-Math.min(...centers):0,cornerCluster=centers.length>=4&&(centers.every(value=>value>width*.62)||centers.every(value=>value<width*.38));
   if(centers.length>=4&&(span>=width*.2||cornerCluster)){
    zones.push({page:pageNumber,type:'QUADRO_INFERIOR',x0:Math.max(0,Math.min(...centers)-40),y0:0,x1:Math.min(width,Math.max(...centers)+40),y1:height*.3});
   }
  }
  for(const side of ['left','right']){
   const edge=candidates.filter(item=>{
    const centerX=Number(item.x)+Number(item.width||0)/2;
    return Number.isFinite(centerX)&&(side==='left'?centerX<width*.14:centerX>width*.86);
   });
   if(edge.length<5)continue;
   const centers=edge.map(item=>Number(item.y)+Number(item.height||0)/2).filter(Number.isFinite);
   if(centers.length>=5&&Math.max(...centers)-Math.min(...centers)>=height*.35){
    zones.push({page:pageNumber,type:'MATRIZ_LATERAL',x0:side==='left'?0:width*.84,y0:Math.max(0,Math.min(...centers)-30),x1:side==='left'?width*.16:width,y1:Math.min(height,Math.max(...centers)+30)});
   }
  }
 }
 return zones;
}
function strictCandidateReason(item,page,zones,conflicted=false){
 if(!item||item.source!=='OCR_LAB')return null;
 const parsed=parseTechnicalDimension(item.rawText||item.recognizedText||'');
 const toleranced=item.tolerancePlus!==null&&item.tolerancePlus!==undefined||item.toleranceMinus!==null&&item.toleranceMinus!==undefined||Boolean(parsed&&['SYMMETRIC','ASYMMETRIC'].includes(parsed.kind));
 const width=Number(item.width),height=Number(item.height),confidence=Number(item.confidence||0);
 const centerX=Number(item.x)+width/2,centerY=Number(item.y)+height/2;
 const region=zones.find(zone=>Number(zone.page)===Number(item.page)&&centerX>=zone.x0&&centerX<=zone.x1&&centerY>=zone.y0&&centerY<=zone.y1);
 // Inferred edge/bottom bands are soft clues: control-production panels can
 // contain real toleranced dimensions, so retain those for human review.
 if(region&&!toleranced)return region.type;
 if(![width,height,centerX,centerY].every(Number.isFinite)||width<=0||height<=0)return 'POSICAO_OCR_INVALIDA';
 const pageWidth=Number(page?.width)||842,pageHeight=Number(page?.height)||595,aspect=Math.max(width,height)/Math.max(.1,Math.min(width,height));
 if(width>pageWidth*.16||height>pageHeight*.06||aspect>8)return 'CAIXA_OCR_INCOMPATIVEL_COM_COTA';
 const radius=item.symbol==='R'||item.dimensionType==='RADIUS'||parsed?.type==='RADIUS';
 const geometry=item.geometryEvidence||{};
 // A nearby border/alignment is not enough to validate a plain number. Require
 // an independent dimension termination or extension-line relationship.
 if(!toleranced&&!radius&&!(geometry.dimensionLine&&(geometry.arrowTermination||geometry.extensionLines))){
  return 'NUMERO_SIMPLES_SEM_LINHA_DE_COTA_E_TERMINACAO';
 }
 if(conflicted&&!toleranced)return 'LEITURAS_CONFLITANTES_NA_MESMA_POSICAO';
 if(!toleranced&&!radius&&/regi[aã]o ampliada/i.test(String(item.reviewReason||'')))return 'NUMERO_SIMPLES_SEM_GEOMETRIA_DE_COTA';
 if(radius&&confidence<.55)return 'RAIO_SEM_EVIDENCIA_SUFICIENTE';
 if(!toleranced&&!radius&&confidence<.72)return 'NUMERO_SIMPLES_COM_BAIXA_CONFIANCA';
 return null;
}
function applyStrictCandidateGate(dimensions,pages=[],conflicts=[]){
 const pageMap=new Map(pages.map(page=>[Number(page.page),page])),zones=inferAdministrativeZones(dimensions,pages);
 const conflicted=new Set(conflicts.flatMap(item=>[item.left,item.right]));
 const accepted=[],suggestions=[];
 dimensions.forEach((item,index)=>{
  const reason=strictCandidateReason(item,pageMap.get(Number(item.page)),zones,conflicted.has(index));
  if(reason)suggestions.push({...item,status:'SUGESTAO',exclusionReason:reason});else accepted.push(item);
 });
 return {accepted,suggestions,zones};
}
function preserveGeometricToleranceForReview(item){
 const parsed=parseTechnicalDimension(item.rawText||item.recognizedText||'');
 const hasTolerance=item.tolerancePlus!==null&&item.tolerancePlus!==undefined||item.toleranceMinus!==null&&item.toleranceMinus!==undefined||Boolean(parsed&&['SYMMETRIC','ASYMMETRIC'].includes(parsed.kind));
 // TITLE_BLOCK is a soft zone inferred from nearby labels on these drawings;
 // genuine control-production dimensions can sit beside it. Explicit tables,
 // notes and paragraphs stay excluded, while title-block-adjacent tolerances
 // remain reviewable and can never be auto-confirmed from this override.
 const administrative=['TABELA_REFERENCIA','TABLE','TECHNICAL_NOTE','PARAGRAPH','NOTE'].includes(item.documentZone);
 if(hasTolerance&&!administrative&&item.decisionClassification==='NOT_DIMENSION')
  return {...item,decisionClassification:'REVIEW',reviewReason:'Leitura tem formato de cota com tolerância; OCR/confiança contextual baixos, requer conferência visual.'};
 return item;
}
function validateDimensions(dimensions){
 const accepted=[],discarded=[];
 for(const original of dimensions){const item=normalizeDimension(original);if(!item){discarded.push(original);continue;}
  const duplicate=accepted.find(other=>other.page===item.page&&String(other.symbol||'')===String(item.symbol||'')&&Math.hypot((other.x||0)-(item.x||0),(other.y||0)-(item.y||0))<8&&Math.abs(other.nominal-item.nominal)<1e-9);
  if(duplicate){if((item.confidence||0)>(duplicate.confidence||0))Object.assign(duplicate,item);discarded.push(item);continue;} accepted.push(item);
 }
 const conflicts=findNearbyReadingConflicts(accepted);
 for(const {left,right} of conflicts){
  const reason='Foram lidas cotas diferentes em posições muito próximas. Confira no desenho se é a mesma cota antes de salvar.';
  accepted[left].status='REVISAR';accepted[left].reviewReason=reason;
  accepted[right].status='REVISAR';accepted[right].reviewReason=reason;
 }
 return {accepted,discarded,conflicts};
}
function drawingOptions(input={}){return {mode:input.mode==='vector'?'vector':'complete',maxPages:Math.max(1,Math.min(10,Number(input.maxPages)||10)),includePlain:input.includePlain!==false,minConfidence:Math.max(0,Math.min(.95,Number(input.minConfidence)||0)),detailedScan:input.detailedScan===true,debug:input.debug===true};}
function analysisVersionFor(fileName,options={}){return /^BC(?:[-_ .]|$)/i.test(String(fileName||''))?FLAT_BAR_ENGINE_VERSION:options.detailedScan?DETAILED_ENGINE_VERSION:ENGINE_VERSION;}
function sparsePageNumbers(dimensions,pages,threshold=SPARSE_PAGE_DIMENSION_THRESHOLD){
 const counts=new Map();
 for(const item of dimensions){const page=Number(item.page);counts.set(page,(counts.get(page)||0)+1);}
 return pages.filter(page=>(counts.get(Number(page.page))||0)<=threshold).map(page=>Number(page.page));
}
function preferFlatBarProfileView(dimensions,pages=[]){
 const flatBarPages=new Map(pages.map(page=>[Number(page.page),page]));
 const rightSide=(item,page)=>Number.isFinite(Number(item.x))&&Number.isFinite(Number(item.width))&&Number.isFinite(Number(page?.width))&&Number(page.width)>0&&(Number(item.x)+Number(item.width)/2)>=Number(page.width)*.5;
 const pageDimensions=new Map();
 for(const item of dimensions){if(!pageDimensions.has(item.page))pageDimensions.set(item.page,[]);pageDimensions.get(item.page).push(item);}
 const rightPages=new Set([...pageDimensions].filter(([number,items])=>items.some(item=>rightSide(item,flatBarPages.get(Number(number))))).map(([number])=>Number(number)));
 const pageHints=new Map([...pageDimensions].map(([number,items])=>{
  const page=flatBarPages.get(Number(number)),text=String(page?.text||'');
  const hasRadius=items.some(item=>item.symbol==='R'||/^\s*R\s*\d/i.test(String(item.rawText||'')));
  const packaging=/\bembalagem\b|intercalar\s+pe[cç]a|pe[cç]a\s+por\s+amarrado|\bEP\b/i.test(text);
  const hasRight=items.some(item=>rightSide(item,page));
  return [Number(number),{hasRadius,packaging,strongProfile:hasRadius||(!packaging&&(items.length>=2||hasRight))}];
 }));
 const strongProfilePages=new Set([...pageHints].filter(([,hint])=>hint.strongProfile).map(([number])=>number));
 const ignoredPackagingPages=[];
 const result=dimensions.filter(item=>{
  const pageNumber=Number(item.page),page=flatBarPages.get(pageNumber);
  const hint=pageHints.get(pageNumber)||{},packaging=hint.packaging,hasRadius=hint.hasRadius;
  const hasRight=rightPages.has(pageNumber);
  // A radius, or multiple/right-hand dimensions on a non-packaging page, is
  // profile-view evidence. Ignore a separate packaging-only page only when
  // that stronger view exists; otherwise preserve uncertain dimensions.
  const profileOnAnotherPage=[...strongProfilePages].some(number=>number!==pageNumber);
  if(profileOnAnotherPage&&packaging&&!hasRadius){if(!ignoredPackagingPages.includes(pageNumber))ignoredPackagingPages.push(pageNumber);return false;}
  // On sheets containing both views, annotations in the right-hand view are
  // the authoritative profile dimensions. Do not apply this to pages without
  // at least one located right-side callout.
  if(hasRight&&rightSide(item,page))return true;
  if(hasRight&&Number.isFinite(Number(item.x))&&Number.isFinite(Number(item.width)))return false;
  return true;
 });
 const applied=result.length!==dimensions.length;
 return {dimensions:result,diagnostics:{applied,rightSideThreshold:0.5,removedDimensions:dimensions.length-result.length,ignoredPackagingPages}};
}
async function processDrawing(fileName,bytes,inputOptions={}){
 if(busy)throw Error('Uma análise já está em andamento. Aguarde a conclusão.');
 busy=true;const options=drawingOptions(inputOptions);
 try{
  const pdf=await extractPdf(bytes,options),result=analyze({fileName,pdf});
  const vector=result.dimensions;
  const flatBar=/^BC(?:[-_ .]|$)/i.test(String(fileName||''));
  // Keep the fast focused pass on pages with enough searchable dimensions,
  // but widen sparse pages: one vector match must not suppress every other
  // dimension that was converted to curves or missed by PDF text extraction.
  const recoveryPages=options.mode==='complete'&&!flatBar&&!options.detailedScan&&vector.length
   ?sparsePageNumbers(vector,pdf.pages):[];
  const laboratory=options.mode==='vector'?[]:await extractLabDimensions(bytes,{
   ...options,
   focusedOnly:vector.length>0&&!flatBar&&!options.detailedScan,
   fullScanPages:recoveryPages,
   focusedNeighbors:options.mode==='complete'||flatBar||options.detailedScan,
   flatBarRecovery:flatBar
  });
  if(laboratory.length){
   // Vector text is precise when it exists. The laboratory layer adds cotas
   // converted to curves and filters the visual candidates by their geometry.
   result.dimensions=mergeDimensions(laboratory,vector);result.method=vector.length?'HYBRID_LAB':'OCR_LAB';
   result.warnings=[flatBar?'Barra chata: foi feita uma varredura visual ampla para procurar cotas adicionais e raios. Confira os itens em revisão antes de salvar o perfil.':'Leitura experimental: o motor separou cotas da geometria e agrupou tolerâncias pela posição. Confira os itens em revisão antes de salvar o perfil.'];
  }else if(!vector.length&&options.mode!=='vector'){
   // The previous OCR is retained only as a controlled fallback while the
   // laboratory engine is being benchmarked against real production drawings.
   result.dimensions=await extractVisualDimensions(bytes);result.method=result.dimensions.length?'OCR_LEGACY':'OCR';
   result.warnings=result.dimensions.length?['Leitura de contingência: confira os itens em revisão antes de salvar o perfil.']:['Nem a leitura de texto nem a leitura experimental identificaram cotas seguras. Confira o desenho original.'];
  }
  if(options.mode==='vector'){
   result.method='VETORIAL';result.warnings=['Leitura somente do texto pesquisável do PDF. Use a leitura completa para desenhos digitalizados ou cotas convertidas em curvas.'];
  }
  const flatBarSelection=flatBar?preferFlatBarProfileView(result.dimensions,pdf.pages):{dimensions:result.dimensions,diagnostics:{applied:false,rightSideThreshold:null,removedDimensions:0,ignoredPackagingPages:[]}};
  const referenceTableSelection=filterReferenceTableDimensions(flatBarSelection.dimensions,pdf.pages);
  const titleBlockSelection=filterTitleBlockDimensions(referenceTableSelection.dimensions,pdf.pages);
  const excludedByRegion=[...referenceTableSelection.excluded.map(item=>({...item,status:'SUGESTAO',exclusionReason:'Localizado dentro de uma tabela de referência.'})),...titleBlockSelection.excluded.map(item=>({...item,status:'SUGESTAO',exclusionReason:'Localizado dentro do quadro técnico/título.'}))];
  result.dimensions=titleBlockSelection.dimensions;
  if(flatBar&&flatBarSelection.diagnostics.applied)result.warnings=[...(result.warnings||[]),'Barra chata BC: priorizadas as cotas do desenho à direita; confira a evidência visual antes de confirmar.'];
  const checked=validateDimensions(result.dimensions),stacked=assembleStackedTolerance(checked.accepted,parseTechnicalDimension),candidates=[...checked.accepted,...stacked],inferredAdministrative=inferAdministrativeZones(candidates,pdf.pages).map(region=>({...region,type:'TITLE_BLOCK',inferredType:region.type})),regions=[...referenceTableSelection.regions,...titleBlockSelection.regions.map(region=>({...region,type:'TITLE_BLOCK'})),...inferredAdministrative];
  const decision=classifyCandidates(candidates,pdf.pages,{regions,conflicts:checked.conflicts});
  // Tolerance-formatted OCR candidates can be genuine dimensions even when
  // geometry or OCR scoring is weak. Keep them for human review, never auto-accept.
  const reviewCandidates=decision.candidates.map(preserveGeometricToleranceForReview);
  const scored=deduplicateCandidates(reviewCandidates);
  const technicalDimensions=scored.filter(item=>item.semanticClass==='TECHNICAL_DIMENSION'),technicalProperties=extractTechnicalAnnotations(pdf.pages),geometricScored=scored.filter(item=>item.semanticClass!=='TECHNICAL_DIMENSION'),eligible=geometricScored.filter(item=>item.decisionClassification!=='NOT_DIMENSION'),notDimensions=geometricScored.filter(item=>item.decisionClassification==='NOT_DIMENSION');
  const strict=applyStrictCandidateGate(eligible,pdf.pages,checked.conflicts),strictReview=new Set(strict.suggestions.map(item=>item.id));
  result.dimensions=prioritizeDimensions(strict.accepted.filter(item=>(options.includePlain||item.tolerancePlus!==null||item.toleranceMinus!==null)&&Number(item.ocrConfidence??item.confidence??0)>=options.minConfidence).map(item=>({...item,status:item.decisionClassification==='REVIEW'||strictReview.has(item.id)?'REVISAR':item.status,reviewReason:item.decisionClassification==='REVIEW'?'Candidato mantido para revisão pelo score contextual.':item.reviewReason})));
  const gateSuggestions=strict.suggestions.map(item=>({...item,status:'SUGESTAO',exclusionReason:item.exclusionReason||'Evidência geométrica insuficiente para validar automaticamente.'}));
  result.suggestions=prioritizeDimensions([...notDimensions.map(item=>({...item,status:'SUGESTAO',exclusionReason:item.decisionLog?.map(entry=>entry.detail).join(' ')||'Score contextual insuficiente para classificar como cota.'})),...gateSuggestions,...excludedByRegion]);
  const exclusionReasons=result.suggestions.reduce((summary,item)=>(summary[item.exclusionReason]=(summary[item.exclusionReason]||0)+1,summary),{});
  result.notDimensions=notDimensions;result.technicalDimensions=technicalDimensions;result.technicalProperties=technicalProperties;result.featureIds=laboratory.featureIds||[];
  const featureNodes=result.featureIds.map(item=>({id:item.id,type:'CALLOUT',featureId:item.featureId,bbox:item.bbox,containerId:item.containerId,classification:'FEATURE_ID'})),featureEdges=result.featureIds.filter(item=>item.containerId).map(item=>({from:item.id,to:item.containerId,relation:'FEATURE_ID_TO_CONTAINER'}));result.associationGraph=buildAssociationGraph(scored,featureNodes);result.associationGraph.edges.push(...featureEdges);
  const averageComponents=['ocrScore','semanticScore','geometryScore','zoneScore','contextScore','groupingScore'].reduce((summary,key)=>(summary[key]=Number((scored.reduce((sum,item)=>sum+Number(item.scoreComponents?.[key]||0),0)/Math.max(1,scored.length)).toFixed(3)),summary),{});
  const debugOverlay=options.debug?{zones:decision.zones,candidates:scored.map(item=>({id:item.id,page:item.page,bbox:{x:item.x,y:item.y,width:item.width,height:item.height},text:item.rawOCRText||item.rawText,rawOCRTokens:item.rawOCRTokens||[],finalText:item.finalText||item.rawText,classification:item.semanticClass||item.decisionClassification,score:item.dimensionScore,zone:item.documentZone,containerId:item.containerId||null,visualComponentId:item.visualComponentId||null,dimensionLine:item.geometryEvidence?.line||null,dimensionLineId:item.dimensionLineId||null,leaderLineId:item.geometryEvidence?.associatedLeaderLineId||null,extensionLineCount:item.geometryEvidence?.extensionLineCount||0,termination:item.geometryEvidence?.dimensionTermination||null})),featureIds:result.featureIds,associationGraph:result.associationGraph}:null;
  result.diagnostics={...(result.diagnostics||{}),dimensionDecision:{zones:decision.zones,dimension:scored.filter(item=>item.decisionClassification==='DIMENSION').length,review:scored.filter(item=>item.decisionClassification==='REVIEW').length,notDimension:notDimensions.length,thresholds:{dimension:75,review:45},averageComponents,stackedGroups:stacked.length},debugOverlay,referenceTableFilter:{applied:referenceTableSelection.excluded.length>0,excludedReadings:referenceTableSelection.excluded.length,regions:referenceTableSelection.regions},titleBlockFilter:{applied:titleBlockSelection.excluded.length>0,excludedReadings:titleBlockSelection.excluded.length,regions:titleBlockSelection.regions},strictCandidateGate:{applied:strict.suggestions.length>0,accepted:strict.accepted.length,suggestions:strict.suggestions.length,zones:strict.zones,exclusionReasons},flatBarRightView:flatBarSelection.diagnostics,coverageRecovery:{applied:recoveryPages.length>0,pages:recoveryPages,threshold:SPARSE_PAGE_DIMENSION_THRESHOLD},discardedDimensions:checked.discarded.length,nearbyReadingConflicts:checked.conflicts.length,reviewDimensions:result.dimensions.filter(item=>item.status==='REVISAR').length};
  if(result.suggestions.length)result.warnings=[...(result.warnings||[]),`${result.suggestions.length} leitura(s) sem validação automática foram mantidas nas sugestões para auditoria e possível revisão manual.`];
  if(recoveryPages.length)result.warnings=[...(result.warnings||[]),`Poucas cotas pesquisáveis em ${recoveryPages.length} página(s); foi feita varredura visual ampliada. Confira as cotas e as evidências antes de confirmar.`];
  const radiusCount=result.dimensions.filter(item=>item.dimensionType==='RADIUS').length;
  const linearCount=result.dimensions.filter(item=>item.dimensionType==='LINEAR'||item.dimensionType==='TOLERANCED_LINEAR').length;
  const radiusDominated=radiusCount>=3&&linearCount<radiusCount;
  result.diagnostics={...result.diagnostics,dimensionTypes:{linear:linearCount,radius:radiusCount,other:result.dimensions.length-linearCount-radiusCount},radiusDominated};
  if(radiusDominated)result.warnings=[...(result.warnings||[]),'Foram encontrados mais raios do que cotas lineares. A leitura ampliada priorizou regiões diferentes, mas confira se as cotas principais do perfil também foram capturadas.'];
  if(options.mode==='complete'&&result.dimensions.length===1)result.warnings=[...(result.warnings||[]),'A análise encontrou apenas uma cota. Isso não confirma que o desenho tenha somente essa medida; confira todas as páginas e a evidência visual antes de salvar.'];
  if(checked.conflicts.length)result.warnings=[...(result.warnings||[]),`${checked.conflicts.length} leitura(s) diferente(s) aparecem em posições muito próximas. Foram mantidas para conferência visual, sem escolher uma automaticamente.`];
  if(pdf.truncated)result.warnings=[...(result.warnings||[]),`Foram analisadas as primeiras ${pdf.pageCount} de ${pdf.sourcePageCount} página(s), conforme a configuração.`];
  if(!options.includePlain)result.warnings=[...(result.warnings||[]),'Cotas sem tolerância explícita foram ocultadas conforme a configuração.'];
  if(options.minConfidence>0)result.warnings=[...(result.warnings||[]),`Leituras com confiança abaixo de ${Math.round(options.minConfidence*100)}% foram ocultadas conforme a configuração.`];
  result.settings=options;
  if(checked.discarded.length)result.warnings=[...(result.warnings||[]),`${checked.discarded.length} resultado(s) duplicado(s) ou inválido(s) foram removido(s).`];
  result.engineVersion=analysisVersionFor(fileName,options);return result;
 }finally{busy=false;}
}
module.exports={processDrawing,drawingOptions,ENGINE_VERSION,DETAILED_ENGINE_VERSION,FLAT_BAR_ENGINE_VERSION,SPARSE_PAGE_DIMENSION_THRESHOLD,analysisVersionFor,preferFlatBarProfileView,sparsePageNumbers,classifyDimension,prioritizeDimensions,findNearbyReadingConflicts,findTitleBlockRegions,filterTitleBlockDimensions,findReferenceTableRegions,filterReferenceTableDimensions,inferAdministrativeZones,strictCandidateReason,applyStrictCandidateGate,preserveGeometricToleranceForReview};
