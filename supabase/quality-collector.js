// Machine-to-machine endpoint. Every request requires a registered random collector token.
// Its SHA-256 digest is stored in quality_collectors; service keys stay in Supabase.
const base=Deno.env.get('SUPABASE_URL');
const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const bucket='quality-files';
const headers={apikey:secret,Authorization:`Bearer ${secret}`};
const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function api(route,options={}) {
 const response=await fetch(base+route,{...options,headers:{...headers,...options.headers}});
 if(!response.ok)throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0,300)}`);
 return response;
}
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
const validPath=p=>/^originals\/[a-f0-9]{64}\.(xlsx|xls|xlsm|xlsb|csv|pdf)$/.test(p)||/^previews\/[a-f0-9]{64}\/sheet-\d+(?:-\d+)?\.(png|pdf)$/.test(p)||/^corrections\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/.test(p)||/^drawings\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+\.pdf$/.test(p);
async function upsert(table,body){return api(`/rest/v1/${table}?on_conflict=id`,{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify(body)});}
Deno.serve(async req=>{
 try {
  const token=req.headers.get('x-collector-token')||'';
  if(!/^[a-f0-9]{64}$/.test(token))return respond({error:'Unauthorized'},401);
  const digest=await hash(new TextEncoder().encode(token));
  const allowed=await(await api(`/rest/v1/quality_collectors?token_hash=eq.${digest}&active=eq.true&select=label&limit=1`)).json();
  if(!allowed.length)return respond({error:'Unauthorized'},401);
  const url=new URL(req.url), action=url.searchParams.get('action');
  if(action==='login'&&req.method==='POST') {
   const body=await req.json();
   const email=String(body.email||'').trim(),password=String(body.password||'');
   if(!email||!password||email.length>254||password.length>200)return respond({error:'Usuário ou senha inválidos.'},401);
   const users=await(await api('/rest/v1/rpc/quality_verify_existing_user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_email:email,p_password:password})})).json();
   if(!users.length)return respond({error:'Usuário ou senha inválidos.'},401);
   return respond({user:{id:users[0].user_id,email:users[0].email,name:users[0].name,role:users[0].role}});
  }
  if(action==='correction'&&req.method==='POST') {
   const body=await req.json(),id=String(body.id||''),userId=String(body.userId||''),text=String(body.text||'').trim();
   if(!/^[0-9a-f-]{36}$/.test(id)||!/^[0-9a-f-]{36}$/.test(userId)||text.length>10000)return respond({error:'Dados de correção inválidos.'},400);
   await api('/rest/v1/quality_correction_actions?on_conflict=correction_id',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify({correction_id:id,correction_text:text,corrected_at:new Date().toISOString(),corrected_by:userId,corrected_by_name:String(body.userName||'').slice(0,200),updated_at:new Date().toISOString()})});
   if(body.file) {
    const f=body.file;
    if(!validPath(f.objectPath)||!f.objectPath.startsWith(`corrections/${id}/`)||!/^.+\.(xlsx|xls|xlsm|xlsb|pdf)$/i.test(f.name)||!Number.isSafeInteger(f.size)||f.size<1||f.size>25*1024*1024)return respond({error:'Arquivo inválido.'},400);
    await api('/rest/v1/quality_correction_files?on_conflict=object_path',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify({correction_id:id,name:String(f.name).slice(0,255),object_path:f.objectPath,size_bytes:f.size,mime_type:String(f.mimeType||'application/octet-stream').slice(0,120)})});
   }
   return respond({ok:true});
  }
  if(action==='tool-drawing'&&req.method==='POST') {
   const body=await req.json(),tool=String(body.tool||'').trim().toUpperCase(),sequence=body.sequence==null?null:Number(body.sequence),objectPath=String(body.objectPath||''),userId=String(body.userId||'');
   if(!tool||tool.length>80||(sequence!==null&&(!Number.isInteger(sequence)||sequence<1))||!/^[0-9a-f-]{36}$/.test(userId)||!validPath(objectPath)||!objectPath.startsWith(`drawings/${body.id}/`)||!String(body.name||'').toLowerCase().endsWith('.pdf'))return respond({error:'Desenho técnico inválido.'},400);
   const q=`/rest/v1/quality_tool_drawings?tool=ilike.${encodeURIComponent(tool)}&${sequence===null?'sequence=is.null':`sequence=eq.${sequence}`}&select=id&limit=1`,existing=await(await api(q)).json(),id=existing[0]?.id||String(body.id||'');
   if(!/^[0-9a-f-]{36}$/.test(id))return respond({error:'Identificador do desenho inválido.'},400);
   await api('/rest/v1/quality_tool_drawings?on_conflict=id',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({id,tool,sequence,name:String(body.name).slice(0,255),object_path:objectPath,size_bytes:Number(body.size),uploaded_by:userId,updated_at:new Date().toISOString()})});
   return respond({ok:true,id});
  }
  if(action==='location'&&req.method==='POST') {
   const body=await req.json(),id=String(body.id||''),correctionId=String(body.correctionId||''),userId=String(body.userId||'');
   if(body.remove){if(!/^[0-9a-f-]{36}$/.test(id))return respond({error:'Localização inválida.'},400);await api(`/rest/v1/quality_correction_locations?id=eq.${id}`,{method:'DELETE'});return respond({ok:true,removed:true});}
   const x=Number(body.x),y=Number(body.y),page=Number(body.page);
   if(!/^[0-9a-f-]{36}$/.test(id)||!/^[0-9a-f-]{36}$/.test(correctionId)||!/^[0-9a-f-]{36}$/.test(String(body.drawingId||''))||!/^[0-9a-f-]{36}$/.test(userId)||!Number.isInteger(page)||page<1||!Number.isFinite(x)||x<0||x>1||!Number.isFinite(y)||y<0||y>1)return respond({error:'Dados da localização inválidos.'},400);
   await api('/rest/v1/quality_correction_locations?on_conflict=id',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify({id,correction_id:correctionId,drawing_id:body.drawingId,location_type:'pdf',page_pdf:page,x_normalized:x,y_normalized:y,view_name:String(body.view||'Frontal').slice(0,40),component:String(body.component||'').slice(0,80),region:String(body.region||'').slice(0,80),hole_region:String(body.holeRegion||'').slice(0,160),action_name:String(body.action||'').slice(0,160),measure_value:String(body.value||'').slice(0,40),unit_name:String(body.unit||'').slice(0,30),method_name:String(body.method||'').slice(0,80),description:String(body.description||'').slice(0,10000),created_by:userId,created_by_name:String(body.userName||'').slice(0,200),updated_at:new Date().toISOString()})});
   return respond({ok:true,id});
  }
  if(action==='import-corrections'&&req.method==='POST') {
   const body=await req.json(),rows=Array.isArray(body.rows)?body.rows:[],userId=String(body.userId||''),userName=String(body.userName||'').slice(0,200);
   if(!/^[0-9a-f-]{36}$/.test(userId)||!rows.length||rows.length>500)return respond({error:'Importação inválida.'},400);
   for(const row of rows){const id=String(row.matchId||''),text=String(row.correction||'').trim(),systemTool=String(row.systemTool||'').toUpperCase();if(!/^[0-9a-f-]{36}$/.test(id)||!text||text.length>10000||!/^[A-Z0-9._-]+-\d{1,3}$/.test(systemTool))return respond({error:'Registro de importação inválido.'},400);
    if(row.status==='new')await upsert('analysis_correcoes',{id,__file_name:'importacao-web.xlsx',__uploaded_at:new Date().toISOString(),ferramenta_code:systemTool,payload:row.payload||{}});
    const rawDate=String(row.correctionDate||'').trim(),br=rawDate.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/),parsedDate=br?new Date(Date.UTC(Number(br[3]),Number(br[2])-1,Number(br[1]),12)):new Date(rawDate),correctedAt=Number.isNaN(parsedDate.getTime())?new Date().toISOString():parsedDate.toISOString();
    await api('/rest/v1/quality_correction_actions?on_conflict=correction_id',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify({correction_id:id,correction_text:text,corrected_at:correctedAt,corrected_by:userId,corrected_by_name:userName,updated_at:new Date().toISOString()})});
   }
   return respond({ok:true,imported:rows.length});
  }
  if(action==='import-production'&&req.method==='POST') {
   const body=await req.json(),rows=Array.isArray(body.rows)?body.rows:[],userId=String(body.userId||''),userName=String(body.userName||'').slice(0,200);
   if(!/^[0-9a-f-]{36}$/.test(userId)||!rows.length||rows.length>10000)return respond({error:'Importação de produção inválida.'},400);
   const requestedImportId=String(body.importId||''),importId=/^[0-9a-f-]{36}$/.test(requestedImportId)?requestedImportId:crypto.randomUUID(),sourceHash=await hash(new TextEncoder().encode(JSON.stringify(rows.map(r=>r.matchId))));
   for(const row of rows){const id=String(row.matchId||''),tool=String(row.tool||'').trim().toUpperCase(),sequence=row.sequence==null?null:Number(row.sequence);if(!/^[0-9a-f-]{36}$/.test(id)||!tool||tool.length>80||(sequence!==null&&(!Number.isInteger(sequence)||sequence<1)))return respond({error:'Registro de produção inválido.'},400);}
   await api('/rest/v1/quality_production_imports?on_conflict=id',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id:importId,source_name:'Relatório de produção',source_hash:sourceHash,imported_by:userId,imported_by_name:userName,total_rows:Math.max(rows.length,Number(body.totalRows)||0),accepted_rows:Math.max(rows.length,Number(body.totalRows)||0)})});
   const records=rows.map(row=>({id:row.matchId,import_id:importId,source_fingerprint:`${row.matchId}`,tool:String(row.tool).toUpperCase(),sequence:row.sequence==null?null:Number(row.sequence),lot:row.lot==null?null:Number(row.lot),production_date:String(row.productionDate||'').match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)?String(row.productionDate).split('/').reverse().join('-'):null,source_row:Number(row.row)||null,payload:row.payload||{},updated_at:new Date().toISOString()}));
   await api('/rest/v1/quality_production_records?on_conflict=id',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates'},body:JSON.stringify(records)});
   return respond({ok:true,imported:rows.length});
  }
  if(action==='file') {
   const object=url.searchParams.get('path')||'';
   if(!validPath(object))return respond({error:'Invalid path'},400);
   if(req.method==='PUT') {
    const body=await req.arrayBuffer();
    if(body.byteLength>200*1024*1024)return respond({error:'File too large'},413);
    if(object.startsWith('originals/') && !(object.split('/')[1].startsWith(await hash(body))))return respond({error:'Checksum mismatch'},400);
    await api(`/storage/v1/object/${bucket}/${object}`,{method:'POST',headers:{'Content-Type':req.headers.get('content-type')||'application/octet-stream','x-upsert':'true'},body});
    return respond({ok:true});
   }
   if(req.method==='GET') {
    const response=await api(`/storage/v1/object/authenticated/${bucket}/${object}`);
    return new Response(response.body,{headers:{'Content-Type':response.headers.get('content-type')||'application/octet-stream','Cache-Control':'private, max-age=60'}});
   }
  }
  if(action==='setup'&&req.method==='POST') {
   const existing=await fetch(`${base}/storage/v1/bucket/${bucket}`,{headers});
   if(existing.ok) {if((await existing.json()).public)throw Error('Bucket must be private');}
   else {await api('/storage/v1/bucket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:bucket,name:bucket,public:false,file_size_limit:200*1024*1024})});}
   return respond({ok:true});
  }
  if(action==='sync'&&req.method==='POST') {
   const text=await req.text();if(text.length>5000000)return respond({error:'Payload too large'},413);
   const data=JSON.parse(text);
   if(!Array.isArray(data.records)||data.records.length>3000)return respond({error:'Invalid records'},400);
   const rows=[],files=[];
   for(const r of data.records) {
    if(!/^[a-f0-9]{64}$/.test(r.id)||!['APROVADO','REPROVADO','REVISAR'].includes(r.status)||!Array.isArray(r.attachments))return respond({error:'Invalid record'},400);
    rows.push({id:r.id,tool:r.tool,sequence:r.sequence,test_number:r.test,test_date:r.testDate,received_at:r.received+'-03:00',result:r.status,subject:r.subject,comment:r.comment,email_body:r.body,sender:r.sender,source_record:r,synced_at:new Date().toISOString()});
    for(let i=0;i<r.attachments.length;i++) {
     const a=r.attachments[i];if(!validPath(a.cloudPath)||!a.cloudPath.startsWith('originals/'))return respond({error:'Invalid attachment'},400);
     files.push({id:`${r.id}-${i}`,test_id:r.id,name:a.name,object_path:a.cloudPath,size_bytes:a.size,sha256:a.sha256,preview_manifest:a.preview||null,synced_at:new Date().toISOString()});
    }
   }
   if(rows.length)await upsert('quality_tests',rows);
   if(files.length)await upsert('quality_attachments',files);
   await upsert('quality_sync_state',{id:'outlook-pcp',data:{updatedAt:data.updatedAt,source:data.source,warnings:data.warnings||[],skipped:data.skipped},synced_at:new Date().toISOString()});
   return respond({ok:true,records:rows.length,attachments:files.length});
  }
  if(action==='data'&&req.method==='GET') {
   const records=[];
   for(let offset=0;;offset+=1000){const page=await(await api(`/rest/v1/quality_tests?select=source_record&order=received_at.desc,id&limit=1000&offset=${offset}`)).json();records.push(...page.map(r=>r.source_record));if(page.length<1000)break;}
   const attachments=[];
   for(let offset=0;;offset+=1000){const page=await(await api(`/rest/v1/quality_attachments?select=id,test_id,name,object_path,size_bytes,sha256,preview_manifest&limit=1000&offset=${offset}`)).json();attachments.push(...page);if(page.length<1000)break;}
   const attachmentById=new Map(attachments.map(a=>[a.id,a]));
   for(const record of records){record.attachments=(record.attachments||[]).map((attachment,index)=>{const stored=attachmentById.get(`${record.id}-${index}`);if(!stored)return attachment;return {...attachment,cloudPath:stored.object_path,size:stored.size_bytes,sha256:stored.sha256,preview:stored.preview_manifest||attachment.preview};});}
   const state=await(await api('/rest/v1/quality_sync_state?id=eq.outlook-pcp&select=data,synced_at')).json();
   const corrections=[],includeProduction=url.searchParams.get('includeProduction')==='1';let drawings=[],locationsByCorrection={};if(includeProduction){
   for(let offset=0;;offset+=1000){const page=await(await api(`/rest/v1/quality_corrections_view?select=*&order=source_uploaded_at.desc,id&limit=1000&offset=${offset}`)).json();corrections.push(...page);if(page.length<1000)break;}
   const importedProduction=[];
   for(let offset=0;;offset+=1000){const page=await(await api(`/rest/v1/quality_production_records?select=*&order=production_date.desc,created_at.desc&limit=1000&offset=${offset}`)).json();importedProduction.push(...page);if(page.length<1000)break;}
   const productionActions=await(await api('/rest/v1/quality_production_actions?select=*')).json(),productionActionById=new Map(productionActions.map(action=>[action.production_id,action]));
   for(const record of importedProduction){const action=productionActionById.get(record.id);corrections.push({id:record.id,source:'production_import',tool:record.tool,sequence:record.sequence,payload:record.payload||{},correction_text:action?.correction_text||'',corrected_at:action?.corrected_at||null,corrector:action?.corrector||'',files:[],locations:[]});}
   drawings=await(await api('/rest/v1/quality_tool_drawings?select=*&order=updated_at.desc')).json();
   const locations=await(await api('/rest/v1/quality_correction_locations?select=*&order=created_at')).json();locationsByCorrection={};for(const l of locations)(locationsByCorrection[l.correction_id]??=[]).push(l);
   for(const correction of corrections)correction.locations=(locationsByCorrection[correction.id]||[]).map(l=>({id:l.id,drawingId:l.drawing_id,type:l.location_type,page:l.page_pdf,x:Number(l.x_normalized),y:Number(l.y_normalized),view:l.view_name,component:l.component,region:l.region,holeRegion:l.hole_region,action:l.action_name,value:l.measure_value,unit:l.unit_name,method:l.method_name,description:l.description,createdAt:l.created_at,createdByName:l.created_by_name}));
   }
   // The source table name is historical. These rows are production notes,
   // matched to tests by the exact tool + sequence pair.
   return respond({...state[0]?.data,records,productionNotes:corrections,corrections,toolDrawings:drawings.map(d=>({id:d.id,tool:d.tool,sequence:d.sequence,name:d.name,objectPath:d.object_path,size:d.size_bytes,updatedAt:d.updated_at})),cloudSyncedAt:state[0]?.synced_at});
  }
  return respond({error:'Not found'},404);
 }catch(e){return respond({error:e.message},500);}
});
