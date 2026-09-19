const {loadPdfJs}=require('./pdfjs.cjs');
async function extractPdf(buffer,options={}){
 if(!Buffer.isBuffer(buffer)||buffer.subarray(0,5).toString()!=='%PDF-')throw Error('Selecione um arquivo PDF válido.');
 const pdfjs=await loadPdfJs(),document=await pdfjs.getDocument({data:new Uint8Array(buffer),disableWorker:true,useSystemFonts:true}).promise;
 const pages=[],maxPages=Math.min(document.numPages,Math.max(1,Math.min(10,Number(options.maxPages)||10)));let fullText='';
 try{
  for(let pageNumber=1;pageNumber<=maxPages;pageNumber++){
   const page=await document.getPage(pageNumber),content=await page.getTextContent(),viewport=page.getViewport({scale:1});
   const items=content.items.filter(item=>String(item.str||'').trim()).map(item=>{const matrix=item.transform||[];return {text:String(item.str),x:Number(matrix[4]||0),y:Number(matrix[5]||0),width:Number(item.width||0),height:Number(item.height||0),rotation:Number((Math.atan2(Number(matrix[1]||0),Number(matrix[0]||1))*180/Math.PI).toFixed(2))}});
   const text=items.map(item=>item.text).join(' ').replace(/\s+/g,' ').trim();
   pages.push({page:pageNumber,width:viewport.width,height:viewport.height,text,items});fullText+=(fullText?'\n':'')+text;
  }
 }finally{document.cleanup?.();}
 return {pages,text:fullText.trim(),pageCount:pages.length,sourcePageCount:document.numPages,truncated:document.numPages>pages.length,textAvailable:Boolean(fullText.trim())};
}
module.exports={extractPdf};
