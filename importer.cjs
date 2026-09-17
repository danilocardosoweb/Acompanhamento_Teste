const {readSheet}=require('read-excel-file/node');
const crypto=require('crypto');
const text=value=>String(value??'').trim();
const number=value=>{const n=Number(String(value??'').replace(/\D/g,''));return Number.isFinite(n)?n:null;};
function splitTool(value){const match=text(value).toUpperCase().match(/^(.*?)-(\d{1,3})$/);return match?{tool:match[1],sequence:Number(match[2])}:{tool:text(value).toUpperCase(),sequence:null};}
async function parseCorrections(bytes,current){
 const sheet=await readSheet(bytes),headerIndex=sheet.findIndex(row=>text(row[0]).toLocaleUpperCase('pt-BR')==='LOTE'&&text(row[2]).toLocaleUpperCase('pt-BR').startsWith('FERRAMENTA'));
 if(headerIndex<0)throw Error('Não foi possível localizar as colunas Lote, Ferramenta e Correção Efetuada.');
 const source=sheet.slice(headerIndex+1).filter(row=>text(row[0])&&text(row[2])&&text(row[6]));
 const notes=(current.productionNotes?.length?current.productionNotes:current.corrections)||[];
 const tests=current.records||[];
 const results=source.map((row,index)=>{const lot=number(row[0]),parsed=splitTool(row[2]),correction=text(row[6]),byLot=notes.filter(note=>number(note.payload?.Lote)===lot),byTool=notes.filter(note=>text(note.tool).toUpperCase()===parsed.tool&&number(note.sequence)===parsed.sequence);let candidates=byLot.length?byLot:byTool,matchedBy=byLot.length?'lote':'ferramenta e sequência';if(candidates.length>1){const exact=candidates.filter(note=>text(note.tool).toUpperCase()===parsed.tool&&number(note.sequence)===parsed.sequence);if(exact.length)candidates=exact;}const match=candidates.length===1?candidates[0]:null,testMatch=tests.some(test=>text(test.tool).toUpperCase()===parsed.tool&&number(test.sequence)===parsed.sequence),seed=`${lot}|${text(row[2]).toUpperCase()}|${number(row[3])}`,hash=crypto.createHash('sha256').update(seed).digest('hex'),newId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`,status=match?'matched':candidates.length>1?'ambiguous':testMatch?'new':'unmatched';return {row:headerIndex+index+2,lot,systemTool:text(row[2]),tool:parsed.tool,sequence:parsed.sequence,correctionNumber:number(row[3]),stopCode:number(row[4]),description:text(row[5]),correction,corrector:text(row[7]),correctionDate:text(row[8]),payload:{Lote:lot,Data:row[1],Ferramenta:text(row[2]),'Nr.Correção':number(row[3]),'Cod.Parada':number(row[4]),Descrição:text(row[5]),'Correção Efetuada':correction,Corretor:text(row[7]),'Data Correção':text(row[8]),'Qt.Bruta':row[9],'Qt.Liq':row[10],'Qt.Tarugo':row[11],Produt:row[12],'Efic(%)':row[13],'Tar.Ideal':row[14],'Temp.Ferr.':row[15],'Temp.Tarugo.':row[16],'Hrs.Forno':row[17],Inspetor:text(row[18]),'Obs do Lote':text(row[19])},matchId:match?.id||(status==='new'?newId:null),matchedBy:match?matchedBy:status==='new'?'ferramenta e sequência':null,status};});
 return {rows:results,summary:{total:results.length,matched:results.filter(r=>r.status==='matched').length,new:results.filter(r=>r.status==='new').length,unmatched:results.filter(r=>r.status==='unmatched').length,ambiguous:results.filter(r=>r.status==='ambiguous').length}};
}
module.exports={parseCorrections};

