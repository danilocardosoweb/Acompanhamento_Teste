const {loadPdfJs}=require('./pdfjs.cjs');
async function extractPdf(buffer,options={}){
 if(!Buffer.isBuffer(buffer)||buffer.subarray(0,5).toString()!=='%PDF-')throw Error('Selecione um arquivo PDF válido.');
 const pdfjs=await loadPdfJs(),document=await pdfjs.getDocument({data:new Uint8Array(buffer),disableWorker:true,useSystemFonts:true}).promise;
 const pages=[],maxPages=Math.min(document.numPages,Math.max(1,Math.min(10,Number(options.maxPages)||10)));let fullText='';
 try{
  for(let pageNumber=1;pageNumber<=maxPages;pageNumber++){
   const page=await document.getPage(pageNumber),content=await page.getTextContent(),viewport=page.getViewport({scale:1});
   const items=content.items.filter(item=>String(item.str||'').trim()).map(item=>{
    const matrix=item.transform||[],originX=Number(matrix[4]||0),originY=Number(matrix[5]||0);
    const axisX=Number(matrix[0]||1),axisY=Number(matrix[1]||0),axisLength=Math.hypot(axisX,axisY)||1;
    const width=Number(item.width||0),height=Number(item.height||Math.hypot(Number(matrix[2]||0),Number(matrix[3]||0))||0);
    const normalX=Number(matrix[2]||0),normalY=Number(matrix[3]||1),normalLength=Math.hypot(normalX,normalY)||1;
    const corners=[[originX,originY],[originX+axisX/axisLength*width,originY+axisY/axisLength*width],
     [originX+normalX/normalLength*height,originY+normalY/normalLength*height],
     [originX+axisX/axisLength*width+normalX/normalLength*height,originY+axisY/axisLength*width+normalY/normalLength*height]]
     .map(([x,y])=>viewport.convertToViewportPoint(x,y)).map(([x,y])=>({x,y:viewport.height-y}));
    const xs=corners.map(point=>point.x),ys=corners.map(point=>point.y),baselineStart=corners[0],baselineEnd=corners[1];
    return {text:String(item.str),x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys),rotation:Number((Math.atan2(baselineEnd.y-baselineStart.y,baselineEnd.x-baselineStart.x)*180/Math.PI).toFixed(2))};
   });
   const text=items.map(item=>item.text).join(' ').replace(/\s+/g,' ').trim();
   pages.push({page:pageNumber,width:viewport.width,height:viewport.height,text,items});fullText+=(fullText?'\n':'')+text;
  }
 }finally{document.cleanup?.();}
 return {pages,text:fullText.trim(),pageCount:pages.length,sourcePageCount:document.numPages,truncated:document.numPages>pages.length,textAvailable:Boolean(fullText.trim())};
}
module.exports={extractPdf};
