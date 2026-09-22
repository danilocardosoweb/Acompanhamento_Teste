# DRAW2DATA — pesquisa técnica

Data da análise: 18/09/2026

Este documento registra o que foi verificado nos projetos citados e o que pode ser aproveitado no DRAW2DATA. A pesquisa serve como referência de arquitetura; nenhum código externo foi copiado para o projeto.

## Referências verificadas

### cadRip

Repositório: [zackska/cadRip](https://github.com/zackska/cadRip)

O projeto combina `pdfplumber` para texto vetorial, agrupamento espacial de palavras, EasyOCR e SIFT/OpenCV para símbolos. A separação entre `ripNumericDims`, `ripSymbolDims` e `cleanDims` é um bom modelo para manter pipelines independentes. Os conceitos reaproveitáveis são:

- normalizar palavras do PDF com coordenadas antes de interpretar o texto;
- agrupar palavras por linha usando tolerância em X/Y;
- separar dimensões numéricas de dimensões ancoradas em símbolos;
- guardar visualizações anotadas para revisão humana;
- aplicar filtros de confiança e proporção numérica antes de aceitar OCR.

O código do cadRip está sob GPL-3.0. Por isso, a implementação do DRAW2DATA deve continuar independente e usar apenas os conceitos; copiar funções ou incorporar trechos exigiria uma revisão de licenciamento e das obrigações de distribuição.

### eDOCr

Repositório: [LiUAutomationLab/eDOCr](https://github.com/LiUAutomationLab/eDOCr)

O eDOCr separa quadro de informações, GD&T e dimensões por pipelines próprios. O README mostra alfabetos/modelos específicos para dimensões, bloco de informações e símbolos GD&T, incluindo `±`, `°`, `⌀` e caracteres de tolerância. Os conceitos reaproveitáveis são:

- usar alfabetos técnicos restritos por tipo de região;
- tratar quadro/carimbo como uma região distinta do desenho;
- manter bounding boxes e máscaras de saída para auditoria;
- configurar o limiar de agrupamento como parâmetro, não como regra fixa;
- permitir treinamento futuro para o padrão de desenho real da empresa.

O repositório declara licença MIT, mas os modelos, fontes e dependências devem ser conferidos separadamente antes de distribuição.

### PaddleOCR Engineering Drawings

Repositório: [thedatasense/PaddleOCR_Engineering_Drawings](https://github.com/thedatasense/PaddleOCR_Engineering_Drawings)

O projeto usa uma cadeia `PDF → imagem → PaddleOCR-VL → Qwen → JSON`. É uma referência útil para metadados (número, material, acabamento, descrição e empresa), saída estruturada e preservação do OCR bruto. Não deve ser o mecanismo principal de cotas na primeira versão: o próprio fluxo depende de modelos grandes, baixa latência não é garantida e a interpretação por LLM pode introduzir valores não rastreáveis. O README informa download inicial de modelos de aproximadamente 2 GB e processamento de cerca de 0,5 a 2 minutos por página em seu ambiente de teste.

### ezdxf

Repositório: [mozman/ezdxf](https://github.com/mozman/ezdxf)

Para DXF, a estratégia correta é ler entidades CAD diretamente. O pacote suporta leitura e alteração de DXF e expõe entidades `DIMENSION`, `TEXT` e `MTEXT`. A entidade `DIMENSION` pode depender de um bloco anônimo para sua representação visual, portanto a extração deve guardar tanto o valor da entidade quanto a geometria associada quando disponível.

## Comparação com a Fase 1 atual

O módulo atual já possui uma base correta para evoluir: leitura de PDF vetorial, coordenadas por item, identificação da ferramenta, tolerâncias explícitas, confiança, revisão manual e exportação rastreável. O ponto que ainda falta para desenhos reais é deixar de procurar apenas regex no texto corrido e passar a trabalhar com regiões e relações espaciais.

Também é importante tratar o resultado mostrado na interface como uma conferência obrigatória. Uma cota detectada precisa manter `rawText`, nominal, tolerâncias, página e bounding box preenchidos; se qualquer campo estiver vazio, o registro deve ser marcado como `REVISAR`, nunca como confirmado.

## Recomendação de evolução

1. **Fase 2 — parser espacial vetorial:** preservar todos os itens do PDF, agrupar por linha/bloco e excluir carimbo, legenda e notas antes da regex.
2. **Fase 3 — símbolos e GD&T:** reconhecer `⌀`, `R`, `°`, profundidade e símbolos de tolerância, sempre com bounding box e confiança.
3. **Fase 4 — OCR sob demanda:** rasterizar somente páginas sem texto útil ou regiões selecionadas; usar OCR especializado com revisão visual.
4. **Fase 5 — DXF:** adicionar leitor separado para `DIMENSION`, `TEXT` e `MTEXT`, sem misturar a semântica do PDF.
5. Metadados de material e processamento por LLM estão fora do escopo solicitado.

## Decisão

Não instalar cadRip, eDOCr ou PaddleOCR diretamente no app neste momento. Eles introduziriam runtimes Python, modelos pesados e custos operacionais incompatíveis com a Fase 1. A próxima alteração recomendada é implementar o parser espacial vetorial dentro do módulo isolado, com um conjunto de PDFs reais da Tecnoperfil para validação e uma tela de revisão que mostre a posição da cota no desenho.

## Implementação realizada nesta etapa

O detector foi evoluído com uma estratégia espacial própria inspirada nos conceitos do cadRip: os itens de texto do PDF são ordenados por posição, agrupados por linha, analisados com tolerâncias simétricas ou assimétricas e preservados com símbolo, bounding box e confiança. Existe fallback para texto corrido quando o PDF não fornece agrupamento de linhas utilizável. Não foi incorporado código, modelo ou runtime Python de terceiros.

Essa validação anterior utilizou um relatório dimensional da TP-8377, não o desenho original. Portanto, ela não demonstrava que o motor conseguia ler as cotas do desenho.

## Correção validada com o desenho original — 18/09/2026

O arquivo da área de trabalho TP-8377.pdf contém 47 itens de texto, mas são notas e tabela de tolerâncias gerais. As cotas azuis são conteúdo gráfico, invisível à extração textual. A existência de texto no PDF não basta para dispensar OCR.

Foi implementado fallback local com Tesseract.js quando a extração vetorial não encontra cotas: renderização a 360 dpi, isolamento de traços azuis quando presentes, remoção de linhas longas, leitura em duas orientações, verificação visual do símbolo ± e releitura separada de nominal e tolerância. Dois reconhecedores comparam as leituras; divergências sem suporte ficam vazias para revisão. Não foram integrados eDOCr, cadRip ou LLM. Os conceitos de regiões e coordenadas são implementados no módulo próprio.

O desenho original foi enviado pela interface do app e retornou 12 candidatos, incluindo 132 ±0,86 na vertical. Todos permanecem em revisão. A tolerância da cota 3 fica vazia devido à interferência de uma seta; 5,8 não possui tolerância explícita. O teste de regressão recebe o PDF original por argumento, verifica nominais, campos incertos, coordenadas e exportação Excel. Nenhum valor esperado desse desenho está embutido no motor.

O desenho original pode ser aberto junto aos resultados para conferência. Na primeira execução há download dos modelos de OCR; o documento é processado localmente. O cache de modelos não entra no Git. Limites: 25 MB por arquivo, até 10 páginas no OCR e 32 milhões de pixels por página. O fallback atual é acionado quando o documento inteiro não produz cotas vetoriais; documentos mistos com extração parcial e outros padrões de desenho ainda exigem validação específica. OCR não garante que todas as cotas de qualquer desenho serão encontradas.

Também foi removida a busca em texto corrido que associava números de colunas diferentes. Pares numéricos sem símbolo explícito não recebem tolerâncias presumidas.

## Separação de áreas — exemplos de produção — 21/09/2026

Foram conferidos visualmente e por extração de estrutura os PDFs `19-0065.pdf`, `42-0312.pdf`, `DIN-005.PDF` e `TBX-198.pdf`. Esses quatro arquivos têm texto pesquisável e objetos vetoriais; não são digitalizações. Porém, as cotas numéricas estão desenhadas como curvas, então a leitura híbrida (OCR + estrutura/texto do PDF) continua necessária.

A inspeção encontrou uma falha de coordenadas: os itens de texto eram mantidos no sistema bruto do PDF, que em páginas rotacionadas não coincide com as coordenadas da página renderizada usadas pelo OCR. Isso desalinhava os filtros de carimbo e as cotas. O leitor agora transforma os quatro cantos de cada item pelo viewport real do PDF.js e guarda caixas na mesma orientação e unidade da imagem, com origem inferior consistente com o OCR. Nos quatro exemplos, todos os itens textuais ficaram dentro dos limites da página após a transformação.

Também foi criado um filtro espacial inicial para tabelas gerais que tenham cabeçalhos vetoriais próximos de `Faixa`, `Tolerância` e `(mm)`. Ele remove candidatos de OCR que caiam na área da tabela e registra a região no diagnóstico; cotas de perfil fora dela são preservadas. O teste cobre a tabela presente em TBX-198. Essa regra é uma barreira específica para tabelas e não substitui a futura classificação de painéis de embalagem, controle de produção e desenho técnico.

A cota `156±1,1` do desenho de controle de produção em 19-0065 deve continuar elegível: “controle de produção” não é, por si só, uma área excluída. Embalagem, tabela e carimbo devem ser rotulados espacialmente, enquanto cotas de vistas técnicas e de controle permanecem como candidatas. Itens com evidência incompleta seguem na fila de revisão. Ainda falta validar a cobertura OCR com o novo leitor e implementar a separação espacial completa dos painéis mistos, principalmente quando títulos do desenho estão convertidos em curvas.

### Validação local da versão 4.1

Foi rodada uma análise completa em memória (sem gravação no banco) nos quatro originais. 19-0065 reteve `156 ± 1,1` como leitura para revisão; 42-0312 retornou 12 cotas e 11 sugestões; DIN-005 retornou 5 cotas e 7 sugestões, com 9 leituras administrativas descartadas; TBX-198 retornou 9 cotas e 5 sugestões, removendo 10 leituras que caíram na tabela geral de tolerâncias. Esses números medem os candidatos desta amostra, não a cobertura total dos desenhos. O teste automatizado do parser e o `git diff --check` passaram. O teste de regressão TP-8377 não foi executado porque o PDF original não está neste projeto.

## Decisão contextual — versão 4.2

A confiança do OCR foi separada da confiança de que o texto seja uma cota. O novo módulo `dimension-decision.cjs` concentra configuração de pesos, parser técnico, zonas do documento, contexto textual, score, classificação `DIMENSION`/`REVIEW`/`NOT_DIMENSION`, deduplicação espacial, validação de agrupamento e estrutura de feedback. Cada candidato mantém `ocrConfidence`, `dimensionConfidence`, `dimensionScore`, `documentZone`, `nearbyContext` e `decisionLog`.

A imagem renderizada é preservada antes da máscara de OCR para buscar linhas horizontais/verticais, alinhamento e proximidade de geometria em escala de cinza. A cor continua apenas como auxílio de reconhecimento. A leitura vertical agora testa 0°, 90° e −90° e transforma as caixas novamente para a posição original.

Regressões nos quatro originais confirmaram: `157` do DCC e outros valores do quadro de 19-0065 passaram para não-cota; `156 ± 1,1` permaneceu em revisão; a tabela e os valores `96`, `189` e `57` de TBX-198 foram separados; `290`, `483`, `182`, `350` e `70` de 42-0312 foram separados; DIN-005 manteve leituras de baixa qualidade em revisão. Zonas administrativas inferidas recebem penalização menor para não eliminar cotas verdadeiras na fronteira do carimbo.

No aplicativo local, confirmar, corrigir, ignorar ou excluir uma leitura grava metadados e o recorte em `dados/draw2data-feedback/`. O arquivo `feedback.jsonl` guarda a ação do usuário, OCR original, correção, posição, orientação, duas confianças, classificação anterior, contexto, zona, evidências geométricas e caminho do recorte. No modo em nuvem, a interface mantém uma fila local até existir armazenamento remoto equivalente.

## Leitura progressiva e avaliação — versão 4.3

A evolução foi implementada sobre a versão 4.2, sem substituir o leitor existente. A nova camada `dimension-pipeline.cjs` concentra expansão configurável de recorte (`1,0`, `1,2`, `1,5` e `2,0`), detecção de leitura incompleta, comparação semântica das tentativas, cache por documento/página/caixa/rotação/expansão, score de agrupamento, tolerância empilhada e métricas de ground truth. A cascata encerra cedo quando encontra uma leitura completa e só testa 90°, −90° e 180° quando as expansões não resolvem o candidato.

A associação geométrica agora fornece `dimensionLineId`, orientação, segmento associado, quantidade de terminações, probabilidades das extremidades e linhas auxiliares. A decisão expõe separadamente `ocrScore`, `semanticScore`, `geometryScore`, `zoneScore`, `contextScore` e `groupingScore`. As zonas podem ser `DRAWING_AREA`, `TITLE_BLOCK`, `TABLE`, `TECHNICAL_NOTE`, `GD&T`, `DIMENSION_REGION` ou `OTHER`; posição é apenas uma evidência, somada a palavras-chave e concentração visual de pequenos campos.

O registro de feedback passou a incluir identificador do documento, caixa, texto final, tipo dimensional, rotação, linha associada e atributos geométricos e semânticos. O endpoint local `/api/draw2data/metrics` calcula TP, FP, FN, TN, precisão, recall, F1, acurácia de OCR, acurácia de classificação e erros de associação. A área “Diagnóstico do motor” mostra os totais da análise e as métricas disponíveis. O diagnóstico visual é optativo nas preferências; quando ativo, o recorte exibe a linha associada, a classificação e o score.

Na regressão de 19-0065, a inferência antiga que propagava tolerâncias entre molduras foi mantida apenas como compatibilidade optativa e ficou desligada por padrão. O falso `5 ± 1,1` deixou de entrar; `157`, `R0,5` e `R8` permaneceram fora da lista principal. A leitura conflitante `136 ± 1,1` permanece em revisão, enquanto `136,1` continua auditável, pois esse conflito precisa de confirmação humana. A amostra ainda é pequena; as métricas só passam a representar desempenho real depois de confirmações e exclusões suficientes feitas pelos usuários.

## Barreira estrutural e associação geométrica — versão 4.4

Esta etapa preserva o pipeline 4.3 e acrescenta `structural-analysis.cjs`: identificação de números dentro de containers gráficos, barreiras contra junção de textos que cruzem esses containers, restrição de merges por alinhamento/posição, sinalização de prefixos OCR suspeitos sem corrigir automaticamente a leitura, classificação de propriedades técnicas e detecção de regiões de parágrafo com altura vertical limitada. O limite evita que caixas de texto exageradas do PDF cubram vistas inteiras. Cada leitura mantém texto OCR bruto, tokens e caixas, texto normalizado, merge e texto final; candidatos suspeitos ficam em revisão.

O parser também diferencia dimensões lineares, raios, ângulos, diâmetros, roscas e chanfros. Propriedades como raios não indicados e espessura não especificada são separadas de dimensões geométricas; comprimento desenvolvido é registrado como dimensão técnica. A associação de leader continua conservadora: segmentos raster são evidência, mas não provam por si só qual curva a linha alcança. A geometria de terminação não confirmada não deve ser apresentada como associação certa.

Validações automatizadas incluem exemplos com identificador em círculo/caixa junto a cota, barreiras de merge, prefixo suspeito, propriedades técnicas, texto jurídico e preservação do OCR bruto. `npm test`, verificações `node --check` dos módulos alterados e `git diff --check` passaram. Nos PDFs inspecionados, 19-0065 manteve `156 ± 1,1` elegível para revisão e ainda mostra conflitos como `136 ± 1,1` versus `136,1`; TBX-198 manteve leituras do quadro/tabela fora das dimensões principais. Uma execução integral do 42-0312 produziu `48,3 ± 0,36` como dimensão, mas também deixou `446,3 ± 0,78` apenas em revisão, sinal de que a contaminação OCR ainda pode ocorrer e precisa de confirmação/correção antes de validação. A amostra desses arquivos é pequena e o OCR continua sendo uma leitura a confirmar, não ground truth.

**Limitação de rastreabilidade do exemplo 918,3 ±0,5:** esse texto foi fornecido na solicitação, mas não aparece nos PDFs locais nem nos resultados/logs acessíveis nesta execução. Portanto não é possível afirmar quais tokens, caixas ou regra concreta produziram aquele valor, nem concluir que a nova barreira corrige esse caso específico. O motor agora preserva esses dados para auditoria futura, mas a confirmação depende de processar o PDF exato em que ocorreu o falso merge.

Também permanecem limitações: a detecção de callout é baseada em OCR numérico e container detectável, não em um modelo completo de componentes; linhas auxiliares, setas e líderes podem se cruzar em desenhos densos. A cobertura de associação texto→linha/curva não está validada como definitiva. O modo de depuração devolve bboxes, tokens, feature IDs, container, linha, líder, término, classificação, score e componente no payload; isso é instrumentação diagnóstica e não deve ser interpretado como segmentação CAD perfeita.
