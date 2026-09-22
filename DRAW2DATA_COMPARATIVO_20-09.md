# Análise comparativa do motor de cotas

Data da análise: 22/09/2026. Escopo: histórico público do GitHub e código local atual. Nenhuma regra do motor foi alterada nesta análise.

## Limite histórico: não há snapshot publicado em 20/09

Após atualizar `origin/main`, não foi encontrado commit datado de 20/09/2026. O ancestral público mais próximo antes desse dia é `bb76a66` (19/09 23:33, engine `3.0-spatial-lab`). O primeiro commit posterior que muda significativamente a seleção de cotas é `1a49cd1` (21/09 15:00, engine `4.0-strict-region-and-geometry-gate`); o HEAD público é `076fe7f` (21/09 15:06). O código local analisado contém ainda alterações não publicadas, etiquetadas `4.4-structural-dimension-association`.

Portanto, `bb76a66` é apenas a melhor aproximação pública disponível para a lembrança da versão de 20/09; não é possível provar que seja exatamente a versão usada naquele dia. A confiabilidade estimada em 80–90% também não pode ser confirmada sem um conjunto marcado de cotas corretas e incorretas.

## Comparação controlada disponível

Foram executadas versões em worktrees separados sobre os mesmos PDFs locais, com leitura completa, primeira página e cotas simples habilitadas. As contagens abaixo são leituras na lista principal e, quando existente, na lista de sugestões; não são precisão/recall porque ainda não existe ground truth rotulado para todos os itens.

| PDF | `bb76a66` (19/09, 3.0) | `1a49cd1` (21/09, 4.0) | local 4.4 observado |
|---|---|---|---|
| 19-0065 | 8 principais; inclui `5 ± 1,1`, que conflita com leitura separada `136,1`/`156 ± 1,1` e requer revisão | 6 principais, 10 sugestões; `156 ± 1,1` mantida, `136,1` mantida | manteve `156 ± 1,1`; divergências `136 ± 1,1`/`136,1` continuam para revisão |
| 42-0312 | 7 principais: `48,3 ± 0,36`, `1 ± 0,15`, `1,5`, `0,7`, `26`, `24`, `46,3 ± 0,78` | 12 principais, 11 sugestões; entre as principais apareceram `290`, `483`, `182`, `350`, `70` | 13 principais, 7 sugestões; além das leituras plausíveis, apareceu `446,3 ± 0,78` e raios candidatos `R7`, `R5`, `R23` que precisam de conferência visual |
| TBX-198 | 14 principais; inclui leituras manifestamente suspeitas como `120153 ± 15557,5` e `140 ± 15` | 7 principais, 17 sugestões; `140 ± 15` ainda aparece como principal | versão posterior separa vários itens de tabela, mas não foi usada aqui para estimar precisão sem revisar cada caixa no original |

O código antigo também errava: ele era mais enxuto no 42-0312, mas deixava falsos agrupamentos no TBX-198 e conflito em 19-0065. Isso impede declarar que a versão de 19/09 tinha “90% de precisão”. O padrão observado sustenta, contudo, que a alteração de 21/09 começou uma expansão relevante da lista principal e que a versão local atual voltou a deixar candidatos incertos na lista principal.

## O que provavelmente regrediu

### 1. A fila estrita foi afrouxada na passagem para a classificação por score

No commit 4.0, a saída principal era formada por `strict.accepted`; `strict.suggestions` ficava separada, com a mensagem de que eram leituras sem evidência geométrica suficiente. Na versão local 4.4, `eligible` inclui todo item cuja classe seja diferente de `NOT_DIMENSION`, portanto inclui também `REVIEW`. O gate estrito é executado depois, mas suas sugestões só são usadas para atribuir o status `REVISAR`; elas não saem de `result.dimensions`. Além disso, `result.suggestions` recebe somente `notDimensions`. A interface mostra `current.dimensions` como cotas e só apresenta `current.suggestions` em um painel separado. Assim, um número ambíguo com score intermediário reaparece visualmente como uma cota da lista, apesar de não ter passado pelo gate anterior.

Pontos de código local: `draw2data/processing.cjs`, seleção de `eligible` e construção de `result.dimensions`/`result.suggestions`; `draw2data.js`, renderização separada das listas.

### 2. Evidência geométrica fraca está sendo tratada como se fosse independente

