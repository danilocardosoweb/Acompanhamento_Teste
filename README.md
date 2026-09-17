# Acompanhamento de Testes de Ferramentas

Painel local para acompanhar testes e correções de ferramentas da Tecnoperfil.

## Recursos

- Coleta e-mails do Outlook clássico na pasta `Testes Qualidade`.
- Importa assuntos iniciados por `TESTE` sem alterar as mensagens.
- Organiza resultados por ferramenta e sequência.
- Exibe comentários, histórico e anexos Excel/PDF.
- Gera visualização das abas de planilhas com o Excel instalado.
- Sincroniza registros, anexos e visualizações com um bucket privado no Supabase.
- Consulta correções existentes no sistema e relaciona pelo código e sequência.
- Suporta arquivos de correção em Excel, PDF e vídeo.

## Execução local

Requisitos:

- Windows com Outlook clássico configurado.
- Microsoft Excel para gerar visualizações de planilhas.
- Node.js instalado em `C:\Program Files\nodejs\node.exe`.
- Poppler disponível no ambiente Codex para converter os PDFs em imagens.

Abra `Iniciar.cmd`. O painel ficará disponível em `http://127.0.0.1:4317`.

## Supabase

O projeto usa as tabelas e políticas descritas em `supabase/`. A função `quality-collector` recebe a sincronização do computador autorizado e mantém a chave administrativa dentro do ambiente do Supabase.

Crie localmente um arquivo `.cloud-credentials.json` com este formato:

```json
{
  "endpoint": "https://sldhpwtdipndnljbzojm.supabase.co/functions/v1/quality-collector",
  "token": "TOKEN_ALEATORIO_REGISTRADO_NO_SUPABASE"
}
```

Esse arquivo é ignorado pelo Git e nunca deve ser publicado. O token precisa ter seu SHA-256 cadastrado em `quality_collectors`.

## Dados privados

O repositório não contém e-mails, anexos, visualizações geradas nem credenciais. Esses itens ficam nas pastas ignoradas `dados/`, `anexos/` e `previews/`, e no armazenamento privado do Supabase.

## Situação atual

O painel está em execução local. A publicação na Vercel e o login para a diretoria serão adicionados em uma etapa posterior.
# Vercel

A versão hospedada usa estas variáveis de ambiente em **Settings > Environment Variables**:

- `QUALITY_COLLECTOR_ENDPOINT`: endereço completo da função `quality-collector`.
- `QUALITY_COLLECTOR_TOKEN`: token de 64 caracteres usado pelo computador coletor.
- `QUALITY_SESSION_SECRET`: chave aleatória com pelo menos 32 caracteres para assinar as sessões de login.

Cadastre as três em Production, Preview e Development e faça um novo deploy. Não use prefixos públicos como `NEXT_PUBLIC_`, pois os valores devem permanecer somente no servidor.
