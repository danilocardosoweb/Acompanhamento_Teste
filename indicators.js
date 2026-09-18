const indicatorSequence=value=>{const match=String(value??'').match(/\d+/);return match?Number(match[0]):null;};
const indicatorCategory=sequence=>indicatorSequence(sequence)===1?'Nova':'Reposição';
const indicatorRecordDate=record=>new Date(record.testDate||record.received||0);
const indicatorPercent=(value,total)=>total?Math.round(value*100/total):0;

function indicatorLatest(records){
 const map=new Map();
 [...records].sort((a,b)=>indicatorRecordDate(b)-indicatorRecordDate(a)).forEach(record=>{const sequence=indicatorSequence(record.sequence);if(!record.tool||sequence===null)return;const key=`${record.tool}|${sequence}`;if(!map.has(key))map.set(key,record);});
 return [...map.values()];
}
function indicatorKpi(label,value,detail,tone=''){
 return `<article class="indicator-kpi ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
}
function indicatorComparison(label,rows){
 const approved=rows.filter(r=>r.status==='APROVADO').length,rejected=rows.filter(r=>r.status==='REPROVADO').length,review=rows.length-approved-rejected,rate=indicatorPercent(approved,rows.length);
 return `<div class="comparison-row"><div class="comparison-label"><strong>${label}</strong><span>${rows.length} sequência(s)</span></div><div class="rate-value"><strong>${rate}%</strong><span>aprovação</span></div><div class="result-bar" aria-label="${rate}% aprovado"><i class="approved" style="width:${indicatorPercent(approved,rows.length)}%"></i><i class="rejected" style="width:${indicatorPercent(rejected,rows.length)}%"></i><i class="review" style="width:${indicatorPercent(review,rows.length)}%"></i></div><div class="result-legend"><span><i class="legend-approved"></i>${approved} aprovadas</span><span><i class="legend-rejected"></i>${rejected} reprovadas</span>${review?`<span><i class="legend-review"></i>${review} a revisar</span>`:''}</div></div>`;
}
window.renderIndicators=function(){
 const months=Number($('indicator-period')?.value||0),cutoff=months?new Date(new Date().setMonth(new Date().getMonth()-months)):null;
 const records=(data.records||[]).filter(record=>!cutoff||indicatorRecordDate(record)>=cutoff),latestRows=indicatorLatest(records),newRows=latestRows.filter(r=>indicatorSequence(r.sequence)===1),replacementRows=latestRows.filter(r=>indicatorSequence(r.sequence)>1);
 const notes=(data.productionNotes?.length?data.productionNotes:data.corrections)||[],visibleNotes=notes.filter(note=>{if(!cutoff)return true;const raw=note.payload?.Data,when=typeof raw==='number'?new Date(Date.UTC(1899,11,30)+raw*86400000):new Date(raw||note.created_at||0);return when>=cutoff;}),pending=visibleNotes.filter(note=>!(note.correction_text||note.payload?.['Correção Efetuada']));
 const newApproved=newRows.filter(r=>r.status==='APROVADO').length,replacementApproved=replacementRows.filter(r=>r.status==='APROVADO').length,rejected=latestRows.filter(r=>r.status==='REPROVADO').length;
 $('indicator-kpis').innerHTML=[
  indicatorKpi('Ferramentas novas',newRows.length,'Sequência 1','new-tool'),
  indicatorKpi('Reposições',replacementRows.length,'Sequência 2 ou superior','replacement'),
  indicatorKpi('Aprovação · novas',`${indicatorPercent(newApproved,newRows.length)}%`,`${newApproved} de ${newRows.length} aprovadas`,'success'),
  indicatorKpi('Aprovação · reposições',`${indicatorPercent(replacementApproved,replacementRows.length)}%`,`${replacementApproved} de ${replacementRows.length} aprovadas`,'success'),
  indicatorKpi('Reprovações atuais',rejected,'Resultado mais recente','danger'),
  indicatorKpi('Correções pendentes',pending.length,`${visibleNotes.length-pending.length} já registradas`,'warning')
 ].join('');
 $('category-comparison').innerHTML=indicatorComparison('Ferramentas novas',newRows)+indicatorComparison('Reposições',replacementRows);
 const approved=latestRows.filter(r=>r.status==='APROVADO').length,review=latestRows.length-approved-rejected;
 $('status-distribution').innerHTML=`<div class="donut-wrap"><div class="donut" style="--approved:${indicatorPercent(approved,latestRows.length)};--rejected:${indicatorPercent(rejected,latestRows.length)}"><div><strong>${latestRows.length}</strong><span>sequências</span></div></div><div class="status-list"><div><span><i class="legend-approved"></i>Aprovadas</span><strong>${approved}</strong></div><div><span><i class="legend-rejected"></i>Reprovadas</span><strong>${rejected}</strong></div><div><span><i class="legend-review"></i>A revisar</span><strong>${review}</strong></div></div></div>`;
 const critical=new Map();
 latestRows.filter(r=>r.status==='REPROVADO').forEach(r=>{const row=critical.get(r.tool)||{tool:r.tool,rejected:0,pending:0,categories:new Set()};row.rejected++;row.categories.add(indicatorCategory(r.sequence));critical.set(r.tool,row);});
 pending.forEach(note=>{const row=critical.get(note.tool)||{tool:note.tool,rejected:0,pending:0,categories:new Set()};row.pending++;row.categories.add(indicatorCategory(note.sequence));critical.set(note.tool,row);});
 const ranked=[...critical.values()].sort((a,b)=>(b.rejected*2+b.pending)-(a.rejected*2+a.pending)||a.tool.localeCompare(b.tool,'pt-BR',{numeric:true})).slice(0,8);
 $('critical-tools').innerHTML=ranked.length?`<div class="critical-head"><span>Ferramenta</span><span>Categoria</span><span>Reprovações</span><span>Correções pendentes</span></div>${ranked.map(row=>`<div class="critical-row"><strong>${esc(row.tool)}</strong><span>${esc([...row.categories].join(' / '))}</span><b class="critical-number">${row.rejected}</b><b class="pending-number">${row.pending}</b></div>`).join('')}`:'<div class="empty">Nenhuma ferramenta crítica no período selecionado.</div>';
};
$('indicator-period').onchange=()=>window.renderIndicators();
