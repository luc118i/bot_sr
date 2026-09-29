# frequencia-agent

Agente local (Electron, bandeja do Windows — mesmo molde do `rizer-agent`) que lê a
tela de acompanhamento de ponto e preenche a planilha de frequência no Google Sheets
com `.` (pontual), `P` (atraso) e `FE` (férias).

**Proteções:** simular é sempre o primeiro passo · célula já preenchida nunca é
alterada · "sem ponto" nunca vira `F` sozinho · qualquer dúvida de nome vai para revisão ·
antes de gravar, relê cada célula e pula as que alguém preencheu nesse meio tempo.

## Uso

```
npm install
npm run dev          # app na bandeja → "Preencher frequência..."
npm test             # testes do núcleo
```

CLI (mesmo núcleo):

```
node dist/cli.js simular --html ponto.html --data 2026-09-28
node dist/cli.js simular --html ponto.html --data 2026-09-28 --xlsx copia.xlsx --entrada-padrao 08:00 --tolerancia 5
node dist/cli.js escrever --plano relatorios/<arquivo>.json
node dist/cli.js criar-abas-config
```

`--xlsx` lê uma cópia baixada da planilha, só leitura — serve para simular sem tocar no Google.

## Configuração

1. **Service Account** (Google Cloud) com a API do Sheets ativada. Compartilhe a planilha
   com o e-mail dela como **Editor**.
2. Nas Configurações do app: JSON da service account + link da planilha → "Testar conexão".
3. "Criar abas de configuração" e preencher:

| Aba | Colunas | Observação |
|---|---|---|
| `CONFIG_GERAL` | `tolerancia_min`, `entrada_padrao`, `horario_corte` | 1 linha de dados. Antes de `horario_corte` o dia de hoje não é classificado |
| `CONFIG_HORARIOS` | `adm`, `entrada`, `saida`, `tolerancia_min`, `vigencia_inicio`, `vigencia_fim`, `obs` | só quem foge do padrão |
| `CONFIG_EXCECOES` | `data`, `adm`, `entrada_prevista`, `codigo`, `obs` | vale só para aquela data |
| `CONFIG_APELIDOS` | `nome_no_ponto`, `adm`, `obs` | nome truncado/diferente |
| `CONFIG_FERIADOS` | `data`, `descricao` | bot não roda nesses dias |

Horário previsto: exceção do dia → horário individual vigente → padrão.
Tolerância inclusiva: entrada ≤ previsto + tolerância → `.`; depois → `P`.

## Layout da planilha

Nada é fixo por posição. O bot acha a linha com `ADM`/`COLABORADOR` e lê a sequência de
dias do cabeçalho, que **precisa** ser exatamente 1, 2, 3… — senão o mês é recusado.
Na cópia de 2026 isso reprova **Março** (falta o 15), **Maio** (falta o 3) e **Julho**
(dias repetidos/pulados). Outubro–Dezembro estão OK.

## Estrutura

```
src/core/        regras puras (sem Electron/Google) + testes
  pontoParser    HTML do ponto → registros (âncora: data-testid dos ícones)
  layoutMes      acha/valida colunas da aba do mês
  configPlanilha abas CONFIG_* e resolução do horário previsto
  matcher        nome do ponto → linha (apelidos, sugestão p/ nome truncado)
  planner        decisão por colaborador + plano de escrita
src/sheets/      GoogleSheetsGateway (real) e XlsxGateway (cópia, só leitura)
src/service.ts   simular / executarEscrita / criarAbasConfig
src/main.ts      bandeja + janelas; src/cli.ts linha de comando
```

## Fora do MVP

Busca automática do HTML (login via Playwright ou API JSON do ponto), Saídas/Entradas 2–3,
carga retroativa, correção das fórmulas de totais.

## Dados sensíveis

Nunca versionar `config.json` (contém a service account), cópias `.xlsx` da planilha
(BASE DE DADOS tem CPF e telefones) nem HTML salvo do ponto — o `.gitignore` já bloqueia.
Testes usam só o fixture sintético em `test/fixtures/`.

## Licença

Uso interno, proprietário — ver [LICENSE](LICENSE).
