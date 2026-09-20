const {extractPdf}=require('./reader.cjs');
const {analyze}=require('./detection.cjs');
const {extractVisualDimensions}=require('./ocr.cjs');
const {extractLabDimensions}=require('./lab-engine.cjs');
let busy=false;

function reliableFallback(item){
 const nominal=Number(item.nominal),plus=item.tolerancePlus==null?null:Number(item.tolerancePlus),minus=item.toleranceMinus==null?null:Number(item.toleranceMinus);
 if(!Number.isFinite(nominal)||nominal<0)return false;
 if(plus!==null||minus!==null)return Number.isFinite(plus)&&Number.isFinite(minus)&&plus>=0&&minus>=0&&plus<nominal&&minus<nominal;
 return Number(item.confidence||0)>=.45;
}
function mergeDimensions(primary,fallback){
 const merged=[...primary];
 for(const candidate of fallback.filter(reliableFallback)){
  const duplicate=merged.some(current=>current.page===candidate.page&&Math.hypot((current.x||0)-(candidate.x||0),(current.y||0)-(candidate.y||0))<9);
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
 const canonical=plus===null?(item.rawText||String(nominal).replace('.',',')):`${String(nominal).replace('.',',')}${symmetric?' ± ':' +'}${String(plus).replace('.',',')}${symmetric?'':' / -'+String(minus).replace('.',',')}`;
 return {...item,nominal,tolerancePlus:plus,toleranceMinus:minus,rawText:canonical,recognizedText:canonical};
}
function validateDimensions(dimensions){
 const accepted=[],discarded=[];
 for(const original of dimensions){const item=normalizeDimension(original);if(!item){discarded.push(original);continue;}
  const duplicate=accepted.find(other=>other.page===item.page&&Math.hypot((other.x||0)-(item.x||0),(other.y||0)-(item.y||0))<8&&Math.abs(other.nominal-item.nominal)<1e-9);
  if(duplicate){if((item.confidence||0)>(duplicate.confidence||0))Object.assign(duplicate,item);discarded.push(item);continue;} accepted.push(item);
 }
 return {accepted,discarded};
}
function drawingOptions(input={}){return {mode:input.mode==='vector'?'vector':'complete',maxPages:Math.max(1,Math.min(10,Number(input.maxPages)||10)),includePlain:input.includePlain!==false,minConfidence:Math.max(0,Math.min(.95,Number(input.minConfidence)||0))};}
async function processDrawing(fileName,bytes,inputOptions={}){
 if(busy)throw Error('Uma análise já está em andamento. Aguarde a conclusão.');
 busy=true;const options=drawingOptions(inputOptions);
 try{
  const pdf=await extractPdf(bytes,options),result=analyze({fileName,pdf});
  const vector=result.dimensions;
  // PDFs exported by CAD usually expose most dimensions as searchable text.
  // In that case the visual layer only needs to inspect the marked critical
  // regions. This keeps the hosted function inside its execution window while
  // still recovering tolerances that were converted to curves.
  const laboratory=options.mode==='vector'?[]:await extractLabDimensions(bytes,{...options,focusedOnly:vector.length>0});
  if(laboratory.length){
   // Vector text is precise when it exists. The laboratory layer adds cotas
   // converted to curves and filters the visual candidates by their geometry.
   result.dimensions=mergeDimensions(laboratory,vector);result.method=vector.length?'HYBRID_LAB':'OCR_LAB';
   result.warnings=['Leitura experimental: o motor separou cotas da geometria e agrupou tolerâncias pela posição. Confira os itens em revisão antes de salvar o perfil.'];
  }else if(!vector.length&&options.mode!=='vector'){
   // The previous OCR is retained only as a controlled fallback while the
   // laboratory engine is being benchmarked against real production drawings.
   result.dimensions=await extractVisualDimensions(bytes);result.method=result.dimensions.length?'OCR_LEGACY':'OCR';
   result.warnings=result.dimensions.length?['Leitura de contingência: confira os itens em revisão antes de salvar o perfil.']:['Nem a leitura de texto nem a leitura experimental identificaram cotas seguras. Confira o desenho original.'];
  }
  if(options.mode==='vector'){
   result.method='VETORIAL';result.warnings=['Leitura somente do texto pesquisável do PDF. Use a leitura completa para desenhos digitalizados ou cotas convertidas em curvas.'];
  }
  const checked=validateDimensions(result.dimensions);result.dimensions=checked.accepted.filter(item=>(options.includePlain||item.tolerancePlus!==null||item.toleranceMinus!==null)&&Number(item.confidence||0)>=options.minConfidence);
  result.diagnostics={...(result.diagnostics||{}),discardedDimensions:checked.discarded.length,reviewDimensions:result.dimensions.filter(item=>item.status==='REVISAR').length};
  if(pdf.truncated)result.warnings=[...(result.warnings||[]),`Foram analisadas as primeiras ${pdf.pageCount} de ${pdf.sourcePageCount} página(s), conforme a configuração.`];
  if(!options.includePlain)result.warnings=[...(result.warnings||[]),'Cotas sem tolerância explícita foram ocultadas conforme a configuração.'];
  if(options.minConfidence>0)result.warnings=[...(result.warnings||[]),`Leituras com confiança abaixo de ${Math.round(options.minConfidence*100)}% foram ocultadas conforme a configuração.`];
  result.settings=options;
  if(checked.discarded.length)result.warnings=[...(result.warnings||[]),`${checked.discarded.length} resultado(s) duplicado(s) ou inválido(s) foram removido(s).`];
  result.engineVersion='3.0-spatial-lab';return result;
 }finally{busy=false;}
}
module.exports={processDrawing,drawingOptions};
