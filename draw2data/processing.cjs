const {extractPdf}=require('./reader.cjs');
const {analyze}=require('./detection.cjs');
const {extractVisualDimensions}=require('./ocr.cjs');
const {extractLabDimensions}=require('./lab-engine.cjs');
const ENGINE_VERSION='3.8-black-and-blue-titleblock-filter';
const DETAILED_ENGINE_VERSION='3.6-black-and-blue-titleblock-filter';
const FLAT_BAR_ENGINE_VERSION='3.7-black-and-blue-titleblock-filter';
const SPARSE_PAGE_DIMENSION_THRESHOLD=3;
let busy=false;

function classifyDimension(item){
 const text=String(item.rawText||item.recognizedText||'');
 let type,priority,label;
 if(item.reference===true||/\bREF\b/i.test(text)){type='REFERENCE';priority=4;label='Referência';}
 else if(item.symbol==='R'||item.dimensionType==='RADIUS'||/^\s*R\s*\d/i.test(text)){type='RADIUS';priority=3;label='Raio';}
 else if(item.symbol==='Ø'||item.symbol==='⌀'||/[Ø⌀]/.test(text)){type='DIAMETER';priority=2;label='Diâmetro';}
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
function drawingOptions(input={}){return {mode:input.mode==='vector'?'vector':'complete',maxPages:Math.max(1,Math.min(10,Number(input.maxPages)||10)),includePlain:input.includePlain!==false,minConfidence:Math.max(0,Math.min(.95,Number(input.minConfidence)||0)),detailedScan:input.detailedScan===true};}
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
  const titleBlockSelection=filterTitleBlockDimensions(result.dimensions,pdf.pages);
  result.dimensions=titleBlockSelection.dimensions;
  if(titleBlockSelection.excluded.length)result.warnings=[...(result.warnings||[]),`${titleBlockSelection.excluded.length} leitura(s) dentro do quadro técnico foram descartadas para não misturar dados do perfil com valores de área, peso, perímetro e identificação.`];
  const flatBarSelection=flatBar?preferFlatBarProfileView(result.dimensions,pdf.pages):{dimensions:result.dimensions,diagnostics:{applied:false,rightSideThreshold:null,removedDimensions:0,ignoredPackagingPages:[]}};
  result.dimensions=flatBarSelection.dimensions;
  if(flatBar&&flatBarSelection.diagnostics.applied)result.warnings=[...(result.warnings||[]),'Barra chata BC: priorizadas as cotas do desenho à direita; confira a evidência visual antes de confirmar.'];
  const checked=validateDimensions(result.dimensions);result.dimensions=prioritizeDimensions(checked.accepted.filter(item=>(options.includePlain||item.tolerancePlus!==null||item.toleranceMinus!==null)&&Number(item.confidence||0)>=options.minConfidence));
  result.diagnostics={...(result.diagnostics||{}),titleBlockFilter:{applied:titleBlockSelection.excluded.length>0,excludedReadings:titleBlockSelection.excluded.length,regions:titleBlockSelection.regions},flatBarRightView:flatBarSelection.diagnostics,coverageRecovery:{applied:recoveryPages.length>0,pages:recoveryPages,threshold:SPARSE_PAGE_DIMENSION_THRESHOLD},discardedDimensions:checked.discarded.length,nearbyReadingConflicts:checked.conflicts.length,reviewDimensions:result.dimensions.filter(item=>item.status==='REVISAR').length};
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
module.exports={processDrawing,drawingOptions,ENGINE_VERSION,DETAILED_ENGINE_VERSION,FLAT_BAR_ENGINE_VERSION,SPARSE_PAGE_DIMENSION_THRESHOLD,analysisVersionFor,preferFlatBarProfileView,sparsePageNumbers,classifyDimension,prioritizeDimensions,findNearbyReadingConflicts,findTitleBlockRegions,filterTitleBlockDimensions};
