const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const crypto = require('crypto');
const root = __dirname, port = 4317;
const cloud = require('./cloud.cjs')(root);
let syncing = false, error = '', lastRun = '';
let previewQueue=Promise.resolve();
const previewJobs=new Map();
const sessions=new Map();
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2));}
function authenticated(req){const token=cookies(req).quality_session,session=token&&sessions.get(token);if(!session||session.expires<Date.now()){if(token)sessions.delete(token);return null;}return session.user;}
function readBody(req,limit=4096){return new Promise((resolve,reject)=>{let body='';req.on('data',d=>{body+=d;if(body.length>limit){reject(Error('Requisição muito grande.'));req.destroy();}});req.on('end',()=>resolve(body));req.on('error',reject);});}
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
function preview(url) {
  const {item,source}=attachment(url);
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
    try{await cloud.sync();}catch(e){error='Outlook atualizado, mas o envio ao Supabase falhou: '+e.message;}
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
    if(url.pathname === '/api/sync') {if(!authenticated(req))return json(res,401,{error:'Faça login para atualizar os e-mails.'});sync();return json(res,202,{syncing});}
    if(url.pathname === '/api/preview') {
      try {preview(url).then(result=>json(res,200,result)).catch(e=>json(res,500,{error:e.message}));}catch(e){json(res,400,{error:e.message});}
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
    if(!cloud.enabled())return json(res,503,{error:'Supabase não configurado.'});
    try{
      const a=cloud.findCorrectionFile(url.searchParams.get('id'),Number(url.searchParams.get('index')));
      if(!a?.objectPath)return json(res,404,{error:'Arquivo não encontrado.'});
      const inline=url.searchParams.get('mode')==='inline'&&(/^(video\/|application\/pdf$)/i.test(a.mimeType));
      cloud.download(a.objectPath).then(({bytes,type})=>{res.writeHead(200,{'Content-Type':type||a.mimeType||'application/octet-stream','Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});res.end(bytes);}).catch(()=>json(res,404,{}));return;
    }catch{return json(res,404,{});}
  } else {
    const files={'/':'index.html','/app.js':'app.js','/corrections.js':'corrections.js','/preview.js':'preview.js','/style.css':'style.css'};
    if(!files[url.pathname]) return json(res,404,{});
    file=path.join(root,files[url.pathname]);
  }
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.pdf':'application/pdf','.png':'image/png'}[path.extname(file).toLowerCase()] || 'application/octet-stream';
  fs.readFile(file,(err,buf)=>{if(err)return json(res,404,{});res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(buf);});
});
server.on('error',e=>{if(e.code==='EADDRINUSE')process.exit(0);console.error(e);process.exit(1);});
server.listen(port,'127.0.0.1',()=>{console.log(`Painel local: http://127.0.0.1:${port}\nDados: Supabase Ferramentas_em_testes. Atualizacao a cada 15 minutos.`);sync();setInterval(sync,15*60*1000);});
