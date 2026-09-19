const {extractPdf}=require('./reader.cjs');
const {analyze}=require('./detection.cjs');
const {extractVisualDimensions}=require('./ocr.cjs');
let busy=false;
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
async function processDrawing(fileName,bytes){
 if(busy)throw Error('Uma análise já está em andamento. Aguarde a conclusão.');
 busy=true;
 try{
  const pdf=await extractPdf(bytes),result=analyze({fileName,pdf});
  if(!result.dimensions.length){
   result.dimensions=await extractVisualDimensions(bytes);result.method='OCR';
   result.warnings=result.dimensions.length?['As cotas foram lidas visualmente. Confira o desenho; campos sem leitura segura ficam em branco.']:['Nem a leitura de texto nem o OCR identificaram cotas seguras. Confira o desenho original.'];
  }
  const checked=validateDimensions(result.dimensions);result.dimensions=checked.accepted;
  result.diagnostics={...(result.diagnostics||{}),discardedDimensions:checked.discarded.length,reviewDimensions:result.dimensions.filter(item=>item.status==='REVISAR').length};
  if(checked.discarded.length)result.warnings=[...(result.warnings||[]),`${checked.discarded.length} resultado(s) duplicado(s) ou inválido(s) foram removido(s).`];
  result.engineVersion='2.0-visual';return result;
 }finally{busy=false;}
}
module.exports={processDrawing};
