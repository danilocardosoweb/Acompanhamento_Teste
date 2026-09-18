const date=value=>value?new Date(value).toLocaleString('pt-BR'):'Não informado';
const value=(row,key,fallback='Não informado')=>row.metadata?.[key]||row[key]||fallback;
const templates={
 novo_teste:row=>`🧪 NOVO TESTE\n\nFerramenta: ${row.tool}\nTeste: ${value(row,'test')}\nResultado: ${row.event_status||'Não informado'}\nResponsável: ${row.responsible||'Não informado'}\nData: ${date(row.event_at)}`,
 ferramenta_aprovada:row=>`🟢 FERRAMENTA APROVADA\n\nFerramenta: ${row.tool}\nTeste: ${value(row,'test')}\nResponsável: ${row.responsible||'Não informado'}\nData: ${date(row.event_at)}`,
 ferramenta_reprovada:row=>`🔴 FERRAMENTA REPROVADA\n\nFerramenta: ${row.tool}\nTeste: ${value(row,'test')}\nMotivo: ${value(row,'reason')}\nResponsável: ${row.responsible||'Não informado'}\nData: ${date(row.event_at)}`,
 nova_correcao:row=>`🛠️ NOVA CORREÇÃO\n\nFerramenta: ${row.tool}\nCorreção realizada: ${value(row,'correction')}\nResponsável: ${row.responsible||'Não informado'}\nData: ${date(row.event_at)}`
};
function buildMessage(row){return templates[row.event_type]?.(row)||row.message;}
module.exports={buildMessage};
