const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const credentials=JSON.parse(fs.readFileSync(path.join(root,'.cloud-credentials.json'),'utf8'));
const databasePath=path.join(root,'dados','controle-dimensional.json');
const database=JSON.parse(fs.readFileSync(databasePath,'utf8'));

async function call(action,{method='GET',body,object,type='application/json'}={}){
 const url=new URL(credentials.endpoint);url.searchParams.set('action',action);if(object)url.searchParams.set('path',object);
 const response=await fetch(url,{method,headers:{'x-collector-token':credentials.token,'Content-Type':type},body});
 if(!response.ok)throw Error(`${action}: ${response.status} ${await response.text()}`);
 return response;
}

(async()=>{
 const existing=await(await call('control-profiles')).json(),keys=new Set(existing.map(profile=>`${profile.tool}|${profile.sequence??''}|${profile.revision}`));
 let migrated=0,skipped=0;
 for(const profile of database.profiles||[]){
  const key=`${String(profile.tool||'').toUpperCase()}|${profile.sequence??''}|${profile.revision||'00'}`;
  if(keys.has(key)){skipped++;continue;}
  let drawingPath=null;
  if(profile.drawingPath){
   const drawing=path.resolve(root,profile.drawingPath),folder=path.join(root,'dados','controle-desenhos')+path.sep;
   if(drawing.startsWith(folder)&&fs.existsSync(drawing)){
    drawingPath=`control-drawings/${profile.id}.pdf`;
    await call('file',{method:'PUT',object:drawingPath,type:'application/pdf',body:fs.readFileSync(drawing)});
   }
  }
  await call('control-profiles',{method:'POST',body:JSON.stringify({id:profile.id,tool:profile.tool,sequence:profile.sequence,revision:profile.revision,name:profile.name,dimensions:profile.dimensions,drawingPath})});
  keys.add(key);migrated++;
 }
 console.log(JSON.stringify({migrated,skipped}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
