const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>s?new Date(s.length===10?s+'T12:00:00':s).toLocaleDateString('pt-BR'):'Data não identificada';
const stamp=s=>s?new Date(s).toLocaleString('pt-BR'):'';
const sortDate=r=>(r.testDate||r.received.slice(0,10))+'T'+r.received.slice(11);
let data={records:[]}, selected='', lastVersion='', wasSyncing=false, authUser=null, canSync=true, productionLoaded=false, productionLoading=null;
function normalizeProductionData(next){
 const source=(next.productionRecords?.length?next.productionRecords:next.productionNotes?.length?next.productionNotes:next.corrections)||[];
 const records=source.map(note=>{const original=note.payload||{},stop=String(original['Cod Parada']??'').trim(),routine=/^001\b|PEDIDO ATENDIDO/i.test(stop),stopLabel=stop.replace(/^\d+\s*-?\s*/,'').trim(),observation=String(original['Obs do Lote']??'').trim()||String(original['Observação Lote']??'').trim(),description=String(original['Descrição']??'').trim()||(!routine&&stop?stopLabel:'');return {...note,payload:{...original,'Data':original['Data']??original['Data Produção'],'Obs do Lote':observation,'Descrição':description}};});
 const notes=records.filter(note=>{const payload=note.payload||{};return [payload['Descrição'],payload['Obs do Lote'],payload['Correção Efetuada'],note.correction_text].some(value=>String(value??'').trim())||(note.files||[]).length>0||(note.locations||[]).length>0;});
 return {...next,productionRecords:records,productionNotes:notes,corrections:notes};
}
async function loadProductionData(){
 if(productionLoaded)return;
 if(productionLoading)return productionLoading;
 productionLoading=(async()=>{
  const response=await fetch('/api/data?includeProduction=1'),next=await response.json();
  if(!response.ok)throw Error(next.warnings?.[0]||'Não foi possível carregar os apontamentos de produção.');
  data={...data,...normalizeProductionData(next)};productionLoaded=true;
 })().finally(()=>{productionLoading=null;});
 return productionLoading;
}

