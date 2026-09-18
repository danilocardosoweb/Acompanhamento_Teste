const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {spawn}=require('child_process');
module.exports=function(root){
 const credentialPath=path.join(root,'.cloud-credentials.json');
 const statusPath=path.join(root,'dados/cloud-status.json');
 const cachePath=path.join(root,'dados/cloud-cache.json');
 const uploadPath=path.join(root,'dados/cloud-uploads.json');
 let running=null,readPromise=null,productionReadPromise=null,lastRead=0;
 let state={enabled:fs.existsSync(credentialPath),syncing:false,error:'',lastSync:null};
 try{state={...state,...JSON.parse(fs.readFileSync(statusPath,'utf8')),syncing:false};}catch{}
 const saveState=()=>{fs.mkdirSync(path.dirname(statusPath),{recursive:true});fs.writeFileSync(statusPath,JSON.stringify(state));};
 function config(){const c=JSON.parse(fs.readFileSync(credentialPath,'utf8'));if(c.endpoint!=='https://sldhpwtdipndnljbzojm.supabase.co/functions/v1/quality-collector')throw Error('Configuração do serviço de dados inválida.');return c;}
 async function request(action,{method='GET',body,type='application/json',object,query}={}){
  const c=config(),url=new URL(c.endpoint);url.searchParams.set('action',action);if(object)url.searchParams.set('path',object);for(const [key,value] of Object.entries(query||{}))if(value!==undefined&&value!==null)url.searchParams.set(key,String(value));
  const res=await fetch(url,{method,headers:{'x-collector-token':c.token,'Content-Type':type},body,signal:AbortSignal.timeout(60000)});
  if(!res.ok){let message=await res.text();throw Error(`Serviço de dados (${res.status}): ${message.slice(0,400)}`);}return res;
 }
 const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
 const localFepRecords=()=>{try{const local=JSON.parse(fs.readFileSync(path.join(root,'dados/testes.json'),'utf8'));return Array.isArray(local.fepRecords)?local.fepRecords:[];}catch{return [];}};
 const mergeFep=(remote)=>{const local=localFepRecords();return {...remote,fepRecords:Array.isArray(remote?.fepRecords)&&remote.fepRecords.length?remote.fepRecords:local};};
 async function buildPreview(file,key){
  const folder=path.join(root,'previews',key),manifest=path.join(folder,'manifest.json');
  if(fs.existsSync(manifest))return {folder,manifest};
  await new Promise((resolve,reject)=>{
   const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'visualizar.ps1'),'-Source',file,'-Destination',folder],{windowsHide:true});
   let error='';const timer=setTimeout(()=>{child.kill();reject(Error('A preparação da pré-visualização demorou mais que o esperado.'));},120000);
   child.stderr.on('data',chunk=>error+=chunk);child.on('error',reason=>{clearTimeout(timer);reject(reason);});child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error(error||'Não foi possível preparar a pré-visualização da planilha.'));if(!fs.existsSync(manifest))return reject(Error('A pré-visualização não gerou o índice de páginas.'));resolve();});
  });
  return {folder,manifest};
 }
 async function perform(){
  if(!fs.existsSync(credentialPath))return;
  state={...state,enabled:true,syncing:true,error:''};saveState();
  try{
   await request('setup',{method:'POST'});
   const data=JSON.parse(fs.readFileSync(path.join(root,'dados/testes.json'),'utf8'));
   let uploaded={};try{uploaded=JSON.parse(fs.readFileSync(uploadPath,'utf8'));}catch{}
   async function upload(object,file){const bytes=fs.readFileSync(file),sha=digest(bytes);if(uploaded[object]===sha)return;const ext=path.extname(file).toLowerCase();const type={'.pdf':'application/pdf','.png':'image/png','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.csv':'text/csv'}[ext]||'application/octet-stream';await request('file',{method:'PUT',body:bytes,type,object});uploaded[object]=sha;fs.writeFileSync(uploadPath,JSON.stringify(uploaded));}
   let count=0;
   for(const record of data.records){for(const a of record.attachments){
    const file=path.resolve(root,a.path);if(!file.startsWith(path.join(root,'anexos')+path.sep))throw Error('Caminho de anexo inválido.');
    const bytes=fs.readFileSync(file),ext=path.extname(file).toLowerCase();a.sha256=digest(bytes);a.size=bytes.length;a.cloudPath=`originals/${a.sha256}${ext}`;
    await upload(a.cloudPath,file);count++;
    if(ext!=='.pdf'){
     const key=crypto.createHash('sha256').update('preview-v1').update(bytes).digest('hex');
     const {folder,manifest}=await buildPreview(file,key);
     if(fs.existsSync(manifest)){
      a.preview={...JSON.parse(fs.readFileSync(manifest,'utf8')),key};
      for(const sheet of a.preview.sheets)for(const name of [sheet.file,...sheet.pages]){
       if(!/^sheet-\d+(?:-\d+)?\.(png|pdf)$/.test(name))throw Error('Arquivo de visualização inválido.');
       await upload(`previews/${key}/${name}`,path.join(folder,name));
      }
     }
    }
   }}
   const result=await(await request('sync',{method:'POST',body:JSON.stringify(data)})).json();
   // Read back the stored database records; never mark an upload as confirmed from local data alone.
   const confirmed=await(await request('data')).json();
   if(confirmed.records.length<data.records.length)throw Error('A conferência dos registros enviados falhou.');
   fs.writeFileSync(cachePath,JSON.stringify(mergeFep(confirmed)));lastRead=Date.now();
   state={enabled:true,syncing:false,error:'',lastSync:new Date().toISOString(),records:result.records,attachments:count};saveState();
   return state;
  }catch(e){state={...state,syncing:false,error:e.message};saveState();throw e;}
 }
 function sync(){if(!running){running=perform().finally(()=>{running=null;});}return running;}
 function cached(){return mergeFep(JSON.parse(fs.readFileSync(cachePath,'utf8')));}
 async function read(includeProduction=false){
  if(!state.enabled)throw Error('Serviço de dados não configurado.');
  if(!includeProduction&&Date.now()-lastRead<60000&&fs.existsSync(cachePath))return {...cached(),dataOrigin:'supabase'};
  const load=async()=>{const data=mergeFep(await(await request('data',{query:includeProduction?{includeProduction:1}:undefined})).json());if(!data.updatedAt)throw Error('Primeira sincronização pendente.');if(!includeProduction){fs.writeFileSync(cachePath,JSON.stringify(data));lastRead=Date.now();}return {...data,dataOrigin:'supabase'};};
  if(includeProduction){if(!productionReadPromise)productionReadPromise=load().finally(()=>{productionReadPromise=null;});return productionReadPromise;}
  if(!readPromise)readPromise=load().finally(()=>{readPromise=null;});return readPromise;
 }
 async function download(object){const res=await request('file',{object});return {bytes:Buffer.from(await res.arrayBuffer()),type:res.headers.get('content-type')};}
 async function login(email,password){return (await(await request('login',{method:'POST',body:JSON.stringify({email,password})})).json()).user;}
 async function saveCorrection({id,text,user,file}){
  let meta=null;
  if(file){const ext=path.extname(file.name).toLowerCase(),safe=`${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`,object=`corrections/${id}/${safe}`;await request('file',{method:'PUT',body:file.bytes,type:file.mimeType,object});meta={name:file.name,objectPath:object,size:file.bytes.length,mimeType:file.mimeType};}
  await request('correction',{method:'POST',body:JSON.stringify({id,text,userId:user.id,userName:user.name||user.email,file:meta})});lastRead=0;
 }
 async function saveToolDrawing({id,tool,sequence,name,bytes,user}){const object=`drawings/${id}/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.pdf`;await request('file',{method:'PUT',body:bytes,type:'application/pdf',object});const result=await(await request('tool-drawing',{method:'POST',body:JSON.stringify({id,tool,sequence,name,objectPath:object,size:bytes.length,userId:user.id})})).json();lastRead=0;return {...result,objectPath:object};}
 async function saveLocation({location,correctionId,user}){await request('location',{method:'POST',body:JSON.stringify({...location,correctionId,userId:user.id,userName:user.name||user.email})});lastRead=0;}
 async function importCorrections(rows,user){await request('import-corrections',{method:'POST',body:JSON.stringify({rows,userId:user.id,userName:user.name||user.email})});lastRead=0;}
 async function importProduction(rows,user){await request('import-production',{method:'POST',body:JSON.stringify({rows,userId:user.id,userName:user.name||user.email})});lastRead=0;}
 async function whatsappSettings(){return await(await request('whatsapp-settings')).json();}
 async function saveWhatsappSettings(body){return await(await request('whatsapp-settings',{method:'POST',body:JSON.stringify(body)})).json();}
 async function whatsappNotifications(){return await(await request('whatsapp-notifications')).json();}
 async function retryWhatsapp(id){return await(await request('whatsapp-retry',{method:'POST',body:JSON.stringify({id})})).json();}
 function findFile(id,index){const r=cached().records.find(r=>r.id===id);return r?.attachments[index];}
 function findCorrectionFile(id,index){const cache=cached(),c=(cache.productionNotes||cache.corrections||[]).find(c=>c.id===id);return c?.files[index];}
 return {sync,read,download,login,saveCorrection,saveToolDrawing,saveLocation,importCorrections,importProduction,whatsappSettings,saveWhatsappSettings,whatsappNotifications,retryWhatsapp,findFile,findCorrectionFile,status:()=>({...state}),enabled:()=>fs.existsSync(credentialPath)};
};
