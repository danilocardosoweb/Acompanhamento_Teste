# Design System — Tecnoperfil Quality

## Objetivo
Padrão visual para um sistema operacional industrial de qualidade. A interface prioriza clareza, velocidade de leitura, operação segura e consistência entre Acompanhamento, Apontamentos, Indicadores e Configurações.

## Direção visual
Flat design operacional, com superfícies claras, navegação azul-marinho, ações teal e estados semânticos controlados. Não usar gradientes, glassmorphism, sombras fortes ou elementos decorativos sem função.

## Paleta

| Token | Valor | Uso |
|---|---|---|
| `--nav-primary` | `#142D42` | Sidebar e áreas de navegação |
| `--primary` | `#0D9488` | Ação principal, foco e seleção |
| `--secondary` | `#2DD4BF` | Destaques de navegação |
| `--background` | `#F4F7F9` | Fundo geral |
| `--surface` | `#FFFFFF` | Cards, modais e campos |
| `--text-primary` | `#183044` | Títulos e dados principais |
| `--text-secondary` | `#617487` | Descrições e metadados |
| `--success` | `#178A6A` | Aprovado, concluído e conectado |
| `--danger` | `#C94F58` | Reprovado e erro |
| `--warning` | `#C5861A` | Atenção e pendência |
| `--border` | `#D9E2EA` | Divisores e contornos |

As cores de estado sempre aparecem com texto ou ícone; nunca dependem apenas de cor.

## Tipografia
- Família: `Inter`, com fallback `Segoe UI`, Arial, sans-serif.
- Corpo: 14px no desktop e no mínimo 16px para texto de leitura em mobile.
- Escala: 11, 12, 14, 16, 18, 24 e 30px.
- Títulos: peso 700; rótulos: 500–600; corpo: 400.
- Números de indicadores devem usar algarismos tabulares quando aplicável.

## Espaçamento
Escala única baseada em 4px: `4, 8, 12, 16, 24, 32, 40, 48px`, disponível como `--space-1` até `--space-8`.

## Componentes

### Botões
Altura mínima de 44px, raio de 6px, texto de ação direto, foco visível e estado desabilitado. Uma ação primária por área; ações secundárias usam fundo neutro e borda.

### Campos e selects
Sempre possuem label visível. Altura de 44px, borda `--border`, fundo `--surface`, foco teal com contorno visível. Mensagens de validação ficam próximas do campo.

### Cards
Fundo branco, borda `--border`, raio de 10px e sombra curta `--shadow-sm`. O conteúdo mais importante vem primeiro; metadados ficam abaixo em contraste secundário.

### Status
Usar badges em formato pill com texto: APROVADO, REPROVADO, REVISAR, pendente, enviado e erro. Os badges não substituem a informação textual.

### Tabelas e listas
No desktop, manter alinhamento de colunas e números. Em telas estreitas, usar rolagem controlada ou transformar linhas em cards; nunca causar rolagem horizontal na página inteira.

### Modais
Usar `dialog` nativo, backdrop escuro, título, descrição, conteúdo com agrupamento, feedback contextual e ações de fechar/cancelar. O foco deve permanecer no diálogo.

### Loading, vazio e mensagens
- Loading: skeleton ou texto de progresso com `aria-busy` quando a operação demora.
- Vazio: explicar por que não há dados e orientar o próximo passo.
- Erro: informar o problema e oferecer recuperação.
- Sucesso: confirmação curta e contextual.
- Aviso: usar amber com texto legível.

## Ícones
Usar SVG inline com traço consistente de aproximadamente 1.8–2px, tamanho de 18–21px e `aria-hidden="true"` quando decorativo. Botões que contenham apenas ícone devem possuir `aria-label`. Não usar emojis como ícones funcionais.

## Layout e navegação
- Desktop: sidebar fixa de 220px e conteúdo centralizado até 1440px.
- Tablet: sidebar recolhível e conteúdo com padding reduzido.
- Mobile: sidebar vira drawer; o botão hamburger permanece visível e não remove a navegação.
- Breakpoints de validação: 320, 375, 414, 768, 1024 e 1440px.
- Nenhuma tela deve criar rolagem horizontal involuntária.

## Telas
- **Acompanhamento:** lista + detalhe no desktop; lista acima do detalhe no mobile.
- **Apontamentos:** filtros no topo; grid de cards no desktop; cards verticais no mobile.
- **Indicadores:** KPIs alinhados, comparação por categoria, situação geral, eficiência e atenção.
- **Configurações:** grupos de fontes de dados, importações e notificações.
- **Diálogos:** mesma linguagem visual dos campos, botões e mensagens.

## Acessibilidade e interação
- Foco visível em todos os controles.
- Áreas clicáveis de pelo menos 44px.
- Navegação por teclado na mesma ordem visual.
- `prefers-reduced-motion` respeitado.
- Transições de 150–200ms apenas para feedback de estado.
- Botões assíncronos ficam desabilitados enquanto processam.

## Contrato de implementação
Os IDs e classes usados pelo JavaScript são contratos. Alterações visuais devem preferir tokens e CSS; qualquer novo controle precisa ser adicionado sem remover os seletores existentes.
