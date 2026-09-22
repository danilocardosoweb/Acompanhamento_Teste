const date=value=>value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Não informado';
const value=(row,key,fallback='Não informado')=>row.metadata?.[key]||row[key]||fallback;
const statusLabel=value=>({APROVADO:'APROVADO',REPROVADO:'REPROVADO',REVISAR:'EM REVISÃO'}[String(value||'').toUpperCase()]||'EM REVISÃO');
function plainText(input){
 let text=String(input??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
  .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi,'\n').replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
  .replace(/\r/g,'').split('\n').map(line=>line.replace(/[\t ]+/g,' ').trim()).filter(Boolean).join('\n').trim();
 const end=text.search(/\n(?:De:|From:|Enviado em:|Sent:|-----Mensagem original-----|Em .{5,100} escreveu:)/i);
 if(end>=0)text=text.slice(0,end).trim();
 return text.length>900?`${text.slice(0,897).trimEnd()}…`:text;
}
function eventMessage(row,heading){
 const status=statusLabel(row.event_status||row.metadata?.status),body=plainText(row.metadata?.emailBody||row.metadata?.email_body||row.metadata?.body||row.message||row.metadata?.reason);
 const subject=plainText(row.metadata?.subject||'');
 const details=[
  `*Ferramenta:* ${row.tool||'Não identificada'}`,
  `*Status:* ${status}`,
  `*Teste:* ${value(row,'test')}`,
  row.responsible?`*Responsável:* ${row.responsible}`:null,
  `*Recebido:* ${date(row.event_at)}`,
  subject?`*Assunto:* ${subject}`:null,
  body?`*Informação do e-mail:*\n${body}`:null
 ].filter(Boolean).join('\n');
 return `${heading}\n\n${details}\n\n_Atualização automática do Controle da Qualidade_`;
}
const templates={
 novo_teste:row=>eventMessage(row,'📥 *NOVA ANÁLISE RECEBIDA*'),
 ferramenta_aprovada:row=>eventMessage(row,'🟢 *FERRAMENTA APROVADA*'),
 ferramenta_reprovada:row=>eventMessage(row,'🔴 *FERRAMENTA REPROVADA*'),
 nova_correcao:row=>`🛠️ *NOVA CORREÇÃO REGISTRADA*\n\n*Ferramenta:* ${row.tool||'Não identificada'}\n*Correção:* ${plainText(value(row,'correction'))}\n*Responsável:* ${row.responsible||'Não informado'}\n*Data:* ${date(row.event_at)}\n\n_Atualização automática do Controle da Qualidade_`
};
function buildMessage(row){return templates[row.event_type]?.(row)||plainText(row.message)||'Atualização do Controle da Qualidade.';}
function buildSummaryMessage(summary={},createdAt=new Date()){
 const month=summary.monthLabel||new Date(createdAt).toLocaleDateString('pt-BR',{month:'long',year:'numeric',timeZone:'America/Sao_Paulo'});
 const approved=(summary.approvedThisMonth||[]).slice(0,20).map(item=>`• ${item.tool}${item.sequence&&item.sequence!=='—'?` · Seq. ${item.sequence}`:''} · ${item.date||'data não informada'}`);
 const pending=(summary.notApproved||[]).slice(0,20).map(item=>`• ${item.status==='REPROVADO'?'🔴':'🟠'} ${item.tool}${item.sequence&&item.sequence!=='—'?` · Seq. ${item.sequence}`:''} · ${statusLabel(item.status)}${item.date?` · ${item.date}`:''}`);
 const overflow=(items)=>items.length>20?`\n• e mais ${items.length-20} registro(s)`:'';
 return [
  `📊 *ACOMPANHAMENTO DA QUALIDADE*`,
  `*Resumo de ${month}* · atualizado ${date(createdAt)}`,
  `Ferramentas: ${summary.tools||0} · Sequências: ${summary.sequences||0}`,
  `🟢 Aprovadas: ${summary.approved||0} · 🔴 Reprovadas: ${summary.rejected||0} · 🟠 Em revisão: ${summary.review||0}`,
  '',
  `🟢 *APROVADAS NESTE MÊS (${(summary.approvedThisMonth||[]).length})*`,
  approved.length?approved.join('\n'):'• Nenhuma aprovação registrada neste mês.',
  overflow(summary.approvedThisMonth||[]),
  '',
  `📌 *AINDA NÃO APROVADAS (${(summary.notApproved||[]).length})*`,
  pending.length?pending.join('\n'):'• Todas as sequências atuais estão aprovadas.',
  overflow(summary.notApproved||[]),
  '',
  '_Resumo automático do Controle da Qualidade_'
 ].filter(Boolean).join('\n');
}
module.exports={buildMessage,buildSummaryMessage,plainText};
