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