function setSidebar(collapsed){
  document.body.classList.toggle('sidebar-collapsed',collapsed);
  const button=$('sidebar-toggle');
  button.classList.toggle('is-collapsed',collapsed);
  button.setAttribute('aria-expanded',String(!collapsed));
  button.setAttribute('aria-label',collapsed?'Expandir menu':'Recolher menu');
  document.querySelectorAll('.nav-button').forEach(item=>item.title=collapsed?item.querySelector('.nav-label').textContent:'');
  try{localStorage.setItem('quality-sidebar',collapsed?'collapsed':'expanded')}catch{}
}
let savedSidebar=false;
try{savedSidebar=localStorage.getItem('quality-sidebar')==='collapsed'}catch{}
setSidebar(savedSidebar);
$('sidebar-toggle').onclick=()=>setSidebar(!document.body.classList.contains('sidebar-collapsed'));
const mobileMenu=$('mobile-menu-toggle');mobileMenu.onclick=()=>{const open=document.body.classList.toggle('menu-open');mobileMenu.setAttribute('aria-expanded',String(open));mobileMenu.setAttribute('aria-label',open?'Fechar menu':'Abrir menu');};document.querySelectorAll('.nav-button').forEach(button=>button.addEventListener('click',()=>{document.body.classList.remove('menu-open');mobileMenu?.setAttribute('aria-expanded','false');mobileMenu?.setAttribute('aria-label','Abrir menu');}));
function renderSettings(){
 const signed=!!authUser, emailButton=$('settings-email-sync'), productionButton=$('settings-production-import'), correctionButton=$('settings-correction-import'), whatsappButton=$('settings-whatsapp');
 emailButton.hidden=!signed; productionButton.hidden=!signed; correctionButton.hidden=!signed; whatsappButton.hidden=!signed;$('settings-whatsapp-status').textContent=signed?'Defina os grupos e os eventos que o bot deve enviar.':'Entre no sistema para configurar.';
 emailButton.disabled=!canSync;
 $('settings-email-status').textContent=canSync?'Use este computador para consultar o Outlook e atualizar o painel.':'A coleta está configurada em outro computador. Abra o painel nele para atualizar os e-mails.';
}
function openPage(page){
 document.querySelectorAll('.nav-button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
 ['tracking','corrections','fep','draw2data','indicators','settings','controle'].forEach(name=>{const el=$(name+'-page');if(el)el.hidden=name!==page;});
 if(page==='corrections'||page==='indicators'){
  const target=page==='corrections'?'corrections-list':'indicator-kpis';
  $(target).innerHTML='<div class="empty">Carregando dados de produção…</div>';
  loadProductionData().then(()=>page==='corrections'?window.renderCorrections?.():window.renderIndicators?.()).catch(error=>$(target).innerHTML=`<div class="empty">${esc(error.message)}</div>`);
 }
 if(page==='fep')window.renderFep?.();
 if(page==='settings')renderSettings();
 if(page==='controle')window.renderControle?.();
}
window.openPage=openPage;
document.querySelectorAll('.nav-button').forEach(button=>button.addEventListener('click',()=>openPage(button.dataset.page)));
function renderAuth(){const signed=!!authUser;$('auth-user').hidden=!signed;$('logout').hidden=!signed;$('auth-user').textContent=signed?authUser.name||authUser.email:'';$('sync').hidden=signed;$('sync').textContent='Entrar';renderSettings();}
if(!window.__controleModule){window.__controleModule=true;const script=document.createElement('script');script.src='/controle.js?v=20260919-1';document.body.append(script);}
function groups(){const map=new Map();for(const r of data.records){const key=r.tool||'Código não identificado';if(!map.has(key))map.set(key,[]);map.get(key).push(r);}for(const rows of map.values())rows.sort((a,b)=>sortDate(b).localeCompare(sortDate(a))||b.received.localeCompare(a.received));return map;}
function latest(rows){const map=new Map();for(const r of rows){if(!map.has(r.sequence))map.set(r.sequence,r);}return [...map.values()];}
function badge(s){return `<span class="badge ${esc(s)}">${esc(s)}</span>`;}
function render(){
 window.__qualityData=data;
 const all=groups();const latestRows=[...all.values()].flatMap(latest);
 $('m-tools').textContent=[...all.keys()].filter(x=>x!=='Código não identificado').length;
 $('m-approved').textContent=latestRows.filter(r=>r.status==='APROVADO').length;
 $('m-rejected').textContent=latestRows.filter(r=>r.status==='REPROVADO').length;
 $('m-total').textContent=data.records.length;
 $('m-review').textContent=`${latestRows.filter(r=>r.status==='REVISAR').length} sequência(s) a revisar`;
 const q=$('search').value.trim().toUpperCase(), status=$('status').value;
 const filtered=[...all].filter(([key,rows])=>key.includes(q)&&(!status||latest(rows).some(r=>r.status===status))).sort((a,b)=>a[0].localeCompare(b[0]));
 if(!filtered.some(([key])=>key===selected))selected=filtered[0]?.[0]||'';
 $('count').textContent=`${filtered.length} ferramenta(s)`;
 $('tools').innerHTML=filtered.map(([key,rows])=>{const recent=latest(rows);const state=recent.some(r=>r.status==='REPROVADO')?'REPROVADO':recent.some(r=>r.status==='REVISAR')?'REVISAR':'APROVADO';return `<button class="tool ${key===selected?'active':''}" data-key="${esc(key)}"><strong>${esc(key)}</strong>${badge(state)}<small>${rows.length} teste(s) · ${recent.length} sequência(s)</small></button>`}).join('')||'<div class="empty">Nenhuma ferramenta encontrada.</div>';
 document.querySelectorAll('.tool').forEach(b=>b.onclick=()=>{selected=b.dataset.key;render();});
 if(!selected){$('detail').innerHTML='<div class="empty">Os resultados aparecerão aqui após a coleta do Outlook.</div>';return;}
 const rows=all.get(selected), current=new Set(latest(rows).map(r=>r.id));
 const sequences=latest(rows);
 $('detail').innerHTML=`<div class="detail-top"><div><div class="eyebrow">FERRAMENTA</div><h2>${esc(selected)}</h2><p>${rows.length} teste(s) · ${sequences.length} sequência(s)</p></div><small>Mais recente<br><strong>${date(rows[0].testDate||rows[0].received)}</strong></small></div><div class="sequence-summary">${sequences.map(r=>`<span><b>SEQ. ${esc(r.sequence||'—')}</b>${badge(r.status)}</span>`).join('')}</div><div class="history-label">HISTÓRICO DE TESTES</div>`+rows.map(r=>`<details class="test" ${current.has(r.id)?'open':''}><summary class="test-head"><span><strong>SEQ. ${esc(r.sequence||'—')}</strong><small>${r.test?'Teste '+esc(r.test):'Teste sem número'}</small></span>${badge(r.status)}<time>${date(r.testDate)}</time></summary><div class="test-body">${current.has(r.id)?'<p class="latest">Último registro desta sequência</p>':''}<p class="comment">${esc(r.comment||'Sem comentário.')}</p><div class="meta">${esc(r.sender)}${r.sender?' · ':''}Recebido em ${stamp(r.received)}</div><div class="attachments">${r.attachments.map((a,i)=>`<div class="attachment-item"><span>${esc(a.name)}</span><div>${/\.(xlsx|xls|xlsm|xlsb|pdf)$/i.test(a.name)?`<button class="preview-button" data-id="${esc(r.id)}" data-index="${i}" data-name="${esc(a.name)}">Visualizar</button>`:""}<a href="/attachment?id=${encodeURIComponent(r.id)}&index=${i}">↓ Baixar original · ${Math.ceil(a.size/1024)} KB</a></div></div>`).join('')||'<span class="meta">Nenhum anexo disponível.</span>'}</div><details class="email-detail"><summary>Ver e-mail completo</summary><p>${esc(r.subject)}</p><pre>${esc(r.body)}</pre></details></div></details>`).join('');
 if(!$('fep-page')?.hidden)window.renderFep?.();

}
async function refresh(){try{const state=await(await fetch('/api/status')).json();canSync=state.canSync!==false;if(!authUser)$('sync').disabled=state.syncing;renderAuth();const response=await fetch('/api/data');const next=await response.json();if(!response.ok)throw Error(next.warnings?.[0]||'Serviço de dados indisponível.');if(next.updatedAt!==lastVersion||!lastVersion){data=productionLoaded?{...next,productionNotes:data.productionNotes,corrections:data.corrections,toolDrawings:data.toolDrawings}:next;lastVersion=next.updatedAt;render();}$('sync-state').textContent=state.syncing?'Consultando o Outlook e atualizando os dados…':data.updatedAt?`Última atualização: ${stamp(data.updatedAt)} · Atualização automática a cada 1 hora enquanto o painel estiver aberto.`:'Nenhuma coleta concluída. Abra Configurações e atualize os e-mails.';const warnings=[state.error,state.cloud?.error,...(data.warnings||[])].filter(Boolean);$('warning').hidden=!warnings.length;$('warning').textContent=warnings.join('\n');}catch(e){$('sync-state').textContent='Não foi possível consultar os dados: '+e.message;$('sync').disabled=false;}}
async function startSync(){const response=await fetch('/api/sync',{method:'POST',headers:{'X-Painel':'local'}}),result=await response.json();if(response.status===401){authUser=null;renderAuth();$('login-dialog').showModal();return;}if(!response.ok)throw Error(result.error||'Não foi possível iniciar a coleta.');await refresh();}
$('search').oninput=render;$('status').onchange=render;$('sync').onclick=()=>{if(!authUser){$('login-error').textContent='';$('login-dialog').showModal();$('login-email').focus();return;}openPage('settings');};
$('settings-email-sync').onclick=()=>startSync().catch(e=>$('settings-email-status').textContent=e.message);
$('settings-production-import').onclick=()=>window.openProductionImport?.();$('settings-correction-import').onclick=()=>window.openCorrectionImport?.();
$('login-cancel').onclick=()=>$('login-dialog').close();
$('login-form').onsubmit=async e=>{e.preventDefault();$('login-submit').disabled=true;$('login-error').textContent='';try{const response=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Painel':'local'},body:JSON.stringify({email:$('login-email').value,password:$('login-password').value})}),result=await response.json();if(!response.ok)throw Error(result.error||'Usuário ou senha inválidos.');authUser=result.user;$('login-password').value='';$('login-dialog').close();renderAuth();if(productionLoaded)window.renderCorrections?.();if(canSync)await startSync();else await refresh();}catch(err){$('login-error').textContent=err.message;}finally{$('login-submit').disabled=false;}};
$('logout').onclick=async()=>{await fetch('/api/logout',{method:'POST',headers:{'X-Painel':'local'}});authUser=null;renderAuth();if(productionLoaded)window.renderCorrections?.();};
fetch('/api/auth').then(r=>r.json()).then(r=>{authUser=r.user;renderAuth();if(productionLoaded)window.renderCorrections?.();});refresh();setInterval(refresh,60000);setInterval(()=>{if(authUser&&canSync)startSync().catch(e=>$('settings-email-status').textContent=e.message);},60*60*1000);