`geometryEvidenceForCandidate` examina uma janela em volta do OCR e procura o maior traço horizontal/vertical. A janela começa em 24 pixels ou três vezes a caixa do texto. Uma linha longa próxima e alinhada pode ser contorno do perfil, borda de tabela, sublinhado ou moldura; não há teste topológico para demonstrar que seja uma linha de cota com duas terminações conectadas às linhas auxiliares.

Há ainda contagem duplicada: `compatibleAlignment` recebe exatamente o valor de `dimensionLine`, mas ambos entram como sinais separados em `geometrySignals`. `nearbyProfile` é ativado por densidade local de tinta acima de 1,2%, e não por identificação de uma curva do perfil. Com isso, uma mesma linha próxima e tinta de qualquer conteúdo podem fornecer múltiplos sinais geométricos correlacionados. O detector de seta procura pixels diagonais perto dos extremos estimados; não confirma de forma robusta pares de setas voltadas para o texto nem o término em linha auxiliar.

Uma reexecução instrumentada do 42-0312 confirma o caminho concreto: `446,3 ± 0,78` recebeu score 65, zona padrão `DRAWING_AREA`, único sinal geométrico `nearbyProfile=true`, sem linha de cota, alinhamento, seta ou extensão, e ainda entrou em `result.dimensions` como `REVIEW`. Sua caixa tinha 212 pontos de largura e deveria ser barrada pela regra de caixa excessiva do gate estrito; o gate marcou uma razão de exclusão, mas o item não saiu da lista principal. `46,3 ± 0,78` ficou com score 69 e também entrou sem linha, seta ou extensão: a densidade local + zona padrão já bastaram para revisão. `R5` atingiu score 84 porque a mesma linha contribuiu como `dimensionLine` e `compatibleAlignment`, somada à densidade de tinta, embora não houvesse seta nem linha auxiliar; a confiança OCR baixa baixou sua classe para `REVIEW`, mas não o retirou da tabela. Esses números mostram que o bug não é apenas uma hipótese: a transição do gate para o score deixou a fila de candidatos revisar no conjunto que a interface apresenta como cotas.

O resultado para `R` também não prova o destino: `leaderLine.target` é explicitamente `PROFILE_OR_CURVE_UNCONFIRMED`. A linha pode ser uma líder, mas não existe associação confiável com uma curva/feature CAD.

### 3. Zona desconhecida recebe uma pontuação positiva alta

O classificador usa `DRAWING_AREA` como zona padrão quando nenhuma região textual coincide. Depois, `zoneScore` atribui 1,0 tanto a `DRAWING_AREA` quanto a `DIMENSION_REGION`. Isso transforma “não consegui classificar a região” em evidência favorável à cota. Títulos e quadros convertidos em curvas, rótulos de embalagem ou textos sem extração vetorial não ativam as palavras-chave e podem continuar nessa zona padrão.

`groupingScore` também vira 1,0 quando não há `groupingConfidence`. “Sem medição” acaba contribuindo como confiança máxima. O score não deve premiar a falta de evidência.

### 4. O registro de evidências e o cálculo do score divergiram

As penalidades são adicionadas ao `decisionLog` com `weights` (como `TITLE_BLOCK`, `ADMINISTRATIVE_LABEL`, `ISOLATED_NUMBER`, `PARAGRAPH`). O score final, porém, é calculado com outra soma fixa de seis componentes; os pontos dos itens do `decisionLog` não são somados/subtraídos. Apenas algumas regras reaparecem como componentes/caps separados. Portanto o diagnóstico pode dizer que houve uma penalidade sem que a penalidade prevista tenha sido aplicada numericamente.

Na soma atual, uma leitura numérica pura já recebe `semanticScore = 0,62`; zona desconhecida recebe `zoneScore = 1`; agrupamento desconhecido recebe `groupingScore = 1`. Com OCR de boa confiança, a leitura já parte com score expressivo antes de evidência dimensional forte. Quando o sinal `dimensionLine` é detectado, seu alias `compatibleAlignment` e a densidade de tinta podem multiplicar a contribuição geométrica. Os limites 45 (REVIEW) e 75 (DIMENSION) só fazem sentido se os componentes forem independentes e calibrados; hoje não são.

### 5. Filtros de quadro/tabela viraram regiões informativas, sem exclusão efetiva

