# DRAW2DATA

## Fase 1

Esta primeira fase adiciona uma tela isolada para selecionar um PDF técnico, extrair texto vetorial, identificar a ferramenta pelo nome do arquivo ou por códigos no conteúdo e localizar cotas com tolerâncias simétricas (`12 ± 0,05`) ou assimétricas (`12 + 0,05 / - 0,02`).

O resultado é revisável antes da exportação para Excel. O arquivo gerado possui as abas `Cotas` e `Informações` e preserva o texto original, a página, a posição, o método e a confiança de cada registro.

## Limitações intencionais

- A Fase 1 não faz OCR, rasterização ou processamento em lote de pastas.
- PDFs sem texto pesquisável retornam um aviso para revisão manual.
- A detecção é conservadora: apenas medidas com tolerância são incluídas automaticamente.
- As configurações avançadas e a leitura de múltiplas cotas sem tolerância ficam para fases posteriores.
