# DRAW2DATA

## Fase 1

Esta primeira fase adiciona uma tela isolada para selecionar um PDF técnico, extrair texto vetorial, identificar a ferramenta pelo nome do arquivo ou por códigos no conteúdo e localizar cotas com tolerâncias simétricas (`12 ± 0,05`) ou assimétricas (`12 + 0,05 / - 0,02`).

O resultado é revisável antes da exportação para Excel. O arquivo gerado possui as abas `Cotas` e `Informações` e preserva o texto original, a página, a posição, o método e a confiança de cada registro.

## Limitações do modo vetorial

- O modo vetorial lê somente o texto selecionável do PDF; para desenhos escaneados ou texto convertido em curvas, use a leitura completa.
- Resultados da camada visual ficam marcados para revisão, pois OCR não substitui a conferência no desenho.
- Cotas sem tolerância podem ser incluídas conforme a preferência salva no app, mas medidas ambíguas não devem ser tratadas como confirmadas automaticamente.

## Recuperação de barras chatas (BC)

Na leitura completa, arquivos cujo nome começa com `BC` recebem uma varredura visual ampla mesmo que o PDF já tenha fornecido algumas cotas. Se a varredura normal não achar nenhuma, o motor faz uma busca adicional em blocos menores e em orientação girada. Leituras explícitas `R3`/`R1,5` são preservadas como raios sem tolerância e marcadas para revisão. Em recortes próximos a outra cota, o OCR pode reconstruir tolerâncias compactas como `60,13` → `6 ± 0,13`; esses itens continuam em revisão e devem ser conferidos no desenho.

Essa recuperação foi validada visualmente no `BC-5036.pdf` (comprimento, espessura e `R3`). Desenhos sem leitura segura continuam sinalizados para conferência manual; a rotina não inventa cotas para preencher lacunas.

Para desenhos BC com a vista de embalagem e o perfil na mesma folha, o processador agora prioriza as cotas posicionadas à direita quando há chamadas localizadas dos dois lados. Em PDFs com páginas separadas, uma página identificada como embalagem é ignorada quando outra página fornece evidência forte da vista de perfil (raio ou várias cotas sem indicação de embalagem). O resultado registra a seleção em `diagnostics.flatBarRightView` e recomenda conferir as evidências. Se a página/vista não puder ser distinguida com segurança, as cotas são preservadas para revisão em vez de descartadas automaticamente. A versão específica dos BCs muda para que apenas essas barras sejam reanalisadas no lote.

Na automação local em lote, PDFs de todos os perfis também fazem uma recuperação ampliada ao redor das cotas reconhecidas quando o resultado da página é escasso. Isso ajuda com dimensões pequenas de espessura, como `1,78 ± 0,15`, que o OCR pode achatar para `1,7840,15`. A tolerância é validada em relação ao nominal para evitar que fragmentos sejam aceitos como cotas. As novas regras usam versões de análise próprias para que o checkpoint reprocesse os arquivos afetados; o modo publicado mantém o fluxo rápido padrão.

## Recuperação de páginas com poucas cotas

Na leitura completa do app, se o texto pesquisável fornecer no máximo três cotas em uma página, o OCR deixa de ficar restrito às regiões marcadas e faz uma varredura visual ampliada daquela página. Quando o PDF não fornecer texto dimensional, o motor também amplia a leitura ao redor das cotas visuais se a primeira passagem reconhecer menos de cinco itens. Páginas com mais cotas vetoriais continuam no caminho rápido. O resultado informa quais páginas receberam a recuperação e mantém as leituras visuais para conferência, sem afirmar que a página está completa automaticamente.

## Priorização e cobertura de cotas

Quando raios dominam a primeira leitura, a recuperação local também é acionada mesmo que a página tenha muitos candidatos. Ela distribui recortes por até nove regiões, priorizando cotas com tolerância e lineares antes dos raios. Cotas lineares simples encontradas nesses recortes são mantidas como candidatas de baixa confiança para revisão. A lista distingue cotas lineares com tolerância, lineares, raios, diâmetros e referências; essa ordem organiza a conferência sem apagar medidas secundárias. Os diagnósticos e avisos apontam quando os raios ainda superam as cotas lineares.

## Desenhos com cotas pretas e geometria azul

A máscara visual preserva tinta azul e texto escuro neutro, removendo traços longos de construção antes do OCR. Isso permite ler desenhos como o `DIN-004`, em que o perfil está em azul e as cotas estão pretas. O motor também procura agrupamentos de rótulos típicos do quadro técnico e exclui candidatos que caem dentro dessas regiões, evitando trazer área, peso, perímetro e identificação para a lista de dimensões do perfil. Leituras diferentes encontradas próximas são mantidas e sinalizadas para conferência, em vez de escolher silenciosamente uma delas. Antes de salvar, cada leitura deve ser marcada como confirmada ou ignorada. Quando a leitura encontra apenas uma cota, salvar o perfil também exige confirmação explícita de que todas as páginas foram conferidas. Essas proteções não substituem a revisão visual; candidatos OCR continuam sujeitos a erro.

## Automação com retomada e auditoria

Execute `Automacao-Desenhos.cmd` para trabalhar com uma pasta de PDFs. O menu preserva o checkpoint e oferece quatro ações:

1. **Continuar desenhos ainda não analisados**: processa somente PDFs novos, alterados ou que falharam, sem reiniciar o lote.
2. **Auditar resultados**: confere a pasta de origem contra o checkpoint sem reler os PDFs. O relatório aponta arquivos pendentes, erros, leituras sem/poucas cotas, motor desatualizado e evidências ausentes.
3. **Revisar desenhos com risco**: relê os pendentes e os arquivos com zero ou poucas cotas, falhas ou evidências incompletas usando o motor atual e uma varredura mais abrangente.
4. **Atualizar todos os desenhos para o motor atual**: relê todo o lote. Use esta opção quando uma melhoria do motor precisar ser aplicada também aos desenhos já concluídos.

Os arquivos `auditoria-do-lote.xlsx`, `auditoria-do-lote.json`, `relatorio-do-lote.xlsx`, `checkpoint.json` e `progresso-lote.json` ficam na pasta de resultados. A automação grava o progresso após cada desenho e segue até o fim; ela só para em caso de erro não recuperável.
