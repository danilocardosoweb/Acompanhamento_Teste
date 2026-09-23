const http = require('http');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const crypto = require('crypto');
const {parseCorrections}=require('./importer.cjs');
const {processDrawing}=require('./draw2data/processing.cjs');
const {processDrawing:processDrawing1909}=require('./draw2data/historical-1909/processing.cjs');
const {exportWorkbook}=require('./draw2data/exporter.cjs');
const {renderDimensionSnapshot,renderPdfPageImage}=require('./draw2data/snapshot.cjs');
const {buildUserFeedback}=require('./draw2data/dimension-decision.cjs');
const {calculateEvaluationMetrics}=require('./draw2data/dimension-pipeline.cjs');
const {buildMonthlySummary}=require('./whatsapp-bot/src/summary');
const root = __dirname, port = Number(process.env.PORT || 4317);
const cloud = require('./cloud.cjs')(root);
let syncing = false, error = '', lastRun = '';
const whatsappBotDir=path.join(root,'whatsapp-bot');
const whatsappStatusFile=path.join(whatsappBotDir,'whatsapp-status.json');
let whatsappBotProcess=null,whatsappBotRetryAt=0;
function whatsappBotIsAlive(pid){if(!Number.isInteger(Number(pid))||Number(pid)<=0)return false;try{process.kill(Number(pid),0);return true;}catch{return false;}}
function ensureWhatsappBot(){
  // O bot pertence somente ao servidor oficial; ambientes de teste permanecem isolados.
  if(port!==4317||process.env.WHATSAPP_BOT_AUTOSTART==='0'||!cloud.enabled())return;
  if(whatsappBotProcess&&whatsappBotProcess.exitCode===null&&whatsappBotProcess.signalCode===null)return;
  if(Date.now()<whatsappBotRetryAt)return;
  try{
    const status=JSON.parse(fs.readFileSync(whatsappStatusFile,'utf8'));
    const age=Date.now()-Date.parse(status.updatedAt||'');
    if(age>=0&&age<30000&&whatsappBotIsAlive(status.pid))return;
  }catch{}
  const entry=path.join(whatsappBotDir,'src','index.js');
  if(!fs.existsSync(path.join(whatsappBotDir,'.env'))||!fs.existsSync(path.join(whatsappBotDir,'node_modules'))||!fs.existsSync(entry)){
    whatsappBotRetryAt=Date.now()+60000;
    return;
  }
  let logFd=null;
  try{logFd=fs.openSync(path.join(whatsappBotDir,'bot.log'),'a');}catch{}
  const child=spawn(process.execPath,[entry],{cwd:whatsappBotDir,windowsHide:true,stdio:['ignore',logFd??'ignore',logFd??'ignore']});
  if(logFd!==null)try{fs.closeSync(logFd);}catch{}
  whatsappBotProcess=child;
  child.on('error',e=>{
    whatsappBotRetryAt=Date.now()+30000;
    try{fs.writeFileSync(whatsappStatusFile,JSON.stringify({connected:false,state:'error',message:`Não foi possível iniciar o bot: ${e.message}`,updatedAt:new Date().toISOString()}));}catch{}
  });
  child.on('exit',(code,signal)=>{
    if(whatsappBotProcess===child)whatsappBotProcess=null;
    whatsappBotRetryAt=Date.now()+30000;
    try{fs.writeFileSync(whatsappStatusFile,JSON.stringify({connected:false,state:'offline',message:code===0?'Bot encerrado.':`Bot parou (${signal||`código ${code}`}); nova tentativa automática em breve.`,updatedAt:new Date().toISOString()}));}catch{}
  });
}
async function queueAutomaticWhatsappSummary(){
  const settings=await cloud.whatsappSettings(),groups=(settings.groups||[]).filter(group=>group.active!==false&&group.whatsapp_group_id);
  if(!groups.length)return;
  const data=await cloud.read(),summary=buildMonthlySummary(data.records||[]),signature=crypto.createHash('sha256').update(JSON.stringify({summary,groups:groups.map(group=>group.whatsapp_group_id).sort()})).digest('hex');
  const stateFile=path.join(root,'dados','whatsapp-summary-digest.json');
  try{if(JSON.parse(fs.readFileSync(stateFile,'utf8')).signature===signature)return;}catch{}
  // Evita duplicidade quando duas sincronizações acontecem quase ao mesmo
  // tempo ou quando o agente é reiniciado antes de o bot concluir a fila.
  const queued=fs.readdirSync(whatsappBotDir).filter(name=>/^whatsapp-summary-command-[a-f0-9-]+\.json$/i.test(name));
  for(const file of queued){try{const pending=JSON.parse(fs.readFileSync(path.join(whatsappBotDir,file),'utf8'));if(pending.digest===signature)return;}catch{}}
  const createdAt=new Date().toISOString();
  for(const group of groups){const id=crypto.randomUUID(),command={id,type:'summary',digest:signature,groupId:group.whatsapp_group_id,groupName:group.name,summary,createdAt,automatic:true};fs.writeFileSync(path.join(whatsappBotDir,`whatsapp-summary-command-${id}.json`),JSON.stringify(command));}
  fs.mkdirSync(path.dirname(stateFile),{recursive:true});
  const tempFile=`${stateFile}.tmp`;fs.writeFileSync(tempFile,JSON.stringify({signature,updatedAt:createdAt}));fs.renameSync(tempFile,stateFile);
}
let previewQueue=Promise.resolve();
const previewJobs=new Map();
const sessions=new Map();
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2));}
function authenticated(req){const token=cookies(req).quality_session,session=token&&sessions.get(token);if(!session||session.expires<Date.now()){if(token)sessions.delete(token);return null;}return session.user;}
function readBody(req,limit=4096){return new Promise((resolve,reject)=>{let body='';req.on('data',d=>{body+=d;if(body.length>limit){reject(Error('Requisição muito grande.'));req.destroy();}});req.on('end',()=>resolve(body));req.on('error',reject);});}
const controlDbPath=path.join(root,'dados','controle-dimensional.json');
function readControlDb(){try{const value=JSON.parse(fs.readFileSync(controlDbPath,'utf8')),seen=new Set(),profiles=[];for(const profile of Array.isArray(value.profiles)?value.profiles:[]){const key=`${String(profile.tool||'').toUpperCase()}|${profile.sequence??''}|${String(profile.revision||'00')}`;if(seen.has(key))continue;seen.add(key);profiles.push(profile);}return {profiles,inspections:Array.isArray(value.inspections)?value.inspections:[]};}catch{return {profiles:[],inspections:[]};}}
function writeControlDb(value){fs.mkdirSync(path.dirname(controlDbPath),{recursive:true});const temp=controlDbPath+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,controlDbPath);}
function correctionFile(input){if(!input)return null;const name=path.basename(String(input.name||'')),ext=path.extname(name).toLowerCase();if(!['.xlsx','.xls','.xlsm','.xlsb','.pdf'].includes(ext))throw Error('Selecione um arquivo Excel ou PDF.');const bytes=Buffer.from(String(input.data||''),'base64');if(!bytes.length||bytes.length>25*1024*1024)throw Error('O arquivo deve ter até 25 MB.');const pdf=bytes.subarray(0,5).toString()==='%PDF-',zip=bytes[0]===0x50&&bytes[1]===0x4b,ole=bytes.subarray(0,8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));if(ext==='.pdf'?!pdf:!(zip||ole))throw Error('O conteúdo do arquivo não corresponde ao formato selecionado.');const mime=ext==='.pdf'?'application/pdf':ext==='.xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.ms-excel';return {name,bytes,mimeType:mime};}
function drawingFile(input){const file=correctionFile(input);if(!file||file.mimeType!=='application/pdf')throw Error('Selecione o desenho técnico em PDF.');return file;}
function evidenceFile(input){const name=path.basename(String(input?.name||'evidencia')),mimeType=String(input?.mimeType||''),bytes=Buffer.from(Array.isArray(input?.data)?input.data:[]);if(!bytes.length||bytes.length>3*1024*1024)throw Error('Cada foto deve ter até 3 MB.');const jpeg=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff,png=bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';if(!jpeg&&!png&&!webp)throw Error('Uma evidência não é uma imagem válida.');return {name,bytes,mimeType:jpeg?'image/jpeg':png?'image/png':'image/webp',extension:jpeg?'jpg':png?'png':'webp'};}
const reportEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const reportNumber=value=>Number.isFinite(Number(value))?Number(value).toLocaleString('pt-BR',{maximumFractionDigits:4}):'—';
function inspectionStatus(inspection){const results=(inspection.measurements||[]).map(item=>item.result);return results.includes('REPROVADO')?'REPROVADO':results.includes('APROVADO')?'APROVADO':'REGISTRADO';}
function inspectionReport(inspection){const status=inspectionStatus(inspection),rows=(inspection.measurements||[]).map(item=>{const low=item.toleranceMinus==null?'—':reportNumber(Number(item.nominal)-Number(item.toleranceMinus)),high=item.tolerancePlus==null?'—':reportNumber(Number(item.nominal)+Number(item.tolerancePlus));return `<tr><td>${reportEscape(item.item||'—')}</td><td>${reportEscape(item.sample||'—')}</td><td>${reportNumber(item.nominal)}</td><td>${low==='—'?'REF':`${low} – ${high}`}</td><td>${reportNumber(item.value)}</td><td class="${item.result==='REPROVADO'?'fail':item.result==='APROVADO'?'ok':''}">${reportEscape(item.result||'REGISTRADO')}</td></tr>`}).join('')||'<tr><td colspan="6">Nenhuma medição registrada.</td></tr>';const evidences=(inspection.evidence||[]).map(item=>`<li>${reportEscape(item.name)}</li>`).join('')||'<li>Sem fotos anexadas.</li>';return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Relatório dimensional ${reportEscape(inspection.tool)}</title><style>body{font-family:Arial,sans-serif;color:#142c42;margin:36px;background:#fff}header{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #0b948a;padding-bottom:18px}.brand{color:#087f78;font-weight:800;letter-spacing:2px}.title{font-size:24px;font-weight:800;margin:8px 0}.badge{padding:8px 12px;border-radius:20px;background:${status==='REPROVADO'?'#fde8e8':status==='APROVADO'?'#e5f6f1':'#edf3f6'};color:${status==='REPROVADO'?'#b42318':status==='APROVADO'?'#067463':'#466176'};font-weight:800;height:max-content}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.meta div{padding:11px;background:#f5f8f9;border-radius:6px}.meta b{display:block;font-size:11px;color:#587082;text-transform:uppercase;margin-bottom:5px}h2{font-size:15px;margin:28px 0 10px}table{border-collapse:collapse;width:100%;font-size:12px}th{background:#eaf3f2;color:#254252;text-align:left}th,td{padding:9px;border:1px solid #d7e1e5}.ok{color:#087f78;font-weight:bold}.fail{color:#b42318;font-weight:bold}.notes{padding:12px;background:#f8fafb;border-left:3px solid #0b948a;white-space:pre-wrap}footer{margin-top:30px;font-size:11px;color:#6a7f8e}</style><body><header><div><div class="brand">TECNOPERFIL · QUALIDADE</div><div class="title">Relatório dimensional de inspeção</div><small>Registro ${reportEscape(inspection.id)}</small></div><span class="badge">${status}</span></header><section class="meta"><div><b>Ferramenta</b>${reportEscape(inspection.tool)}${inspection.sequence?` · Seq. ${reportEscape(inspection.sequence)}`:''}</div><div><b>Data do teste</b>${reportEscape(inspection.date)}</div><div><b>Lote / ordem</b>${reportEscape(inspection.lot||'Não informado')}</div><div><b>Peça</b>${reportEscape(inspection.part||'Não informada')}</div><div><b>Cliente</b>${reportEscape(inspection.client||'Não informado')}</div><div><b>Inspetor / turno</b>${reportEscape(inspection.operator||'Não informado')} · ${reportEscape(inspection.shift||'—')}</div></section><h2>Medições registradas</h2><table><thead><tr><th>Item</th><th>Furo</th><th>Nominal</th><th>Limites</th><th>Medido</th><th>Resultado</th></tr></thead><tbody>${rows}</tbody></table><h2>Observações</h2><div class="notes">${reportEscape(inspection.observations||'Sem observações.')}</div><h2>Fotos de evidência</h2><ul>${evidences}</ul><footer>Relatório gerado pelo Controle dimensional em ${new Date().toLocaleString('pt-BR')}.</footer></body></html>`;}
function reportPath(inspection){return path.join(root,'dados','controle-relatorios',`relatorio-${inspection.id}.html`);}
function writeInspectionReport(inspection){const file=reportPath(inspection);fs.mkdirSync(path.dirname(file),{recursive:true});const html=inspectionReport(inspection);fs.writeFileSync(file,html,'utf8');return {file,html};}
function sendInspectionEmail(inspection,to){return new Promise((resolve,reject)=>{const report=writeInspectionReport(inspection),folder=path.dirname(report.file),payloadPath=path.join(folder,`email-${inspection.id}-${Date.now()}.json`),attachments=[report.file,...(inspection.evidence||[]).map(item=>path.resolve(root,item.path)).filter(file=>file.startsWith(path.join(root,'dados','controle-evidencias')+path.sep)&&fs.existsSync(file))];fs.writeFileSync(payloadPath,JSON.stringify({to,subject:`Relatório dimensional · ${inspection.tool}${inspection.sequence?` · Seq. ${inspection.sequence}`:''} · ${inspection.date}`,html:report.html,attachments}));const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'enviar-relatorio.ps1'),'-PayloadPath',payloadPath],{windowsHide:true}),timer=setTimeout(()=>{child.kill();reject(Error('O envio demorou mais que o esperado. Verifique o Outlook.'));},60000);let output='';child.stderr.on('data',data=>output+=data);child.stdout.on('data',data=>output+=data);child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);try{fs.unlinkSync(payloadPath)}catch{}if(code===0)resolve();else reject(Error(output.trim()||'Não foi possível enviar pelo Outlook.'));});});}
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
  if(path.extname(source).toLowerCase()==='.pdf')return Promise.resolve({directPdf:true,name:item.name});
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
  ensureWhatsappBot();
  const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'coletar.ps1')], {windowsHide:true});
  let output = '';
  const timeout = setTimeout(()=>{output='A leitura do Outlook demorou mais de 3 minutos. Verifique se existe um aviso de acesso no Outlook e tente atualizar novamente.';child.kill();},180000);
  child.stderr.on('data', d => output += d);
  child.on('error', e => {clearTimeout(timeout);error=e.message; syncing=false;});
  child.on('close', async code => {
    clearTimeout(timeout);
    if(code!==0){syncing=false;lastRun=new Date().toISOString();error=output||'Falha na coleta. Verifique o Outlook.';return;}
    try{await cloud.sync();try{await queueAutomaticWhatsappSummary();}catch(e){console.error('Não foi possível preparar o resumo automático do WhatsApp:',e.message);}}catch(e){error='Outlook atualizado, mas a sincronização dos dados falhou: '+e.message;}
    syncing=false;lastRun=new Date().toISOString();
    ensureWhatsappBot();
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
    if(url.pathname === '/api/import-corrections') {const user=authenticated(req);if(!user)return json(res,401,{error:'Faça login para importar a planilha.'});readBody(req,16*1024*1024).then(async body=>{try{const input=JSON.parse(body),bytes=Buffer.from(String(input.data||''),'base64');if(!bytes.length||bytes.length>10*1024*1024||bytes[0]!==80||bytes[1]!==75)throw Error('Selecione um arquivo Excel .xlsx de até 10 MB.');const result=await parseCorrections(bytes,await cloud.read(true));if(input.expectedKind&&result.kind!==input.expectedKind)throw Error(input.expectedKind==='correction'?'Esta planilha não possui a coluna Correção Efetuada. Selecione a planilha de correções executadas.':'Esta planilha contém correções. Use o botão Importar correções na tela de Apontamentos.');if(input.confirm){const all=result.rows.filter(row=>row.status==='matched'||row.status==='new'),production=result.kind==='production',offset=Math.max(0,Number(input.offset)||0),limit=Math.min(50,Math.max(1,Number(input.limit)||25)),rows=production?all.slice(offset,offset+limit):all;await (production?cloud.importProduction(rows,user):cloud.importCorrections(rows,user));result.imported=rows.length;result.totalImportable=all.length;result.nextOffset=production?offset+rows.length:all.length;result.complete=!production||result.nextOffset>=all.length;}json(res,200,result);}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/sync') {if(!authenticated(req))return json(res,401,{error:'Faça login para atualizar os e-mails.'});sync();return json(res,202,{syncing});}
    if(url.pathname === '/api/draw2data/analyze') {readBody(req,110*1024*1024).then(async body=>{try{const input=JSON.parse(body),name=path.basename(String(input.fileName||'')),engine=input.settings?.engine||'official';if(!/\.pdf$/i.test(name)||!Array.isArray(input.data)||input.data.length<5||input.data.length>25*1024*1024)throw Error('Selecione um PDF de até 25 MB.');if(!['official','historical-1909'].includes(engine))throw Error('Motor de leitura inválido.');const result=engine==='historical-1909'?await processDrawing1909(name,Buffer.from(input.data)):await processDrawing(name,Buffer.from(input.data),input.settings);result.engineSelection=engine;result.engineLabel=engine==='historical-1909'?'Histórico · 19/09':'Oficial · Atual';json(res,200,result);}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/draw2data/snapshot') {readBody(req,110*1024*1024).then(async body=>{try{const input=JSON.parse(body),name=path.basename(String(input.fileName||''));if(!/\.pdf$/i.test(name)||!Array.isArray(input.data)||input.data.length<5||input.data.length>25*1024*1024)throw Error('Selecione um PDF de até 25 MB.');const image=await renderDimensionSnapshot(Buffer.from(input.data),input.dimension);json(res,200,{page:image.page,width:image.width,height:image.height,data:image.bytes.toString('base64')});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/draw2data/page-image') {readBody(req,110*1024*1024).then(async body=>{try{const input=JSON.parse(body),name=path.basename(String(input.fileName||''));if(!/\.pdf$/i.test(name)||!Array.isArray(input.data)||input.data.length<5||input.data.length>25*1024*1024)throw Error('Selecione um PDF de até 25 MB.');const image=await renderPdfPageImage(Buffer.from(input.data),input.page);json(res,200,{page:image.page,pageWidth:image.pageWidth,pageHeight:image.pageHeight,width:image.width,height:image.height,data:image.bytes.toString('base64')});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/draw2data/feedback') {readBody(req,110*1024*1024).then(async body=>{try{const input=JSON.parse(body),candidate=input.candidate;if(!candidate||!['confirm','correct','exclude'].includes(input.userAction))throw Error('Feedback de cota inválido.');const id=crypto.randomUUID(),folder=path.join(root,'dados','draw2data-feedback'),cropFile=path.join(folder,`${id}.png`);fs.mkdirSync(folder,{recursive:true});let crop=null,documentId=crypto.createHash('sha1').update(path.basename(String(input.fileName||''))).digest('hex');if(Array.isArray(input.data)&&input.data.length>=5&&input.data.length<=25*1024*1024){const bytes=Buffer.from(input.data),image=await renderDimensionSnapshot(bytes,candidate);documentId=crypto.createHash('sha1').update(bytes).digest('hex');fs.writeFileSync(cropFile,image.bytes);crop=path.relative(root,cropFile).replace(/\\/g,'/');}const feedback={id,fileName:path.basename(String(input.fileName||'')),...buildUserFeedback(candidate,{correctedText:input.correctedText??null,userAction:input.userAction,classification:input.classification,crop,documentId})};fs.appendFileSync(path.join(folder,'feedback.jsonl'),JSON.stringify(feedback)+'\n','utf8');json(res,201,{ok:true,id,crop});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/control-profiles') {readBody(req,30*1024*1024).then(body=>{try{const input=JSON.parse(body),tool=String(input.tool||'').trim().toUpperCase(),dimensions=Array.isArray(input.dimensions)?input.dimensions.slice(0,500):[];if(!tool||!dimensions.length)throw Error('Informe a ferramenta e pelo menos uma cota.');const db=readControlDb(),sequence=input.sequence?Number(input.sequence):null,revision=String(input.revision||'00'),duplicate=db.profiles.find(p=>String(p.tool).toUpperCase()===tool&&(p.sequence??null)===sequence&&String(p.revision||'00')===revision);if(duplicate)throw Error(`Já existe um perfil ${tool} · Rev. ${revision}. Edite o perfil existente ou use outra revisão.`);const profile={id:crypto.randomUUID(),tool,sequence,revision,name:String(input.name||`${tool} - Perfil de controle`),dimensions,createdAt:new Date().toISOString(),active:true};if(Array.isArray(input.fileData)&&input.fileData.length){const folder=path.join(root,'dados','controle-desenhos');fs.mkdirSync(folder,{recursive:true});const fileName=`${profile.id}.pdf`;fs.writeFileSync(path.join(folder,fileName),Buffer.from(input.fileData));profile.drawingPath=`dados/controle-desenhos/${fileName}`;}db.profiles.unshift(profile);writeControlDb(db);json(res,201,profile);}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/control-profiles/update') {readBody(req,30*1024*1024).then(body=>{try{const input=JSON.parse(body),db=readControlDb(),profile=db.profiles.find(p=>p.id===input.id);if(!profile)throw Error('Perfil não encontrado.');const tool=String(input.tool??profile.tool).trim().toUpperCase(),revision=String(input.revision||profile.revision||'00').trim();if(!tool||tool.length>80)throw Error('Informe um código de ferramenta válido.');const duplicate=db.profiles.find(p=>p.id!==profile.id&&String(p.tool).toUpperCase()===tool&&(p.sequence??null)===(profile.sequence??null)&&String(p.revision||'00')===revision);if(duplicate)throw Error(`Já existe um perfil ${tool} · Rev. ${revision}.`);const name=String(input.name??profile.name).trim();if(!name||name.length>200||revision.length>40)throw Error('Informe um nome e uma revisão válidos.');profile.tool=tool;profile.name=name;profile.revision=revision;if(input.active!==undefined)profile.active=input.active===true;if(Array.isArray(input.dimensions)){if(!input.dimensions.length||input.dimensions.length>500)throw Error('O perfil precisa conter entre 1 e 500 cotas.');profile.dimensions=input.dimensions;}if(Array.isArray(input.fileData)&&input.fileData.length){const folder=path.join(root,'dados','controle-desenhos');fs.mkdirSync(folder,{recursive:true});const fileName=`${profile.id}.pdf`;fs.writeFileSync(path.join(folder,fileName),Buffer.from(input.fileData));profile.drawingPath=`dados/controle-desenhos/${fileName}`;}profile.updatedAt=new Date().toISOString();writeControlDb(db);json(res,200,profile);}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/control-profiles/delete') {readBody(req,32768).then(body=>{try{const input=JSON.parse(body),db=readControlDb(),index=db.profiles.findIndex(p=>p.id===input.id);if(index<0)throw Error('Perfil não encontrado.');if(db.inspections.some(i=>i.profileId===input.id))throw Error('Este perfil possui inspeções registradas e não pode ser excluído. Crie uma nova revisão ou arquive-o.');db.profiles.splice(index,1);writeControlDb(db);json(res,200,{ok:true});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/inspections') {readBody(req,14*1024*1024).then(body=>{try{const input=JSON.parse(body),profileId=String(input.profileId||''),sequence=Number(input.sequence),measurements=Array.isArray(input.measurements)?input.measurements.slice(0,500):[],evidence=Array.isArray(input.evidence)?input.evidence.slice(0,4):[];const db=readControlDb(),profile=db.profiles.find(item=>item.id===profileId);if(!profile)throw Error('Perfil de controle não encontrado.');if(profile.active===false)throw Error('Este perfil aguarda validação e ainda não pode receber medições.');if(!Number.isInteger(sequence)||sequence<1)throw Error('Informe a sequência que está sendo controlada.');if(!measurements.length)throw Error('Registre pelo menos uma medição.');const inspection={id:crypto.randomUUID(),profileId,tool:profile.tool,sequence,date:String(input.date||new Date().toISOString().slice(0,10)),client:String(input.client||''),part:String(input.part||''),quantity:Number(input.quantity)||1,lot:String(input.lot||''),operator:String(input.operator||''),shift:String(input.shift||''),observations:String(input.observations||''),measurements,evidence:[],createdAt:new Date().toISOString()};if(evidence.length){const folder=path.join(root,'dados','controle-evidencias');fs.mkdirSync(folder,{recursive:true});inspection.evidence=evidence.map((item,index)=>{const image=evidenceFile(item),id=crypto.randomUUID(),fileName=`${inspection.id}-${index+1}.${image.extension}`;fs.writeFileSync(path.join(folder,fileName),image.bytes);return {id,name:image.name,mimeType:image.mimeType,path:`dados/controle-evidencias/${fileName}`,createdAt:inspection.createdAt};});}db.inspections.unshift(inspection);writeControlDb(db);json(res,201,inspection);}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    const reportEmailMatch=url.pathname.match(/^\/api\/inspections\/([0-9a-f-]+)\/email$/i);if(reportEmailMatch){readBody(req,32768).then(async body=>{try{const input=JSON.parse(body),to=String(input.to||'').trim();if(!to||to.length>1000||!to.split(/[;,]/).every(address=>/^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(address)))throw Error('Informe destinatários de e-mail válidos.');const inspection=readControlDb().inspections.find(item=>item.id===reportEmailMatch[1]);if(!inspection)throw Error('Inspeção não encontrada.');await sendInspectionEmail(inspection,to);json(res,200,{ok:true,message:'Relatório encaminhado ao Outlook.'});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/draw2data/export') {readBody(req,2*1024*1024).then(async body=>{try{const input=JSON.parse(body);if(!input||!Array.isArray(input.dimensions)||input.dimensions.length>5000||!String(input.fileName||''))throw Error('Resultado de análise inválido.');const result=exportWorkbook(input,path.join(root,'draw2data-results')),base64=result.bytes.toString('base64');json(res,200,{fileName:result.fileName,data:base64});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/whatsapp-summary') {const user=authenticated(req);if(!user)return json(res,401,{error:'Faça login para enviar o resumo.'});(async()=>{const settings=await cloud.whatsappSettings(),group=settings.groups?.find(item=>item.active!==false&&item.whatsapp_group_id);if(!group)throw Error('Configure o grupo de WhatsApp antes de enviar o resumo.');const data=await cloud.read(),summary=buildMonthlySummary(data.records||[]),id=crypto.randomUUID(),createdAt=new Date().toISOString(),command={id,type:'summary',groupId:group.whatsapp_group_id,groupName:group.name,summary,createdAt,requestedBy:user.name||user.email};fs.writeFileSync(path.join(whatsappBotDir,`whatsapp-summary-command-${id}.json`),JSON.stringify(command));json(res,202,{id,state:'pending',message:'Resumo encaminhado ao bot.'});})().catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/whatsapp-settings') {const user=authenticated(req);if(!user)return json(res,401,{error:'Faça login para configurar as notificações.'});readBody(req,32768).then(async body=>{try{json(res,200,await cloud.saveWhatsappSettings(JSON.parse(body)));}catch(e){json(res,502,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/whatsapp-retry') {if(!authenticated(req))return json(res,401,{error:'Faça login para reenviar a notificação.'});readBody(req,4096).then(async body=>{try{const value=JSON.parse(body);json(res,200,await cloud.retryWhatsapp(value.id));}catch(e){json(res,502,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    if(url.pathname === '/api/preview') {
      try {(url.searchParams.get('kind')==='correction'?correctionPreview(url):preview(url)).then(result=>json(res,200,result)).catch(e=>json(res,500,{error:e.message}));}catch(e){json(res,400,{error:e.message});}
      return;
    }
    const controlSnapshotMatch=url.pathname.match(/^\/api\/control-profiles\/([0-9a-f-]+)\/snapshot$/i);if(controlSnapshotMatch){readBody(req,32768).then(async body=>{try{const input=JSON.parse(body),profile=readControlDb().profiles.find(p=>p.id===controlSnapshotMatch[1]);if(!profile?.drawingPath)throw Error('Desenho não associado a este perfil.');const file=path.resolve(root,profile.drawingPath),folder=path.join(root,'dados','controle-desenhos')+path.sep;if(!file.startsWith(folder)||!fs.existsSync(file))throw Error('Desenho não encontrado.');const image=await renderDimensionSnapshot(fs.readFileSync(file),input.dimension);json(res,200,{page:image.page,width:image.width,height:image.height,data:image.bytes.toString('base64')});}catch(e){json(res,400,{error:e.message});}}).catch(e=>json(res,400,{error:e.message}));return;}
    return json(res,404,{});
  }
  if(req.method !== 'GET') return json(res,405,{});
  if(url.pathname === '/api/draw2data/metrics') {const file=path.join(root,'dados','draw2data-feedback','feedback.jsonl');let records=[];try{records=fs.readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch{}const metrics=calculateEvaluationMetrics(records),reasons=records.flatMap(row=>String(row.reason||'').split(',').filter(Boolean)).reduce((summary,key)=>(summary[key]=(summary[key]||0)+1,summary),{});return json(res,200,{...metrics,topReasons:Object.entries(reasons).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([reason,count])=>({reason,count}))});}
  if(url.pathname === '/api/auth') return json(res,200,{user:authenticated(req)});
  const reportMatch=url.pathname.match(/^\/api\/inspections\/([0-9a-f-]+)\/report$/i);if(reportMatch){const inspection=readControlDb().inspections.find(item=>item.id===reportMatch[1]);if(!inspection)return json(res,404,{error:'Inspeção não encontrada.'});const report=writeInspectionReport(inspection),name=`relatorio-dimensional-${String(inspection.tool||'perfil').replace(/[^a-z0-9_-]/gi,'-')}-${inspection.date||'inspecao'}.html`;res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'no-store'});return res.end(report.html);}
  const evidenceMatch=url.pathname.match(/^\/api\/inspections\/([0-9a-f-]+)\/evidence\/([0-9a-f-]+)$/i);if(evidenceMatch){const inspection=readControlDb().inspections.find(item=>item.id===evidenceMatch[1]),evidence=inspection?.evidence?.find(item=>item.id===evidenceMatch[2]);if(!evidence?.path)return json(res,404,{error:'Evidência não encontrada.'});const file=path.resolve(root,evidence.path),folder=path.join(root,'dados','controle-evidencias')+path.sep;if(!file.startsWith(folder)||!fs.existsSync(file))return json(res,404,{error:'Arquivo de evidência não encontrado.'});res.writeHead(200,{'Content-Type':evidence.mimeType||'image/jpeg','Cache-Control':'private, max-age=60'});return fs.createReadStream(file).pipe(res);}
  const drawingMatch=url.pathname.match(/^\/api\/control-profiles\/([0-9a-f-]+)\/drawing$/i);if(drawingMatch){const profile=readControlDb().profiles.find(p=>p.id===drawingMatch[1]);if(!profile?.drawingPath)return json(res,404,{error:'Desenho não associado a este perfil.'});const file=path.resolve(root,profile.drawingPath);if(!file.startsWith(path.join(root,'dados','controle-desenhos')+path.sep)||!fs.existsSync(file))return json(res,404,{error:'Desenho não encontrado.'});res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'inline','Cache-Control':'private, max-age=60'});return fs.createReadStream(file).pipe(res);}
  if(url.pathname === '/api/control-profiles') return json(res,200,readControlDb().profiles);
  if(url.pathname === '/api/inspections') return json(res,200,readControlDb().inspections);
  if(url.pathname === '/api/status') return json(res,200,{syncing,error,lastRun,cloud:cloud.status()});
  if(url.pathname === '/api/whatsapp-status') {if(!authenticated(req))return json(res,401,{error:'Faça login para verificar o WhatsApp.'});try{const status=JSON.parse(fs.readFileSync(whatsappStatusFile,'utf8')),age=Date.now()-Date.parse(status.updatedAt||'');if(age<0||age>=30000||!whatsappBotIsAlive(status.pid))return json(res,200,{...status,connected:false,state:'offline',message:'O bot está parado. O servidor tentará iniciá-lo automaticamente.'});return json(res,200,status);}catch{return json(res,200,{connected:false,state:'offline',message:'O bot ainda não foi iniciado neste computador.'});}}
  if(url.pathname === '/api/whatsapp-summary-status' && req.method === 'GET') {if(!authenticated(req))return json(res,401,{error:'Faça login para consultar o envio.'});const id=String(url.searchParams.get('id')||'').replace(/[^a-f0-9-]/gi,'');if(!id)return json(res,400,{error:'Envio inválido.'});const resultFile=path.join(root,'whatsapp-bot',`whatsapp-summary-result-${id}.json`);try{return json(res,200,JSON.parse(fs.readFileSync(resultFile,'utf8')));}catch{return json(res,200,{id,state:'pending',message:'O bot ainda está processando o resumo.'});}}
  if(url.pathname === '/api/whatsapp-settings' && req.method === 'GET') {if(!authenticated(req))return json(res,401,{error:'Faça login para configurar as notificações.'});cloud.whatsappSettings().then(value=>json(res,200,value)).catch(e=>json(res,502,{error:e.message}));return;}
  if(url.pathname === '/api/whatsapp-notifications' && req.method === 'GET') {if(!authenticated(req))return json(res,401,{error:'Faça login para ver o histórico.'});cloud.whatsappNotifications().then(value=>json(res,200,value)).catch(e=>json(res,502,{error:e.message}));return;}
  if(url.pathname === '/whatsapp-qr') {const qrFile=path.join(root,'whatsapp-bot','whatsapp-qr.png');if(!fs.existsSync(qrFile))return json(res,404,{error:'QR Code indisponível.'});res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});return fs.createReadStream(qrFile).pipe(res);}
  if(url.pathname === '/api/data') {
    if(cloud.enabled()) {cloud.read(url.searchParams.get('includeProduction')==='1').then(data=>json(res,200,data)).catch(e=>json(res,503,{records:[],warnings:[e.message]}));return;}
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
    const wantsInline=url.searchParams.get('mode')==='inline';
    if(cloud.enabled()) {
      try{
        const a=cloud.findFile(url.searchParams.get('id'),Number(url.searchParams.get('index')));
        if(!a?.cloudPath)return json(res,404,{error:'Arquivo não encontrado.'});
        const inline=wantsInline&&(/\.pdf$/i.test(a.name)||/^application\/pdf$/i.test(a.mimeType||''));
        cloud.download(a.cloudPath).then(({bytes,type})=>{res.writeHead(200,{'Content-Type':type||a.mimeType||(/\.pdf$/i.test(a.name)?'application/pdf':'application/octet-stream'),'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});res.end(bytes);}).catch(()=>json(res,404,{}));return;
      }catch{return json(res,404,{});}
    }
    try {
      const data=JSON.parse(fs.readFileSync(path.join(root,'dados/testes.json'),'utf8'));
      const record=data.records.find(r=>r.id===url.searchParams.get('id'));
      const a=record?.attachments[Number(url.searchParams.get('index'))];
      if(!a) return json(res,404,{error:'Arquivo nao encontrado.'});
      file=path.resolve(root,a.path);
      if(!file.startsWith(path.join(root,'anexos')+path.sep)) return json(res,403,{});
      const inline=wantsInline&&/\.pdf$/i.test(a.name);
      res.setHeader('Content-Disposition', `${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
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
    const files={'/':'index.html','/app.js':'app.js','/knowledge.js':'knowledge.js','/corrections.js':'corrections.js','/drawing.js':'drawing.js','/indicators.js':'indicators.js','/fep.js':'fep.js','/draw2data.js':'draw2data.js','/draw2data/manual-dimension.js':'draw2data/manual-dimension.js','/controle.js':'controle.js','/preview.js':'preview.js','/revision-tools.js':'revision-tools.js','/whatsapp-settings.js':'whatsapp-settings.js','/style.css':'style.css','/manifest.webmanifest':'manifest.webmanifest','/service-worker.js':'service-worker.js','/app-icon.svg':'app-icon.svg','/vendor/pdf.mjs':'vendor/pdf.mjs','/vendor/pdf.worker.mjs':'vendor/pdf.worker.mjs'};
    if(!files[url.pathname]) return json(res,404,{});
    file=path.join(root,files[url.pathname]);
  }
  const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.pdf':'application/pdf','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json; charset=utf-8'}[path.extname(file).toLowerCase()] || 'application/octet-stream';
  fs.readFile(file,(err,buf)=>{if(err)return json(res,404,{});res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(buf);});
});
server.on('error',e=>{if(e.code==='EADDRINUSE')process.exit(0);console.error(e);process.exit(1);});
server.listen(port,'127.0.0.1',()=>{console.log(`Painel local: http://127.0.0.1:${port}\nDados conectados. Atualização automática a cada 1 hora enquanto o painel estiver aberto.`);sync();setInterval(sync,60*60*1000);if(port===4317&&process.env.WHATSAPP_BOT_AUTOSTART!=='0')setInterval(ensureWhatsappBot,15000);});