O fluxo 3.0 aplicava `titleBlockSelection.dimensions` diretamente antes da validação. Na versão 4.0 esse descarte rígido foi removido e substituído por zonas administrativas inferidas. Isso reduz risco de descartar dimensões próximas do quadro, mas depende de achar concentração de pelo menos quatro a cinco candidatos. No 4.0 observado, números como `290`, `483`, `182`, `350` e `70` passaram para a lista principal do 42-0312.

No código local 4.4, tanto `referenceTableSelection` como `titleBlockSelection` são calculados, mas `result.dimensions` segue para `flatBarSelection`, validação e classificação sem receber `referenceTableSelection.dimensions` ou `titleBlockSelection.dimensions`. As regiões geradas alimentam o score, não funcionam como filtro duro. Se a região for incompleta ou a penalidade não bastar, os candidatos continuam na lista.

### 6. A detecção ampliada elevou recall e falsos positivos ao mesmo tempo

Desde a camada experimental foram adicionadas recuperação de páginas esparsas, varredura por vizinhança, recortes expandidos, rotações OCR, recuperação de tolerância empilhada e varreduras especiais para tipos de perfil. Essas opções são úteis para cotas convertidas em curvas e desenhos esparsos, mas aumentam o universo de candidatos. O parse de um número (`25,40`) comprova apenas que o OCR encontrou texto de formato numérico, não que o texto esteja ligado a uma cota.

A etapa estrutural 4.4 acrescenta classificação de containers, prefixos suspeitos e notas, porém ainda é heurística local: `splitSuspiciousOCR` preserva o OCR original e normaliza o texto, mas não faz segmentação real de uma palavra OCR contaminada; prefixos só são sinalizados quando há evidência de token separado/container. Um único token `918,3` sem token/caixa interna distinguível não pode ser genericamente dividido com segurança.

## Regras antigas e novas: decisão

| Grupo | Recomendação |
|---|---|
| `titleBlockSelection` e gate de candidato | Recuperar o efeito de separar as exclusões da fila principal. Guardar o candidato excluído em sugestões/auditoria, não apagá-lo. Evitar “inferir” que qualquer número no desenho seja dimensão. |
| Filtro de tabela geral | Manter como região contextual; aplicar o resultado efetivamente ou enviar a candidatos excluídos. Marcar exceções onde a tabela de fato contém cotas do produto. |
| OCR expandido/rotações e leitura progressiva | Manter sob demanda para páginas com baixa cobertura ou leitura incompleta. Candidatos recuperados começam em revisão e não ganham pontos por terem sido encontrados em recorte ampliado. |
| Parser para `R`, `Ø`, `°`, rosca e chanfro | Manter como classificador semântico, nunca como validação suficiente. Exigir geometria compatível com o tipo. |
| Detector de linhas/setas atual | Não usar como evidência forte isolada. Recalibrar e substituir as alegações de “dimension line” por relações geométricas medidas e visualizáveis. |
| Callout/container e barreiras de merge | Manter como pista/barreira e preservar OCR bruto; não assumir que toda caixa/círculo é FEATURE_ID nem que todo prefixo numérico está isolado. |
| Score atual e classificação | Recalibrar após remover sinais duplicados e corrigir os efeitos do log. `DRAWING_AREA` desconhecido e agrupamento ausente devem ser neutros, nunca score positivo máximo. |
| Recuperação `PLAIN` ampliada | Não promover por formato/proximidade. Preservar como OCR encontrado e enviar para revisão somente quando o trecho estiver ligado a geometria dimensional. |

## O que a pesquisa técnica recomenda

O padrão dos trabalhos primários consultados é localizar/segmentar estruturas dimensionais e associar texto à geometria antes de confiar no OCR. Dori e Velkovitch descrevem separação texto-gráfico, reconhecimento de pares de setas e fios, agrupamento em caixas lógicas e verificação final do OCR contra medidas feitas no desenho. Isso é mais forte do que considerar uma linha próxima como “linha de cota”.

O trabalho eDOCr separa primeiro quadro de informações/tabelas, quadros GD&T e o restante; cada zona usa um fluxo OCR especializado e uma máscara colorida para conferência. O artigo reporta 90% de precisão e 90% de recall de detecção e F1 de 94% de reconhecimento no conjunto avaliado pelos autores; esses números não podem ser transferidos para nossos desenhos. O repositório tem reconhecimento separado para cotas e quadro informativo e expõe distância configurável de agrupamento.

