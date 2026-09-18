const {readSheet}=require('read-excel-file/node');
const crypto=require('crypto');
const text=value=>String(value??'').trim();
const number=value=>{const digits=String(value??'').replace(/\D/g,'');if(!digits)return null;const n=Number(digits);return Number.isFinite(n)?n:null;};
const key=value=>text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
function splitTool(value){const raw=text(value).toUpperCase().replace(/\s+/g,''),match=raw.match(/^(.*?)[\/-](\d{1,3})$/);return match?{tool:match[1],sequence:Number(match[2])}:{tool:raw,sequence:null};}
function headerInfo(sheet){for(let row=0;row<sheet.length;row++){const cells=sheet[row].map(key),lot=cells.findIndex(v=>v==='LOTE'),tool=cells.findIndex(v=>v.startsWith('FERRAMENTA'));if(lot>=0&&tool>=0)return {row,lot,tool,cells};}return null;}
function field(headers,...names){for(const name of names){const index=headers.findIndex(v=>v===name||v.startsWith(name));if(index>=0)return index;}return -1;}
function hashId(seed){const hash=crypto.createHash('sha256').update(seed).digest('hex');return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
function summary(rows){return {total:rows.length,matched:rows.filter(r=>r.status==='matched').length,new:rows.filter(r=>r.status==='new').length,unmatched:rows.filter(r=>r.status==='unmatched').length,ambiguous:rows.filter(r=>r.status==='ambiguous').length};}
async function parseCorrections(bytes,current){
 const sheet=await readSheet(bytes),info=headerInfo(sheet);
 if(!info)throw Error('Não foi possível localizar as colunas Lote e Ferramenta no Excel.');
 const correctionIndex=field(info.cells,'CORRECAO EFETUADA'),productionDateIndex=field(info.cells,'DATA PRODUCAO');
 const notes=(current.productionNotes?.length?current.productionNotes:current.corrections)||[],tests=current.records||[];
 if(correctionIndex>=0){
  const source=sheet.slice(info.row+1).filter(row=>text(row[info.lot])&&text(row[info.tool])&&text(row[correctionIndex]));
  const correctionDateIndex=field(info.cells,'DATA CORRECAO');
  const rows=source.map((row,index)=>{
   const lot=number(row[info.lot]),systemTool=text(row[info.tool]),parsed=splitTool(systemTool),correction=text(row[correctionIndex]);
   const byLot=notes.filter(note=>lot!==null&&number(note.payload?.Lote)===lot);
   const byToolSequence=notes.filter(note=>key(note.tool)===parsed.tool&&number(note.sequence)===parsed.sequence);
   const exactLotToolSequence=byLot.filter(note=>key(note.tool)===parsed.tool&&number(note.sequence)===parsed.sequence);
   let candidates,matchedBy;
   if(exactLotToolSequence.length){candidates=exactLotToolSequence;matchedBy='lote, ferramenta e sequência';}
   else if(byLot.length){candidates=byLot;matchedBy='lote';}
   else{candidates=byToolSequence;matchedBy='ferramenta e sequência';}
   const match=candidates.length===1?candidates[0]:null;
   const testMatch=tests.some(test=>key(test.tool)===parsed.tool&&number(test.sequence)===parsed.sequence);
   const status=match?'matched':candidates.length>1?'ambiguous':testMatch?'new':'unmatched';
   return {kind:'correction',row:info.row+index+2,lot,systemTool,tool:parsed.tool,sequence:parsed.sequence,correction,correctionDate:correctionDateIndex>=0?text(row[correctionDateIndex]):'',payload:{Lote:lot,Ferramenta:systemTool,'Correção Efetuada':correction},matchId:match?.id||(status==='new'?hashId(`${lot}|${systemTool}|${index}`):null),matchedBy:match?matchedBy:status==='new'?'ferramenta e sequência':null,status};
  });
  return {kind:'correction',rows,summary:summary(rows)};
 }
 if(productionDateIndex<0)throw Error('Este arquivo não possui a coluna Data Produção. Selecione o relatório de produção exportado pelo sistema.');
 const rows=sheet.slice(info.row+1).map((row,index)=>{const lot=number(row[info.lot]),systemTool=text(row[info.tool]),parsed=splitTool(systemTool);if(!lot||!parsed.tool)return null;const testMatch=tests.some(test=>key(test.tool)===parsed.tool&&Number(test.sequence)===Number(parsed.sequence)),payload={};info.cells.forEach((header,column)=>{if(header&&row[column]!=null&&text(row[column])!=='')payload[text(sheet[info.row][column])]=row[column];});return {kind:'production',row:info.row+index+2,lot,systemTool,tool:parsed.tool,sequence:parsed.sequence,productionDate:text(row[productionDateIndex]),correction:'Produção importada',correctionDate:'',payload,matchId:hashId(`${lot}|${systemTool}|${text(row[productionDateIndex])}|${index}`),matchedBy:testMatch?'ferramenta e sequência':'produção sem teste correspondente',status:testMatch?'matched':'new'};}).filter(Boolean);
 return {kind:'production',rows,summary:summary(rows)};
}
module.exports={parseCorrections};
