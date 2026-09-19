# DRAW2DATA — plano de implementação

## Análise do projeto atual

- **Tecnologia:** Node.js CommonJS no servidor local (`server.cjs`) e JavaScript vanilla no navegador.
- **Navegação:** menu lateral em `index.html`; cada tela é uma seção alternada por `app.js`.
- **Visual:** tokens e componentes centralizados em `style.css`, com botões, cards, tabelas, diálogos e estados já padronizados.
- **Arquivos:** o servidor já recebe arquivos em JSON, processa PDFs/planilhas para visualização e mantém os arquivos locais em pastas de trabalho.
- **Bibliotecas disponíveis:** `pdfjs-dist` já está instalado e também existe a cópia usada pelo visualizador em `vendor/`. `read-excel-file` é usado para importações, mas não gera arquivos Excel.
- **Integrações existentes:** Supabase, Outlook, importações e WhatsApp não serão alterados nesta primeira fase.

## Local do módulo

O DRAW2DATA será um módulo isolado na raiz do projeto, com a interface em `draw2data.js` e a lógica de leitura/detecção em `draw2data/`. A tela será uma nova seção `draw2data-page` e um novo item do menu; as telas atuais continuarão usando os mesmos IDs, eventos e APIs.

## Arquivos previstos

### Novos

- `draw2data.js`: estado da tela, seleção de arquivo, conferência, edição e download do Excel.
- `draw2data/reader.cjs`: leitura de PDF vetorial com `pdfjs-dist` e coleta de texto, página e posição.
- `draw2data/detection.cjs`: identificação da ferramenta e detecção inicial de cotas com tolerância.
- `draw2data/exporter.cjs`: geração do `.xlsx` com as abas `Cotas` e `Informações`.
- `draw2data/README.md`: notas técnicas do módulo e limitações da Fase 1.

### Existentes que serão modificados

- `index.html`: item do menu, seção do módulo e carregamento do script.
- `app.js`: registro da nova página sem mudar os fluxos existentes.
- `server.cjs`: endpoint local isolado para analisar um PDF e gerar o workbook.
- `style.css`: somente estilos específicos que reutilizam os tokens existentes.
- `package.json` e `package-lock.json`: dependência de geração XLSX, caso a biblioteca não esteja disponível.

## Dependências

O leitor reutilizará `pdfjs-dist`, já presente no projeto. Para gerar um arquivo XLSX real será necessária uma biblioteca de escrita de planilhas; `read-excel-file` é somente leitor. A escolha será a menor dependência compatível, sem alterar Supabase ou APIs remotas.

## Fluxo do usuário na Fase 1

1. Abrir **Draw2Data / Leitura de Desenhos** no menu.
2. Selecionar um PDF.
3. O servidor extrairá texto vetorial, páginas e posições.
4. O módulo identificará a ferramenta pelo nome do arquivo e, em seguida, pelo texto.
5. Serão detectadas inicialmente apenas cotas com `±` ou tolerância assimétrica explícita.
6. A tabela permitirá editar, excluir e adicionar cotas.
7. O usuário confirmará o resultado e baixará o Excel individual.

## Estratégia de leitura

O PDF será processado sem OCR nesta fase. Cada item textual será preservado com coordenadas, página e método `PDF_TEXT`. PDFs sem texto pesquisável retornarão um estado claro para a futura Fase 4, sem inventar cotas.

## Estratégia de detecção

- Regex configurável para ferramenta: `\\b[A-Z]{2,4}-\\d{3,6}\\b`.
- Regex para tolerância simétrica: `nominal ± tolerância`.
- Regex para tolerância assimétrica: `nominal +x/-y`.
- Vírgula e ponto decimal serão aceitos e normalizados internamente.
- Valores sem tolerância não entram na Fase 1.
- Itens administrativos serão reduzidos por contexto de posição, especialmente a região inferior/direita, e receberão confiança menor quando a classificação for incerta.

## Excel

Cada análise gerará um arquivo com nome baseado na ferramenta, sem sobrescrever arquivos existentes. A aba `Cotas` terá as colunas solicitadas e a aba `Informações` registrará arquivo, data, método, quantidade e itens para revisão.

## Riscos técnicos

- PDFs podem conter texto fragmentado em vários itens, exigindo agrupamento por proximidade.
- Símbolos de tolerância podem aparecer como glifos separados ou codificação incomum.
- Desenhos escaneados não serão reconhecidos na Fase 1 e deverão seguir para OCR na Fase 4.
- Alguns números do carimbo podem parecer cotas; a confiança e o status `REVISAR` serão usados para não inventar resultados.
- Arquivos grandes serão limitados para manter o servidor responsivo.

## Plano da Fase 1

1. Criar leitor, detector e exportador isolados.
2. Adicionar a tela e o item de menu seguindo o design system atual.
3. Adicionar endpoint local para PDF em base64, sem tocar no Supabase.
4. Exibir ferramenta, método, quantidade e tabela editável.
5. Gerar e baixar XLSX individual.
6. Validar sintaxe, análise de um PDF vetorial real e abertura do arquivo Excel gerado.

As fases de pasta, OCR, visualização com caixas, DXF e consolidado ficam fora desta implementação.