A dissertação da TU Wien descreve segmentar entidades, criar candidatos de linhas de cota e filtrá-los em estágios; o OCR é aplicado aos números de dimensão detectados, e o valor OCR é comparado à razão entre comprimento da linha em pixels e valor nominal para ajudar a detectar erros OCR quando a escala é conhecida. A ferramenta open source `dimension-interpolation` também descreve classificação pela posição relativa entre setas, linhas e segmentos de texto. É referência conceitual; a licença AGPL exige avaliação antes de reutilizar código.

Referências primárias e projetos:

- Dori & Velkovitch, *Segmentation and Recognition of Dimensioning Text from Engineering Drawings* (1998): https://dovdori.technion.ac.il/wp-content/uploads/2022/04/SegmentationAndRecognitionOfDimensioningText.pdf
- Villena Toro, Wiberg & Tarkian, *Optical character recognition on engineering drawings to achieve automation in production quality control* (2023): https://www.frontiersin.org/journals/manufacturing-technology/articles/10.3389/fmtec.2023.1154132/full
- Riegelnegg, TU Wien, *Automated Extraction of Complexity Measures from Engineering Drawings* (2024): https://www.cg.tuwien.ac.at/research/publications/2024/riegelnegg-2024-aeo/
- Código de referência `dimension-interpolation` (Fachhochschule Dortmund): https://github.com/fargrat/dimension-interpolation
- Código eDOCr (Linköping University): https://github.com/javvi51/eDOCr

## Arquitetura recomendada para recuperar precisão

1. **Inventário do documento:** extrair texto vetorial e primitivas PDF quando existirem; renderizar imagem preservada para os PDFs rasterizados ou com cotas em curvas. Manter texto, curvas, áreas, cor e fonte como evidências separadas.
2. **Segmentação semântica de página/vistas:** localizar perfil técnico, embalagem, controle de produção, tabelas, carimbo e notas. Palavras do título ajudam, mas limites e estrutura visual também devem ser usados. Não excluir um painel “controle de produção” apenas pelo nome; nele podem existir cotas válidas.
3. **Geração de candidatos geométricos:** detectar pares de pontas/setas, linha de dimensão, linhas auxiliares e/ou leader com ponto de contato. Preferir formar o conjunto geométrico primeiro; quando for necessário OCR-first, exigir que a caixa de texto se associe a um conjunto geométrico candidato.
4. **OCR direcionado:** ler somente caixas candidatas dimensionais com alfabeto técnico e preservar todas as leituras alternativas, caixas e tokens. A leitura numérica nunca vira dimensão só pelo regex.
5. **Grafo de associação:** nós distintos `OCR_TEXT`, `DIMENSION_LINE`, `EXTENSION_LINE`, `ARROWHEAD`, `LEADER`, `CONTAINER`, `PROFILE_CURVE`, `TABLE`, `NOTE` e `VIEW`; arestas com distância, alinhamento, ângulo, endpoint e zona. Uma cota precisa ter relação rastreável com a linha/líder e as terminações adequadas.
6. **Validador de decisão:** camadas diferentes para `OCR_TEXT_FOUND`, `DIMENSION_CANDIDATE`, `DIMENSION_CONFIRMED` e `REVIEW`. Score calibrado contra exemplos rotulados; nenhum score sozinho substitui restrições obrigatórias. Só `DIMENSION_CONFIRMED` entra em campos dimensionais; candidatos de baixa confiança ficam na fila de revisão e não se misturam com texto encontrado.

## Exemplos de regras de validação

- Número sem símbolo ou tolerância: só candidato dimensional se associado a linha de cota com alinhamento coerente e evidência de terminações/linhas auxiliares; caso contrário, OCR encontrado → revisão ou não-cota.
- Tolerância empilhada: nominal e tolerâncias devem ter mesmo eixo, caixas compatíveis, pequena distância vertical, sequência semântica válida e associação à mesma dimensão; vedado juntar por proximidade apenas.
- Raio: `R` + valor podem constituir texto de raio, mas só confirmar quando uma leader line termina no arco/curva correto. Balão/callout perto do texto é barreira, não parte do valor.
- Angular/diâmetro: símbolo técnico deve concordar com o tipo de geometria/leader; OCR `°` ou `Ø` por si só não prova a relação.
- Nota/tabela/carimbo: região classificada como administrativa bloqueia promoção automática. Cota válida que caia perto da fronteira exige geometria explícita para ser recuperada.
- Conflito ou OCR suspeito: preservar valor bruto + alternativas + caixas; enviar à revisão, nunca corrigir prefixo ou tolerância silenciosamente.
- Feedback: exclusão/correção do usuário deve fornecer verdade de referência para recalibrar, mas apenas depois de manter a versão do motor e caixa original para auditoria.

