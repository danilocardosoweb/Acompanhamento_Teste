window.CorrectionKnowledge=(()=>{
 const actions=[
  ['bearing-reduzir','Bearing','Reduzir bearing','Redução do comprimento do bearing','Acelerar o fluxo local','Alto'],
  ['bearing-aumentar','Bearing','Aumentar bearing','Aumento ou reconstrução do comprimento do bearing','Frear o fluxo local','Alto'],
  ['bearing-equalizar','Bearing','Equalizar bearings','Equalização dos bearings entre regiões equivalentes','Equalizar o fluxo','Alto'],
  ['bearing-polir','Bearing','Polir bearing','Polimento localizado do bearing, preservando a geometria ativa','Corrigir a superfície','Médio'],
  ['bearing-choke','Bearing','Fazer choke','Aplicação de choke na entrada do bearing','Frear o fluxo local','Alto'],
  ['bearing-relief','Bearing','Fazer relief','Aplicação de relief na saída do bearing','Acelerar o fluxo local','Alto'],
  ['pocket-abrir','Pocket/Feeder','Abrir pocket','Abertura localizada do pocket','Aumentar a alimentação local','Alto'],
  ['pocket-balancear','Pocket/Feeder','Balancear alimentação','Balanceamento do pocket ou feeder entre regiões','Equalizar a alimentação','Alto'],
  ['porthole-abrir','Porthole','Abrir porthole','Abertura do porthole correspondente','Aumentar a alimentação local','Crítico'],
  ['porthole-balancear','Porthole','Balancear portholes','Balanceamento da alimentação entre portholes','Equalizar o fluxo','Crítico'],
  ['mandril-centralizar','Mandril','Centralizar mandril','Centralização do mandril em relação ao cap','Corrigir a geometria e distribuição de parede','Crítico'],
  ['dimensional-abrir','Dimensional','Abrir medida','Abertura localizada da medida do perfil','Corrigir a dimensão','Alto'],
  ['dimensional-fechar','Dimensional','Fechar medida','Fechamento localizado da medida do perfil','Corrigir a dimensão','Alto'],
  ['superficie-polir','Superfície','Polir ferramenta','Polimento localizado da superfície ativa','Corrigir a superfície','Médio'],
  ['superficie-pickup','Superfície','Remover pickup','Remoção de alumínio aderido e acabamento da região','Corrigir a superfície','Médio'],
  ['apoio-ajustar','Apoio','Ajustar apoio','Ajuste do conjunto de apoio e alinhamento','Aumentar o suporte','Alto'],
  ['solda-recuperar','Solda/Recuperação','Adicionar solda','Recuperação localizada por solda','Recuperar desgaste ou geometria','Crítico'],
  ['tratamento-nitretar','Tratamento','Enviar para nitretação','Encaminhamento da ferramenta para nitretação','Recuperar a condição superficial','Médio'],
  ['manutencao-limpar','Manutenção','Limpar e inspecionar','Limpeza e inspeção técnica da região afetada','Remover interferências e confirmar a causa','Baixo'],
  ['outro','Outro','Outra correção','Correção personalizada','Efeito definido pelo responsável','Variável']
 ].map(([id,family,name,phrase,effect,risk])=>({id,family,name,phrase,effect,risk}));
 const byId=id=>actions.find(action=>action.id===id);
 function suggest(problem){const text=String(problem||'').toLocaleUpperCase('pt-BR'),ids=[];const add=(...values)=>values.forEach(v=>!ids.includes(v)&&ids.push(v));
  if(/ADIANT|CORRIDA/.test(text))add('bearing-choke','bearing-aumentar','pocket-balancear','apoio-ajustar');
  if(/ATRAS/.test(text))add('bearing-reduzir','bearing-relief','pocket-abrir','porthole-abrir');
  if(/DIMENSION|COTA|MEDIDA|ABERT|FECHAD/.test(text))add('dimensional-abrir','dimensional-fechar','bearing-equalizar');
  if(/RISCO|RUGOS|LINHA|ARRANC|PICKUP|SUJEIRA|INCLUS/.test(text))add('superficie-pickup','superficie-polir','bearing-polir','manutencao-limpar');
  if(/ONDA|ONDUL|TORÇ|TORC|ESQUADRO|PLANIC/.test(text))add('bearing-equalizar','pocket-balancear','apoio-ajustar');
  if(/PAREDE|MANDRIL|TUBULAR/.test(text))add('mandril-centralizar','porthole-balancear','apoio-ajustar');
  if(!ids.length)add('manutencao-limpar','bearing-polir','bearing-equalizar','outro');return ids.slice(0,4).map(byId);
 }
 return {actions,byId,suggest};
})();
