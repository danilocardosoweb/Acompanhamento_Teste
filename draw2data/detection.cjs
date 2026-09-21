const TOOL_REGEX=/\b(?:[A-Z]{2,4}|\d{2})-\d{3,6}[A-Z]?\b/i;
const SYMMETRIC=/([Ø⌀Rr]?\s*-?\d+(?:[,.]\d+)?)\s*(?:mm)?\s*(?:±|\+\s*\/\s*-?)\s*(\d+(?:[,.]\d+)?)(?:\s*mm)?/gi;
const ASYMMETRIC=/([Ø⌀Rr]?\s*-?\d+(?:[,.]\d+)?)\s*(?:mm)?\s*\+\s*(\d+(?:[,.]\d+)?)\s*\/\s*-\s*(\d+(?:[,.]\d+)?)(?:\s*mm)?/gi;
const UNIT_VALUE=/([Ø⌀Rr]?\s*-?\d+(?:[,.]\d+)?)\s*mm\b/gi;
const RADIUS_VALUE=/\bR\s*(\d+(?:[,.]\d+)?)(?![\w])/gi;
const number=value=>Number(String(value).replace(',','.'));
function buildLines(page){
 const sorted=[...page.items].sort((a,b)=>b.y-a.y||a.x-b.x),lines=[];
 for(const item of sorted){const tolerance=Math.max(2.5,Math.min(6,Number(item.height||0)*.55));let line=lines.find(candidate=>Math.abs(candidate.y-item.y)<=tolerance&&Math.abs((candidate.rotation||0)-(item.rotation||0))<5);if(!line){line={y:item.y,rotation:item.rotation||0,items:[]};lines.push(line)}line.items.push(item)}
 return lines.sort((a,b)=>b.y-a.y).map(line=>({text:line.items.sort((a,b)=>a.x-b.x).map(item=>item.text).join(' ').replace(/\s+/g,' ').trim(),items:line.items})).filter(line=>line.text);
}
function identifyTool(fileName,text){
 const fromName=String(fileName||'').match(TOOL_REGEX),fromText=String(text||'').match(TOOL_REGEX);
 return {tool:(fromName?.[0]||fromText?.[0]||'').toUpperCase(),source:fromName?'FILENAME':fromText?'PDF_TEXT':'UNIDENTIFIED'};
}
function locate(page,raw){
 const text=page.items.map(i=>i.text).join(' '),start=text.indexOf(raw);let offset=0;
 const items=page.items.filter(i=>{const begin=offset;offset+=i.text.length+1;return start>=0&&begin<start+raw.length&&offset-1>start;});
 if(!items.length)return {x:0,y:0,width:0,height:0};
 const x=Math.min(...items.map(i=>i.x)),y=Math.min(...items.map(i=>i.y));
 return {x,y,width:Math.max(...items.map(i=>i.x+i.width))-x,height:Math.max(...items.map(i=>i.y+i.height))-y};
}
function detectDimensions(pages){
 const dimensions=[];
 for(const page of pages){
  const lines=buildLines(page);
  const matches=[];
  for(const line of lines){
   SYMMETRIC.lastIndex=0;ASYMMETRIC.lastIndex=0;
   const symmetricMatches=[...line.text.matchAll(SYMMETRIC)],asymmetricMatches=[...line.text.matchAll(ASYMMETRIC)];
   for(const match of symmetricMatches)matches.push({line,rawText:match[0].trim(),nominal:number(String(match[1]).replace(/[Ø⌀Rr]/g,'')),tolerancePlus:number(match[2]),toleranceMinus:number(match[2]),source:'PDF_TEXT',confidence:.99});
   for(const match of asymmetricMatches)matches.push({line,rawText:match[0].trim(),nominal:number(String(match[1]).replace(/[Ø⌀Rr]/g,'')),tolerancePlus:number(match[2]),toleranceMinus:number(match[3]),source:'PDF_TEXT',confidence:.97});
   RADIUS_VALUE.lastIndex=0;
   for(const match of line.text.matchAll(RADIUS_VALUE)){
    const nominal=number(match[1]);
    if(Number.isFinite(nominal)&&nominal>0&&nominal<=100)matches.push({line,rawText:`R${String(match[1]).replace('.',',')}`,locationText:match[0],nominal,tolerancePlus:null,toleranceMinus:null,symbol:'R',source:'PDF_TEXT_RADIUS',confidence:.86,status:'REVISAR',reviewReason:'Raio identificado pelo símbolo R. Confira o valor e a posição no desenho.'});
   }
   if(!symmetricMatches.length&&!asymmetricMatches.length){
    const units=[...line.text.matchAll(UNIT_VALUE)];
    if(units.length>=2){
     const nominal=number(String(units[0][1]).replace(/[Ø⌀Rr]/g,'')),tolerance=number(String(units[1][1]).replace(/[Ø⌀Rr]/g,''));
     if(Number.isFinite(nominal)&&Number.isFinite(tolerance)&&nominal>tolerance)matches.push({line,rawText:`${units[0][0].trim()} ${units[1][0].trim()}`,nominal,tolerancePlus:null,toleranceMinus:null,source:'PDF_TEXT_TABLE',confidence:.78,status:'REVISAR'});
    }else if(units.length===1&&(/\bREF\b/i.test(line.text)||/[Ø⌀Rr]/.test(units[0][0]))){
     const nominal=number(String(units[0][1]).replace(/[Ø⌀Rr]/g,''));
     if(Number.isFinite(nominal))matches.push({line,rawText:units[0][0].trim(),nominal,tolerancePlus:null,toleranceMinus:null,source:'PDF_TEXT',confidence:.82,status:'REVISAR'});
    }
   }
   SYMMETRIC.lastIndex=0;ASYMMETRIC.lastIndex=0;UNIT_VALUE.lastIndex=0;RADIUS_VALUE.lastIndex=0;
  }
  const seen=new Set();
  for(const item of matches){
   const signature=`${page.page}|${item.rawText}|${item.line?.text||''}`;if(seen.has(signature))continue;seen.add(signature);
   const point=locate(item.line?{items:item.line.items}:page,item.locationText||item.rawText),administrative=point.x>page.width*.72&&point.y<page.height*.22,symbol=item.symbol||(/[Ø⌀Rr]/.test(item.rawText)?item.rawText.trim()[0]:'');
   const confidence=administrative?.55:(symbol?Math.min(item.confidence,.96):item.confidence),status=administrative?'REVISAR':(item.status||'CONFIRMADO');
   dimensions.push({id:`p${page.page}-${dimensions.length+1}`,rawText:item.rawText,nominal:item.nominal,tolerancePlus:item.tolerancePlus,toleranceMinus:item.toleranceMinus,symbol,reference:/\bREF\b/i.test(item.line?.text||''),page:page.page,...point,confidence,source:item.source,status,reviewReason:item.reviewReason});
  }
 }
 return dimensions;
}
function analyze({fileName,pdf}){
 const tool=identifyTool(fileName,pdf.text),dimensions=detectDimensions(pdf.pages);
 const warnings=[];if(!pdf.textAvailable)warnings.push('O PDF não possui texto pesquisável. OCR ficará disponível em uma fase futura.');else if(!dimensions.length)warnings.push(`O PDF possui texto (${pdf.pages.reduce((sum,page)=>sum+page.items.length,0)} blocos), mas nenhuma cota reconhecível. O desenho pode usar fontes vetoriais, tolerâncias empilhadas ou conteúdo convertido em curvas.`);
 return {tool:tool.tool||'NAO_IDENTIFICADO',toolSource:tool.source,fileName,pageCount:pdf.pageCount,textAvailable:pdf.textAvailable,method:pdf.textAvailable?'PDF_TEXT':'SEM_TEXTO',dimensions,processedAt:new Date().toISOString(),diagnostics:{textBlocks:pdf.pages.reduce((sum,page)=>sum+page.items.length,0),textCharacters:pdf.text.length},warnings};
}
module.exports={analyze,identifyTool,detectDimensions};
