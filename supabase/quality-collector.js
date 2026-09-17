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
const validPath=p=>/^originals\/[a-f0-9]{64}\.(xlsx|xls|xlsm|xlsb|csv|pdf)$/.test(p)||/^previews\/[a-f0-9]{64}\/sheet-\d+(?:-\d+)?\.(png|pdf)$/.test(p)||/^corrections\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]+$/.test(p);
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
   const state=await(await api('/rest/v1/quality_sync_state?id=eq.outlook-pcp&select=data,synced_at')).json();
   const corrections=[];
   for(let offset=0;;offset+=1000){const page=await(await api(`/rest/v1/quality_corrections_view?select=*&order=source_uploaded_at.desc,id&limit=1000&offset=${offset}`)).json();corrections.push(...page);if(page.length<1000)break;}
   // The source table name is historical. These rows are production notes,
   // matched to tests by the exact tool + sequence pair.
   return respond({...state[0]?.data,records,productionNotes:corrections,corrections,cloudSyncedAt:state[0]?.synced_at});
  }
  return respond({error:'Not found'},404);
 }catch(e){return respond({error:e.message},500);}
});
