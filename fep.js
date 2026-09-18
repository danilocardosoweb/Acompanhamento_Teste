(()=>{const fep$=id=>document.getElementById(id);const fepStatusLabels={DISPONIVEL_PARA_COLETA:'Disponível para coleta',COLETA_PROGRAMADA:'Coleta programada',CHEGOU_DA_FEP:'Chegou da FEP',EM_SERVICO:'Em serviço',RETORNO_PREVISTO:'Retorno previsto',FOLLOW_UP:'Follow Up',REVISAR:'Revisar'};
const fepStatusClass=status=>String(status||'REVISAR').toLowerCase();
function fepRecordText(row){return [row.tool,row.sequence,row.rawTool,row.state,row.subject,row.client,row.description].filter(Boolean).join(' ').toLocaleUpperCase('pt-BR');}
function followUpDate(row){
 if(row.followUpDate)return row.followUpDate;
 const tool=String(row.tool||'').trim();
 if(!tool||!String(row.subject||'').toLocaleUpperCase('pt-BR').includes('FOLLOW'))return '';
 const seq=row.sequence==null?'':String(row.sequence).replace(/^0+/,'');
 const escaped=tool.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const code=seq?`${escaped}[/-]?0?${seq}`:escaped;
 const match=String(row.comment||'').match(new RegExp(`${code}[\\s\\S]{0,180}?(\\d{1,2}/\\d{1,2}/\\d{4})`,'i'));
 return match?match[1]:'';
}
function displayForecast(value){
 if(!value)return 'Não informada';
 if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(value)))return String(value);
 return date(value);
}
window.renderFep=function(){
 const records=(Array.isArray(window.__qualityData?.fepRecords)?window.__qualityData.fepRecords:[]).filter(row=>String(row.tool||'').trim()),query=fep$('fep-search')?.value.trim().toLocaleUpperCase('pt-BR')||'',status=fep$('fep-status')?.value||'';
 const filtered=records.filter(row=>(!status||row.state===status)&&(!query||fepRecordText(row).includes(query))).sort((a,b)=>String(followUpDate(a)||a.eventDate||a.received||'').localeCompare(String(followUpDate(b)||b.eventDate||b.received||''))||String(b.received||'').localeCompare(String(a.received||'')));
 const tools=new Set(filtered.map(row=>row.tool).filter(Boolean));
 fep$('fep-count').innerHTML=`<strong>${filtered.length.toLocaleString('pt-BR')}</strong><span>evento(s) · ${tools.size.toLocaleString('pt-BR')} ferramenta(s)</span>`;
 if(!records.length){fep$('fep-list').innerHTML='<div class="empty">Nenhum evento da FEP foi coletado. Verifique se a pasta “Chamada FEP” ou “FEP” existe na Caixa de Entrada e atualize os e-mails.</div>';return;}
 if(!filtered.length){fep$('fep-list').innerHTML='<div class="empty">Nenhum evento da FEP corresponde aos filtros selecionados.</div>';return;}
 fep$('fep-list').innerHTML=filtered.map(row=>{const forecast=followUpDate(row);return `<article class="fep-card"><div class="fep-card-head"><div><span class="eyebrow">${esc(row.tool)}${row.sequence!=null?` · SEQ. ${esc(String(row.sequence).padStart(2,'0'))}`:''}</span><h3>${esc(row.tool)}</h3></div><span class="fep-status ${esc(fepStatusClass(row.state))}">${esc(fepStatusLabels[row.state]||row.state||'Revisar')}</span></div><div class="fep-meta"><span class="fep-forecast"><small>Previsão de chegada</small><strong>${esc(displayForecast(forecast))}</strong></span><span><small>Confiança</small><strong>${esc(row.confidence||'baixa')}</strong></span><span><small>Recebido</small><strong>${esc(stamp(row.received))}</strong></span></div>${row.state==='FOLLOW_UP'?`<div class="fep-followup"><span><small>Descrição</small><strong>${esc(row.description||'—')}</strong></span></div>`:''}<p class="fep-reason">${esc(row.reason||'Mensagem encaminhada para revisão.')}</p><details><summary>${esc(row.subject||'Abrir mensagem')}</summary><p class="fep-evidence">${esc(row.comment||row.body||'Sem conteúdo disponível.')}</p></details></article>`;}).join('');
};
['fep-search','fep-status'].forEach(id=>fep$(id)?.addEventListener(id==='fep-search'?'input':'change',window.renderFep));})();
