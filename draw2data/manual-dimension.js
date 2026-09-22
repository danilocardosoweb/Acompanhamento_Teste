(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.Draw2DataManual=api})(typeof window==='undefined'?null:window,function(){
 function parseManualDimensionText(input){
  const rawText=String(input??'').trim().replace(/[−–]/g,'-').replace(/\s+/g,' ');
  if(!rawText)return null;
  const numeric='(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)';
  const tolerance=new RegExp(`^\\s*(${numeric})\\s*(?:±|\\+/-)\\s*(${numeric})\\s*$`).exec(rawText);
  const asymmetric=new RegExp(`^\\s*(${numeric})\\s*\\+\\s*(${numeric})\\s*[/;]\\s*-\\s*(${numeric})\\s*$`).exec(rawText);
  const token=new RegExp(`^\\s*([RrØø⌀Φφ])?\\s*(${numeric})\\s*(°)?\\s*$`).exec(rawText);
  const number=value=>Number(String(value).replace(',','.'));
  let nominal, tolerancePlus='', toleranceMinus='', symbol='', dimensionType='LINEAR';
  if(tolerance){nominal=number(tolerance[1]);tolerancePlus=number(tolerance[2]);toleranceMinus=number(tolerance[2]);dimensionType='TOLERANCED_LINEAR'}
  else if(asymmetric){nominal=number(asymmetric[1]);tolerancePlus=number(asymmetric[2]);toleranceMinus=number(asymmetric[3]);dimensionType='TOLERANCED_LINEAR'}
  else if(token){symbol=(token[1]||'').toUpperCase();nominal=number(token[2]);if(symbol==='R')dimensionType='RADIUS';else if(symbol)dimensionType='DIAMETER';else if(token[3])dimensionType='ANGLE'}
  else return null;
  if(!Number.isFinite(nominal)||nominal<0||![tolerancePlus,toleranceMinus].every(v=>v===''||Number.isFinite(v)))return null;
  return {rawText,nominal,tolerancePlus,toleranceMinus,symbol,dimensionType};
 }
 return {parseManualDimensionText};
});
