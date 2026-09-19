const fs=require('fs');
const path=require('path');
const os=require('os');
const {createWorker}=require('tesseract.js');

// These are measured pixel features, not substitutions of an OCR '+' for '±'.
function glyphs(ctx,b){
 const width=ctx.canvas.width,pixels=ctx.getImageData(0,0,width,ctx.canvas.height).data;
 const ink=(x,y)=>pixels[(y*width+x)*4]<128,spans=[];let start=-1;
 for(let x=b.x0;x<=b.x1;x++){
  let occupied=x<b.x1&&Array.from({length:b.y1-b.y0},(_,i)=>b.y0+i).some(y=>ink(x,y));
  if(occupied){if(start<0)start=x;}else if(start>=0){
   const rows=[];for(let y=b.y0;y<b.y1;y++){let count=0;for(let k=start;k<x;k++)if(ink(k,y))count++;rows.push(count);}
   const bands=[];let s=-1;for(let y=0;y<=rows.length;y++){if(rows[y]){if(s<0)s=y;}else if(s>=0){bands.push([s,y]);s=-1;}}
   const w=x-start;
   const pm=w>=8&&bands.length===2&&bands[0][1]-bands[0][0]>bands[1][1]-bands[1][0]+3&&Math.max(...rows.slice(...bands[0]))>=w*.8&&Math.max(...rows.slice(...bands[1]))>=w*.8;
   spans.push({x0:start,x1:x,pm});start=-1;
  }
 }
 return spans;
}
function crop(factory,canvas,b){const c=factory.create(b.x1-b.x0+24,b.y1-b.y0+24);c.context.fillStyle='white';c.context.fillRect(0,0,c.canvas.width,c.canvas.height);c.context.drawImage(canvas,b.x0,b.y0,b.x1-b.x0,b.y1-b.y0,12,12,b.x1-b.x0,b.y1-b.y0);return c;}
function correctThreeFive(text,ctx,box){
 if(!/^3(?:[,.]\d+)?$/.test(text))return text;
 const spans=glyphs(ctx,box),g=spans[0];if(!g)return text;
 const pixels=ctx.getImageData(0,0,ctx.canvas.width,ctx.canvas.height).data,w=ctx.canvas.width,points=[];
 for(let y=box.y0;y<box.y1;y++)for(let x=g.x0;x<g.x1;x++)if(pixels[(y*w+x)*4]<128)points.push([x,y]);
 if(!points.length)return text;
 const y0=Math.min(...points.map(p=>p[1])),y1=Math.max(...points.map(p=>p[1]));
 const upperLeft=points.some(([x,y])=>x<g.x0+(g.x1-g.x0)*.3&&y>y0+(y1-y0)*.15&&y<y0+(y1-y0)*.35);
 return upperLeft?text.replace(/^3/,'5'):text;
}
function maskBlue(context){
 const im=context.getImageData(0,0,context.canvas.width,context.canvas.height),{width:w,height:h}=im,m=new Uint8Array(w*h);let count=0;
 for(let i=0;i<m.length;i++){const o=i*4;if(im.data[o+2]>im.data[o]+40&&im.data[o+2]>im.data[o+1]+30){m[i]=1;count++;}}
 if(count<100)return false;
 const clean=m.slice();
 for(let y=0;y<h;y++){let start=-1;for(let x=0;x<=w;x++){if(x<w&&m[y*w+x]){if(start<0)start=x;}else if(start>=0){if(x-start>60)for(let k=start;k<x;k++)clean[y*w+k]=0;start=-1;}}}
 for(let x=0;x<w;x++){let start=-1;for(let y=0;y<=h;y++){if(y<h&&m[y*w+x]){if(start<0)start=y;}else if(start>=0){if(y-start>60)for(let k=start;k<y;k++)clean[k*w+x]=0;start=-1;}}}
 const visited=new Uint8Array(clean.length);
 for(let i=0;i<clean.length;i++){if(!clean[i]||visited[i])continue;const queue=[i];visited[i]=1;let left=w,right=0,top=h,bottom=0;
  for(let k=0;k<queue.length;k++){const n=queue[k],x=n%w,y=Math.floor(n/w);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);for(const q of [n-1,n+1,n-w,n+w])if(q>=0&&q<clean.length&&!visited[q]&&clean[q]){visited[q]=1;queue.push(q);}}
  const cw=right-left+1,ch=bottom-top+1;if((ch>45&&cw<ch*.4)||(cw>45&&ch<cw*.4))for(const n of queue)clean[n]=0;
 }
 for(let i=0;i<m.length;i++){const o=i*4;im.data[o]=im.data[o+1]=im.data[o+2]=clean[i]?0:255;im.data[o+3]=255;}context.putImageData(im,0,0);return true;
}
async function extractVisualDimensions(buffer){
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=pdfjs.getDocument({data:new Uint8Array(buffer)}),doc=await task.promise;
 const cache=process.env.VERCEL?path.join(os.tmpdir(),'draw2data-cache'):path.join(__dirname,'..','.draw2data-cache');fs.mkdirSync(cache,{recursive:true});
 let worker,legacy;const dimensions=[];
 try{
  if(doc.numPages>10)throw Error('Separe o desenho em arquivos de até 10 páginas para leitura visual.');
  worker=await createWorker('eng',1,{cachePath:cache});
  legacy=await createWorker('eng',0,{legacyCore:true,legacyLang:true,cachePath:path.join(cache,'legacy'),langPath:'https://raw.githubusercontent.com/tesseract-ocr/tessdata/main',gzip:false});
  await legacy.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789.,'});
  for(let pageNo=1;pageNo<=doc.numPages;pageNo++){
   const page=await doc.getPage(pageNo),scale=5,v=page.getViewport({scale});
   if(v.width*v.height>32000000)throw Error('Página grande demais para OCR. Separe ou reduza o desenho.');
   const surface=doc.canvasFactory.create(v.width,v.height);
   await page.render({canvasContext:surface.context,viewport:v}).promise;const colored=maskBlue(surface.context),candidates=[];
   for(const angle of [0,90]){
    const w=surface.canvas.width,h=surface.canvas.height,rot=doc.canvasFactory.create(angle?h:w,angle?w:h);
    if(angle){rot.context.translate(h,0);rot.context.rotate(Math.PI/2);}rot.context.drawImage(surface.canvas,0,0);
    await worker.setParameters({tessedit_pageseg_mode:'11',tessedit_char_whitelist:''});
    const {data}=await worker.recognize(rot.canvas.toBuffer('image/png'),{}, {blocks:true});
    const lines=(data.blocks||[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines));
    for(const line of lines){
     if(!/\d/.test(line.text))continue;
     const b=line.bbox,spans=glyphs(rot.context,b),pm=spans.find(g=>g.pm);
     if(!pm&&!/^\s*\d+[,.]\d+\s*$/.test(line.text))continue;
     const regions=pm?[{...b,x1:pm.x0},{...b,x0:pm.x1}]:[b];
     const values=[];
     await worker.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789.,'});
     for(const box of regions){if(box.x1<=box.x0)break;const c=crop(doc.canvasFactory,rot.canvas,box);const r=await worker.recognize(c.canvas.toBuffer('image/png'));const alt=await legacy.recognize(c.canvas.toBuffer('image/png'));doc.canvasFactory.destroy(c);let text=r.data.text.trim();const alternative=alt.data.text.trim();
      // CAD stroke fonts often confuse 3 and 5. Only use the alternative if
      // its top-left stem is present in the actual glyph pixels.
      if(text.replace(/3/g,'5')===alternative&&text!==alternative){text=correctThreeFive(text,rot.context,box);}
      if(!pm&&/^3(?:[,.]\d+)?$/.test(text))text=correctThreeFive(text,rot.context,box);
      const valid=/^\d+(?:[,.]\d+)?$/.test(text),alternateValid=/^\d+(?:[,.]\d+)?$/.test(alternative);
      const supportedByLine=line.text.replace(/,/g,'.').includes(text.replace(',','.'));
      const alternateSupported=line.text.replace(/,/g,'.').includes(alternative.replace(',','.'));
      // OCR frequently adds a trailing digit to a tolerance when the arrow
      // touches the glyph. Prefer the complete value that is actually present
      // in the source line, and keep the item marked for visual review.
      const chosen=valid&&alternateValid&&((alternateSupported&&!supportedByLine)||(!supportedByLine&&alternative.length<text.length))?alternative:text;
      const uncertain=valid&&alternateValid&&text.replace(',','.')!==alternative.replace(',','.')&&!supportedByLine;
      const parsed=/^\d+(?:[,.]\d+)?$/.test(chosen)?Number(chosen.replace(',','.')):null;
      const normalized=uncertain&&parsed!==null&&String(chosen).replace(',','.').split('.')[1]?.length>2?Number(parsed.toFixed(2)):parsed;
      values.push({text:normalized===null?chosen:String(normalized).replace('.',','),value:normalized,uncertain});}
     if(values.length!==regions.length||values.some(x=>x.value===null))continue;
     const original=angle?{x0:b.y0,y0:h-b.x1,x1:b.y1,y1:h-b.x0}:b;
     const uncertainTolerance=pm&&values[1].uncertain;
     const canonical=values.map(x=>x.text).join(' ± ');
     candidates.push({rawText:canonical,nominal:values[0].value,tolerancePlus:pm?values[1].value:null,toleranceMinus:pm?values[1].value:null,recognizedText:canonical,reviewReason:uncertainTolerance?'Leituras divergentes na tolerância. Confira no desenho.':'Leitura visual: confira os valores no desenho.',page:pageNo,x:original.x0/scale,y:(h-original.y1)/scale,width:(original.x1-original.x0)/scale,height:(original.y1-original.y0)/scale,rotation:angle,confidence:Math.min(.85,Math.max(0,line.confidence/100)),source:'OCR',status:'REVISAR',hasSymbol:Boolean(pm)});
    }
    doc.canvasFactory.destroy(rot);
   }
   // Plain numbers are candidates only in the same drawing area as explicit dimensions.
   const anchors=candidates.filter(c=>c.hasSymbol);
   for(const c of candidates){const nearby=anchors.some(a=>Math.hypot(a.x-c.x,a.y-c.y)<100);if(c.hasSymbol||(colored&&nearby)){delete c.hasSymbol;c.id=`ocr-${pageNo}-${dimensions.length+1}`;dimensions.push(c);}}
   doc.canvasFactory.destroy(surface);
  }
 }finally{await worker?.terminate();await legacy?.terminate();await doc.destroy();}
 return dimensions;
}
module.exports={extractVisualDimensions};