## Plano incremental, sem reescrita

1. **Congelar uma linha de base:** manter o código atual em branch/commit sem substituir histórico; registrar PDFs e parâmetros de execução. Procurar no checkpoint/backups de 20/09 um snapshot exato, pois o GitHub não o contém.
2. **Construir um conjunto-ouro pequeno:** marcar caixas verdadeiras e falsas nos 4 PDFs já usados (19-0065, 42-0312, DIN-005, TBX-198), separando perfil, embalagem, controle de produção, tabela e carimbo. Medir precisão e falsos positivos por página, além do recall.
3. **Reproduzir o 4.0 e 4.4:** preservar JSON bruto dos candidatos, score, região e geometria; comparar caixa a caixa com as marcações. O teste repetível substitui contagens manuais.
4. **Hotfix de fluxo, isolado e testável:** reaplicar filtros de tabela/quadro onde há evidência forte e corrigir roteamento para que `REVIEW` e itens do gate não apareçam como cotas confirmadas. Continuam visíveis na revisão, com rótulo correto e sem entrar automaticamente na base.
5. **Recalibrar a geometria:** deduplicar `dimensionLine`/`compatibleAlignment`, neutralizar zona desconhecida e grouping ausente, exigir sinais independentes. Trocar o “traço longo perto” por detecção e associação visual de pares de terminações/auxiliares ou líder→curva.
6. **Ativar uma mudança por vez:** rodar os quatro desenhos e um cenário sintético por alteração; falha em precision bloqueia a mudança. Guardar relatórios por versão e comparar falsos positivos, falsos merges, falsos negativos e cotas enviadas à revisão.
7. **Expandir após estabilidade:** aumentar amostra e incluir variações de cor (azul/preto), digitalização, múltiplos painéis e cotas sem tolerância. Só então calibrar limiares de produção; não fixar percentuais sem ground truth representativo.

### Conclusão técnica

A regressão mais bem sustentada não é “OCR ficou pior” isoladamente. O pipeline ampliou a busca, removeu o uso rígido de filtros e alterou a semântica da saída: sinais fracos e correlacionados foram contados como geometria e todo resultado `REVIEW` continuou na tabela principal. Ao mesmo tempo, a associação não confirma a topologia de setas/linhas/líder até o perfil. O primeiro passo de recuperação deve reestabelecer a separação entre texto encontrado, sugestão/revisão e dimensão confirmada, corrigindo a passagem dos filtros antes de mexer em pesos ou acrescentar exceções.

## Adendo: reprodução específica do TP-8371 e evidência de 19/09

Os screenshots fornecidos depois da análise inicial mostram o caso `TP-8371.pdf`. Eles são evidência mais direta do que os outros quatro PDFs usados como amostra e refinam o diagnóstico: o motor atual não só gera falsos positivos; também está escondendo dimensões verdadeiras na categoria de sugestões e deixando ao menos um texto de quadro técnico na lista principal.

### O que foi reproduzido

O PDF local `U:\TP-8371.pdf` foi processado com uma página, modo completo, no código local 4.4. O resultado coincide com os screenshots: 36 leituras no diagnóstico, quatro na tabela principal e 32 sugestões. A lista principal contém `1,3 ± 0,15`, `1,5 ± 0,15`, `1,6 ± 0,15` e `93`. A imagem do próprio PDF mostra `93` no campo `DCC` do quadro técnico, portanto é falso positivo. O motor deu score 74 a esse texto e classificou sua região como `DIMENSION_REGION`; o OCR estava 95% confiante de que leu os caracteres `93`, mas isso não valida que seja uma cota.

Várias leituras que parecem corresponder a dimensões desenhadas — entre elas `8,2 ± 0,3`, `13,4 ± 0,3`, `90`, `18,4`, `36,81`, `30`, `16`, `65` e `6,4` — aparecem na coleção de sugestões. Isso é coerente com o problema de roteamento já identificado: a tela principal é pequena demais e o usuário precisa abrir a lista de sugestões para recuperar cotas que o OCR de fato encontrou. A presença de algumas sugestões pode ser correta como revisão, mas agrupá-las sob “não-cota/des­cartadas” oculta a diferença entre “provável cota com baixa confiança” e “texto informativo”.

