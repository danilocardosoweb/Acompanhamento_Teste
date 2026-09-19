const XLSX=require('xlsx');
const fs=require('fs');const path=require('path');
function safeName(value){return String(value||'NAO_IDENTIFICADO').replace(/[^A-Z0-9._-]+/gi,'_').slice(0,100)||'NAO_IDENTIFICADO';}
function uniquePath(folder,name){let file=path.join(folder,`${name}.xlsx`),n=1;while(fs.existsSync(file)){n++;file=path.join(folder,`${name}_${n}.xlsx`);}return file;}
function buildWorkbook(analysis){
 const round=value=>Number.isFinite(Number(value))?Number(Number(value).toFixed(6)):'';
 const rows=(analysis.dimensions||[]).map(item=>{const n=Number(item.nominal),p=item.tolerancePlus==null||item.tolerancePlus===''?null:Number(item.tolerancePlus),m=item.toleranceMinus==null||item.toleranceMinus===''?null:Number(item.toleranceMinus);return {Ferramenta:analysis.tool,'Arquivo Origem':analysis.fileName,Página:item.page,'Texto Original':item.rawText,'Valor Nominal':round(n),'Tolerância +':p===null?'':round(p),'Tolerância -':m===null?'':round(m),'Valor menor':m===null?'':round(n-m),'Valor maior':p===null?'':round(n+p),'Posição X':item.x,'Posição Y':item.y,Confiança:`${Math.round(Number(item.confidence||0)*100)}%`,'Método de Leitura':item.source,Status:item.status}});
 const info=[{Ferramenta:analysis.tool,Arquivo:analysis.fileName,'Data de processamento':analysis.processedAt,'Quantidade de cotas':rows.length,'Método utilizado':analysis.method,'Quantidade de itens para revisão':rows.filter(row=>row.Status==='REVISAR').length}];
 const workbook=XLSX.utils.book_new();const sheet=XLSX.utils.json_to_sheet(rows.length?rows:[{Ferramenta:analysis.tool,'Arquivo Origem':analysis.fileName,Status:'Nenhuma cota identificada'}]);const infoSheet=XLSX.utils.json_to_sheet(info);
 sheet['!cols']=[{wch:18},{wch:32},{wch:9},{wch:18},{wch:16},{wch:14},{wch:14},{wch:12},{wch:12},{wch:12},{wch:18},{wch:14}];infoSheet['!cols']=[{wch:22},{wch:34},{wch:25},{wch:20},{wch:18},{wch:25}];XLSX.utils.book_append_sheet(workbook,sheet,'Cotas');XLSX.utils.book_append_sheet(workbook,infoSheet,'Informações');return workbook;
}
function exportWorkbook(analysis,folder){fs.mkdirSync(folder,{recursive:true});const filePath=uniquePath(folder,safeName(analysis.tool==='NAO_IDENTIFICADO'?`NAO_IDENTIFICADO_${path.parse(analysis.fileName).name}`:analysis.tool));const bytes=XLSX.write(buildWorkbook(analysis),{type:'buffer',bookType:'xlsx'});fs.writeFileSync(filePath,bytes);return {filePath,fileName:path.basename(filePath),bytes};}
module.exports={buildWorkbook,exportWorkbook};
