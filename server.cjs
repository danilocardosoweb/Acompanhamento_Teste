const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const crypto = require('crypto');
const {parseCorrections}=require('./importer.cjs');
const root = __dirname, port = 4317;
const cloud = require('./cloud.cjs')(root);
let syncing = false, error = '', lastRun = '';
let previewQueue=Promise.resolve();
const previewJobs=new Map();
const sessions=new Map();
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2));}
function authenticated(req){const token=cookies(req).quality_session,session=token&&sessions.get(token);if(!session||session.expires<Date.now()){if(token)sessions.delete(token);return null;}return session.user;}
function readBody(req,limit=4096){return new Promise((resolve,reject)=>{let body='';req.on('data',d=>{body+=d;if(body.length>limit){reject(Error('Requisição muito grande.'));req.destroy();}});req.on('end',()=>resolve(body));req.on('error',reject);});}
function correctionFile(input){if(!input)return null;const name=path.basename(String(input.name||'')),ext=path.extname(name).toLowerCase();if(!['.xlsx','.xls','.xlsm','.xlsb','.pdf'].includes(ext))throw Error('Selecione um arquivo Excel ou PDF.');const bytes=Buffer.from(String(input.data||''),'base64');if(!bytes.length||bytes.length>25*1024*1024)throw Error('O arquivo deve ter até 25 MB.');const pdf=bytes.subarray(0,5).toString()==='%PDF-',zip=bytes[0]===0x50&&bytes[1]===0x4b,ole=bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));if(ext==='.pdf'?!pdf:!(zip||ole))throw Error('O conteúdo do arquivo não corresponde ao formato selecionado.');const mime=ext==='.pdf'?'application/pdf':ext==='.xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.ms-excel';return {name,bytes,mimeType:mime};}
function drawingFile(input){const file=correctionFile(input);if(!file||file.mimeType!=='application/pdf')throw Error('Selecione o desenho técnico em PDF.');return file;}
async function validateLocation(correctionId,location){if(!location)return;const all=await cloud.read(),correction=(all.productionNotes||all.corrections||[]).find(c=>c.id===correctionId);if(!correction)throw Error('Apontamento não encontrado.');if(location.remove){if(!(correction.locations||[]).some(l=>l.id===location.id))throw Error('Localização não pertence a esta correção.');return;}const drawing=(all.toolDrawings||[]).find(d=>d.id===location.drawingId);if(!drawing||String(drawing.tool).toUpperCase()!==String(correction.tool).toUpperCase()||(drawing.sequence!=null&&Number(drawing.sequence)!==Number(correction.sequence)))throw Error('O desenho não pertence a esta ferramenta e sequência.');}
function attachment(url) {
  const data=JSON.parse(fs.readFileSync(path.join(root,'dados/testes.json'),'utf8'));
  const record=data.records.find(r=>r.id===url.searchParams.get('id'));
  const index=Number(url.searchParams.get('index'));
  const item=Number.isInteger(index)?record?.attachments[index]:null;
  if(!item) throw new Error('Anexo não encontrado.');
  const source=path.resolve(root,item.path);
  if(!source.startsWith(path.join(root,'anexos')+path.sep)) throw new Error('Caminho inválido.');
  return {item,source};
}
function renderPreview(item,source) {
  if(!/\.(xlsx|xls|xlsm|xlsb|pdf)$/i.test(source)) throw new Error('Visualização não disponível para este formato.');
  const key=crypto.createHash('sha256').update('preview-v1').update(fs.readFileSync(source)).digest('hex');
  const dir=path.join(root,'previews',key), manifest=path.join(dir,'manifest.json');
  const result=()=>({...JSON.parse(fs.readFileSync(manifest,'utf8')),key,name:item.name});
  if(fs.existsSync(manifest)) return Promise.resolve(result());
  if(previewJobs.has(key)) return previewJobs.get(key);
  const job=previewQueue.catch(()=>{}).then(()=>new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'visualizar.ps1'),'-Source',source,'-Destination',dir],{windowsHide:true});
    let err='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('A visualização demorou mais que o esperado. Feche eventuais avisos do Excel e tente novamente.'));},120000);
    child.stderr.on('data',d=>err+=d);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error(err||'Não foi possível preparar a visualização.'));try{resolve(result());}catch(e){reject(e);}});
  }));
  previewQueue=job;
  previewJobs.set(key,job);
  job.finally(()=>previewJobs.delete(key)).catch(()=>{});
  return job;
}
function preview(url) {const {item,source}=attachment(url);return renderPreview(item,source);}
async function correctionPreview(url){
  if(!cloud.enabled())throw Error('Serviço de dados não configurado.');
  const item=cloud.findCorrectionFile(url.searchParams.get('id'),Number(url.searchParams.get('index')));
  if(!item?.objectPath)throw Error('Arquivo não encontrado.');
  if(!/\.(xlsx|xls|xlsm|xlsb|pdf)$/i.test(item.name))throw Error('Visualização não disponível para este formato.');
  const downloaded=await cloud.download(item.objectPath),sourceDir=path.join(root,'previews','sources');
  fs.mkdirSync(sourceDir,{recursive:true});
  const source=path.join(sourceDir,crypto.createHash('sha256').update(item.objectPath).digest('hex')+path.extname(item.name).toLowerCase());
  if(!fs.existsSync(source))fs.writeFileSync(source,downloaded.bytes);
  return renderPreview(item,source);
}
function sync() {
  if (syncing) return;
  syncing = true; error = '';
  const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'coletar.ps1')], {windowsHide:true});
  let output = '';
  const timeout = setTimeout(()=>{output='A leitura do Outlook demorou mais de 3 minutos. Verifique se existe um aviso de acesso no Outlook e tente atualizar novamente.';child.kill();},180000);
  child.stderr.on('data', d => output += d);
  child.on('error', e => {clearTimeout(timeout);error=e.message; syncing=false;});
  child.on('close', async code => {
    clearTimeout(timeout);
    if(code!==0){syncing=false;lastRun=new Date().toISOString();error=output||'Falha na coleta. Verifique o Outlook.';return;}
    try{await cloud.sync();}catch(e){error='Outlook atualizado, mas a sincronização dos dados falhou: '+e.message;}
    syncing=false;lastRun=new Date().toISOString();
  });
}
function json(res, code, body) {res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(body));}
const server = http.createServer((req,res) => {
  if (req.headers.host !== `127.0.0.1:${port}`) return json(res,403,{error:'Acesso local apenas.'});
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.method === 'POST') {
    if(req.headers.origin !== `http://127.0.0.1:${port}` || req.headers['x-painel'] !== 'local') return json(res,403,{error:'Origem invalida.'});
    if(url.pathname === '/api/login') {readBody(req).then(async body=>{try{const input=JSON.parse(body),user=await cloud.login(input.email,input.password),token=crypto.randomBytes(32).toString('hex');sessions.set(token,{user,expires:Date.now()+8*60*60*1000});res.setHeader('Set-Cookie',`quality_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);json(res,200,{user});}catch(e){json(res,401,{error:'Usuário ou senha inválidos.'});}}).catch(()=>json(res,400,{error:'Dados inválidos.'}));return;}
    if(url.pathname === '/api/logout') {const token=cookies(req).quality_session;if(token)sessions.delete(token);res.setHeader('Set-Cookie','quality_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
    if(url.pathname === '/api/correction') {const user=authenticated(req);if(!user)return json(res,401,{error:'Faça login para registrar a correção.'});readBody(req,36*1024*1024).then(async body=>{try{const input=JSON.parse(body),locations=Array.isArray(input.locations)?input.locations.slice(0,50):input.location?[input.location]:[];if(!/^[0-9a-f-]{36}$/.test(String(input.id||''))||String(input.text||'').length>10000)throw Error('Dados inválidos.');for(const location of locations)await validateLocation(input.id,location);await cloud.saveCorrection({id:input.id,text:String(input.text||''),user,file:correctionFile(input.file)});for(const location of locations)await cloud.saveLocation({location,correctionId:input.id,user});const confirmed=await cloud.read(),saved=((confirmed.productionNotes||confirmed.corrections||[]).find(c=>c.id===input.id)?.locations||[]),savedIds=new Set(saved.map(l=>l.id));for(const location of locations){if(location.remove?savedIds.has(location.id):!savedIds.has(location.id))throw Error('O banco não confirmou a gravação das marcações.');}json(res,200,{ok:true,locations:saved.length,confirmed:true});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/tool-drawing') {const user=authenticated(req);if(!user)return json(res,401,{error:'Faça login para associar o desenho.'});readBody(req,14*1024*1024).then(async body=>{try{const input=JSON.parse(body),file=drawingFile(input.file),tool=String(input.tool||'').trim().toUpperCase(),sequence=Number(input.sequence);if(!tool||!Number.isInteger(sequence)||sequence<1)throw Error('Ferramenta e sequência inválidas.');const result=await cloud.saveToolDrawing({id:crypto.randomUUID(),tool,sequence,name:file.name,bytes:file.bytes,user});json(res,200,{ok:true,...result});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/import-corrections') {const user=authenticated(req);if(!user)return json(res,401,{error:'Faça login para importar produção.'});readBody(req,16*1024*1024).then(async body=>{try{const input=JSON.parse(body),bytes=Buffer.from(String(input.data||''),'base64');if(!bytes.length||bytes.length>10*1024*1024||bytes[0]!==80||bytes[1]!==75)throw Error('Selecione um arquivo Excel .xlsx de até 10 MB.');const result=await parseCorrections(bytes,await cloud.read());if(input.confirm){const actionable=result.rows.filter(row=>row.status==='matched'||row.status==='new');await (result.kind==='production'?cloud.importProduction(actionable,user):cloud.importCorrections(actionable,user));result.imported=actionable.length;}json(res,200,result);}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/sync') {if(!authenticated(req))return json(res,401,{error:'Faça login para atualizar os e-mails.'});sync();return json(res,202,{syncing});}
    if(url.pathname === '/api/preview') {
      try {(url.searchParams.get('kind')==='correction'?correctionPreview(url):preview(url)).then(result=>json(res,200,result)).catch(e=>json(res,500,{error:e.message}));}catch(e){json(res,400,{error:e.message});}
      return;
    }
    return json(res,404,{});
  }
  if(req.method !== 'GET') return json(res,405,{});
  if(url.pathname === '/api/auth') return json(res,200,{user:authenticated(req)});
  if(url.pathname === '/api/status') return json(res,200,{syncing,error,lastRun,cloud:cloud.status()});
  if(url.pathname === '/api/data') {
    if(cloud.enabled()) {cloud.read().then(data=>json(res,200,data)).catch(e=>json(res,503,{records:[],warnings:[e.message]}));return;}
    try {return json(res,200,{...JSON.parse(fs.readFileSync(path.join(root,'dados/testes.json'),'utf8')),dataOrigin:'local'});} catch {return json(res,200,{records:[],warnings:[]});}
  }
  if(url.pathname === '/tool-drawing') {if(!authenticated(req))return json(res,401,{error:'Faça login para visualizar o desenho.'});cloud.read().then(all=>{const drawing=(all.toolDrawings||[]).find(d=>d.id===url.searchParams.get('id'));if(!drawing?.objectPath)throw Error('Desenho não encontrado.');return cloud.download(drawing.objectPath);}).then(({bytes,type})=>{res.writeHead(200,{'Content-Type':type||'application/pdf','Content-Disposition':'inline','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=60'});res.end(bytes);}).catch(e=>json(res,404,{error:e.message}));return;}
  let file;
  if (url.pathname.startsWith('/preview/')) {
    if(!/^\/preview\/[a-f0-9]{64}\/sheet-\d+(?:-\d+)?\.(pdf|png)$/.test(url.pathname))return json(res,404,{});
    file=path.join(root,'previews',...url.pathname.split('/').slice(2));
    if(!fs.existsSync(file)&&cloud.enabled()){
      const object=url.pathname.slice(1).replace(/^preview\//,'previews/');
      cloud.download(object).then(({bytes,type})=>{res.writeHead(200,{'Content-Type':type||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=60'});res.end(bytes);}).catch(()=>json(res,404,{}));return;
    }
  } else if (url.pathname === '/attachment') {
    if(cloud.enabled()) {
      try{
        const a=cloud.findFile(url.searchParams.get('id'),Number(url.searchParams.get('index')));
        if(!a?.cloudPath)return json(res,404,{error:'Arquivo não encontrado.'});
        cloud.download(a.cloudPath).then(({bytes,type})=>{res.writeHead(200,{'Content-Type':type||'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});res.end(bytes);}).catch(()=>json(res,404,{}));return;
      }catch{return json(res,404,{});}
    }
    try {
      const data=JSON.parse(fs.readFileSync(path.join(root,'dados/testes.json'),'utf8'));
      const record=data.records.find(r=>r.id===url.searchParams.get('id'));
      const a=record?.attachments[Number(url.searchParams.get('index'))];
      if(!a) return json(res,404,{error:'Arquivo nao encontrado.'});
      file=path.resolve(root,a.path);
      if(!file.startsWith(path.join(root,'anexos')+path.sep)) return json(res,403,{});
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`);
    } catch {return json(res,404,{});}
  } else if (url.pathname === '/correction-file') {
    if(!cloud.enabled())return json(res,503,{error:'Serviço de dados não configurado.'});
    try{
      const a=cloud.findCorrectionFile(url.searchParams.get('id'),Number(url.searchParams.get('index')));
      if(!a?.objectPath)return json(res,404,{error:'Arquivo não encontrado.'});
      const inline=url.searchParams.get('mode')==='inline'&&(/^(video\/|application\/pdf$)/i.test(a.mimeType));
      cloud.download(a.objectPath).then(({bytes,type})=>{res.writeHead(200,{'Content-Type':type||a.mimeType||'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});res.end(bytes);}).catch(()=>json(res,404,{}));return;
    }catch{return json(res,404,{});}
  } else {
    const files={'/':'index.html','/app.js':'app.js','/knowledge.js':'knowledge.js','/corrections.js':'corrections.js','/drawing.js':'drawing.js','/indicators.js':'indicators.js','/preview.js':'preview.js','/style.css':'style.css','/vendor/pdf.mjs':'vendor/pdf.mjs','/vendor/pdf.worker.mjs':'vendor/pdf.worker.mjs'};
    if(!files[url.pathname]) return json(res,404,{});
    file=path.join(root,files[url.pathname]);
  }
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.pdf':'application/pdf','.png':'image/png'}[path.extname(file).toLowerCase()] || 'application/octet-stream';
  fs.readFile(file,(err,buf)=>{if(err)return json(res,404,{});res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(buf);});
});
server.on('error',e=>{if(e.code==='EADDRINUSE')process.exit(0);console.error(e);process.exit(1);});
server.listen(port,'127.0.0.1',()=>{console.log(`Painel local: http://127.0.0.1:${port}\nDados conectados. Atualização automática a cada 1 hora enquanto o painel estiver aberto.`);sync();setInterval(sync,60*60*1000);});