Há uma diferença adicional entre o screenshot e a reprodução atual: no screenshot, a linha `93` é exibida com 95% de confiança OCR e a contagem mostra zero aceitas, quatro em revisão e 32 descartadas. A reprodução local atual confirma 95% para `93`, mas `dimensionScore` é 74. Isso mostra que a coluna de confiança visível não deve ser interpretada como confiança de que o elemento seja uma cota; são métricas distintas.

### Limite importante da comparação histórica

O GitHub não contém um commit exatamente datado de 20/09 que corresponda à descrição. O snapshot público mais próximo de 19/09 é `bb76a66` (23:33); o engine local `3.0-spatial-lab`, no checkout `88bdbb4` (19/09 às 13:32), também foi executado contra o mesmo PDF. Ambos são reprodutíveis, mas nenhum comprova literalmente o resultado perfeito relatado pelo usuário: o snapshot público produziu 20 candidatos principais e o checkout local produziu 21 leituras em revisão, inclusive duplicatas e leituras que exigiriam inspeção visual. Portanto não é correto afirmar que o código GitHub disponível é a mesma build/configuração que encontrou todas as cotas sem erro. A análise perfeita observada pode ter vindo de outro estado local, configuração ou revisão manual, não preservados no histórico/checkpoint encontrado.

Essa ressalva não invalida o relato do usuário. Significa que ainda não temos o artefato histórico exato para atribuir a diferença a um commit específico. O resultado observado pelo usuário deve ser tratado como referência funcional, mas a lista anotada/saída da execução de 19/09 precisa ser recuperada antes de se declarar paridade numérica.

### Diagnóstico refinado para esse perfil

1. **Perda de recuperação na saída:** 32 candidatos não aparecem na lista principal; boa parte são números em cotas visíveis no desenho. A tabela precisa refletir “cota confirmada” versus “candidata a revisar” sem esconder as candidatas, e as sugestões não podem ser tratadas como texto definitivamente rejeitado.
2. **Falso positivo no quadro:** `93` vem do campo DCC. A seleção de filtros do quadro/tabela reporta `titleBlockFilter.applied=false`, zero leituras excluídas e nenhuma região; ao mesmo tempo, o classificador atribui ao `93` uma região dimensional. O filtro de quadro não protegeu esse caso.
3. **Zonas contraditórias ou excessivamente fragmentadas:** as regiões dimensionais são inferidas de traços locais. No PDF, bordas de tabela e linhas do quadro podem criar regiões pequenas perto dos próprios campos, fazendo conteúdo administrativo parecer geometricamente associado a dimensão.
4. **Confiança OCR confundida com validação:** texto `93` lido com alta confiança recebe confiança visual alta, embora a evidência dimensional seja fraca. A interface deve nomear e exibir separadamente a qualidade do OCR e a confiança de classificação dimensional.
5. **A versão de 19/09 a localizar ainda é uma questão aberta:** a execução reproduzível de `3.0-spatial-lab` não corresponde por si só à análise perfeita descrita. Antes de recuperar regras às cegas, deve-se achar o resultado exportado, backup ou checkout usado naquela execução.

### Ajuste de prioridade

Para corrigir este caso sem reescrever o motor, primeiro registrar como verdade de referência as caixas de todas as cotas do perfil TP-8371 e as zonas administrativas (incluindo `DCC 93`), usando a análise de 19/09 como fonte se ela puder ser recuperada. Depois, corrigir a transferência entre lista principal e sugestões e aplicar efetivamente o bloqueio de quadro técnico. O `93` deve permanecer como texto OCR auditável, mas nunca ser promovido a cota sem evidência geométrica independente ligada à geometria do produto. Candidatos de baixa confiança e plausíveis devem continuar acessíveis para revisão manual, em uma categoria distinta de “descartados”.

Não foi feita alteração no motor nesta etapa: os dados históricos disponíveis não demonstram qual regra isolada reproduzia a análise perfeita, então mexer em thresholds agora arriscaria ajustar contra uma baseline incorreta. A próxima validação deve comparar o TP-8371 caixa a caixa, com contagem de cotas recuperadas, textos indevidos promovidos, duplicatas e candidatos legítimos encaminhados à revisão.
