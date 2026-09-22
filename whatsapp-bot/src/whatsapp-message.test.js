const assert=require('node:assert/strict');
const {buildMessage,buildSummaryMessage}=require('./messageTemplates');
const {buildMonthlySummary}=require('./summary');

const email=buildMessage({event_type:'ferramenta_reprovada',tool:'TP-8371',event_status:'REPROVADO',event_at:'2026-09-22T15:00:00Z',metadata:{test:'24',subject:'Resultado do ensaio',emailBody:'<p>Reprovado por rebarba acima do limite.</p><p>Favor corrigir.</p>'}});
assert.match(email,/FERRAMENTA REPROVADA/);
assert.match(email,/TP-8371/);
assert.match(email,/Reprovado por rebarba acima do limite\./);
assert.doesNotMatch(email,/<p>/i);

const records=[
 {tool:'TP-8371',sequence:1,status:'REVISAR',received:'2026-09-01T10:00:00-03:00'},
 {tool:'TP-8371',sequence:1,status:'APROVADO',received:'2026-09-22T10:00:00-03:00'},
 {tool:'DV-0795',sequence:2,status:'APROVADO',received:'2026-09-15T10:00:00-03:00'},
 {tool:'DV-0795',sequence:2,status:'REPROVADO',received:'2026-09-20T10:00:00-03:00'},
 {tool:'EX-909',sequence:1,status:'APROVADO',received:'2026-08-31T10:00:00-03:00'}
];
const summary=buildMonthlySummary(records,new Date('2026-09-22T12:00:00-03:00'));
assert.equal(summary.approved,2);
assert.equal(summary.rejected,1);
assert.equal(summary.approvedThisMonth.length,2);
assert.equal(summary.approvedThisMonth[0].tool,'TP-8371');
assert.equal(summary.notApproved.length,1);
assert.equal(summary.notApproved[0].tool,'DV-0795');
const digest=buildSummaryMessage(summary,new Date('2026-09-22T12:00:00-03:00'));
assert.match(digest,/APROVADAS NESTE MÊS/);
assert.match(digest,/AINDA NÃO APROVADAS/);
assert.match(digest,/TP-8371/);
assert.match(digest,/DV-0795/);
console.log('WhatsApp message and monthly digest: OK');
