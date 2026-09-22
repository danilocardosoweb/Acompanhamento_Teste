function parseDate(value){if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?null:date;}
function dayLabel(value){const date=parseDate(value);return date?date.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}):'—';}
function buildMonthlySummary(records=[],now=new Date()){
 const rows=Array.isArray(records)?records:[],latest=new Map();
 const ordered=[...rows].sort((a,b)=>(parseDate(b.received||b.testDate)?.getTime()||0)-(parseDate(a.received||a.testDate)?.getTime()||0));
 for(const row of ordered){const tool=String(row.tool||'').trim(),sequence=String(row.sequence||'').trim(),key=`${tool.toUpperCase()}|${sequence}`;if(tool&&!latest.has(key))latest.set(key,row);}
 const current=[...latest.values()],month=now.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'});
 const receivedMonth=row=>{const date=parseDate(row.received||row.testDate);return date?date.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'}):'';};
 const approvals=new Map();
 for(const row of [...rows].sort((a,b)=>(parseDate(b.received||b.testDate)?.getTime()||0)-(parseDate(a.received||a.testDate)?.getTime()||0))){
  const key=`${String(row.tool||'').trim().toUpperCase()}|${String(row.sequence||'').trim()}`;
  if(String(row.status||'').toUpperCase()==='APROVADO'&&receivedMonth(row)===month&&!approvals.has(key))approvals.set(key,row);
 }
 const approvedThisMonth=[...approvals.values()].map(row=>({tool:row.tool||'Ferramenta não identificada',sequence:row.sequence||'—',date:dayLabel(row.received||row.testDate)}));
 const notApproved=current.filter(row=>String(row.status||'').toUpperCase()!=='APROVADO')
  .sort((a,b)=>(parseDate(b.received||b.testDate)?.getTime()||0)-(parseDate(a.received||a.testDate)?.getTime()||0))
  .map(row=>({tool:row.tool||'Ferramenta não identificada',sequence:row.sequence||'—',status:['REPROVADO','REVISAR'].includes(String(row.status||'').toUpperCase())?String(row.status).toUpperCase():'REVISAR',date:dayLabel(row.received||row.testDate)}));
 const count=status=>current.filter(row=>String(row.status||'').toUpperCase()===status).length;
 return {month,monthLabel:now.toLocaleDateString('pt-BR',{month:'long',year:'numeric',timeZone:'America/Sao_Paulo'}),tools:new Set(current.map(row=>String(row.tool||'').trim().toUpperCase()).filter(Boolean)).size,sequences:current.length,approved:count('APROVADO'),rejected:count('REPROVADO'),review:count('REVISAR'),approvedThisMonth,notApproved};
}
module.exports={buildMonthlySummary};
