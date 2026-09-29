# frequencia-agent

Agente local (Electron, bandeja do Windows — mesmo molde do `rizer-agent`) que lê a
tela de acompanhamento de ponto e preenche a planilha de frequência no Google Sheets
com `.` (pontual), `P` (atraso) e `FE` (férias).

**Proteções:** simular é sempre o primeiro passo · célula já preenchida nunca é
alterada · "sem ponto" nunca vira `F` sozinho · qualquer dúvida de nome vai para revisão ·
antes de gravar, relê cada célula e pula as que alguém preencheu nesse meio tempo ·
toda escrita pode ser **desfeita** (apaga só as células que ainda têm o código gravado pelo
bot — o que alguém mudou depois fica).

## Testando na planilha original

1. Google Sheets → Arquivo → Histórico de versões → **Nomear versão atual** ("Antes do bot").
2. **Horários e regras** → salvar: só cria/grava as abas `CONFIG_*`.
3. Simule dias **já lançados à mão** (filtro de data na tela do ponto): nada a escrever, a
   prévia só mostra o que confere e o que diverge. Ajuste horários até zerar as divergências.
4. Primeira escrita num dia novo, depois do horário de corte. Se algo sair errado: botão
   **Desfazer esta escrita** (ou **Desfazer escrita anterior...** escolhendo os relatórios).

## Conferindo a semana

Um HTML por dia (a data é lida de dentro do HTML — não precisa informar). Selecione todos de
uma vez: a prévia mostra um bloco por dia, pula domingos e feriados, cruza a virada do mês
(cada dia vai para a sua aba) e um único **Escrever** grava tudo. Um dia com problema (HTML
errado, dia repetido, mês com cabeçalho quebrado) aparece em vermelho e não impede os outros.
Se a gravação falhar no meio, os dias já gravados continuam disponíveis para o **Desfazer**.

## Domingos e feriados

A planilha marca os dias não trabalhados **escondendo a coluna do dia**. O bot lê isso: coluna
oculta = feriado, domingo = sempre não útil — esses dias nunca são preenchidos, nem com
"forçar". Para cadastrar um feriado, esconda a coluna na aba do mês; a tela **Horários e
regras** mostra os feriados que o bot encontrou no mês atual e no seguinte. Um dia não
trabalhado cuja coluna foi esquecida visível só gera "sem ponto → revisão" (nunca `F`).

## Uso

```
npm install
npm run dev          # app na bandeja → "Preencher frequência..."
npm test             # testes do núcleo
```

CLI (mesmo núcleo):

```
node dist/cli.js simular --html seg.html --html ter.html --html qua.html
node dist/cli.js simular --html ponto.html --xlsx copia.xlsx --entrada-padrao 08:00 --tolerancia 5
node dist/cli.js escrever --plano relatorios/<data>_simulacao_<hora>.json   # um dia por vez
node dist/cli.js desfazer --escrita relatorios/<data>_escrita_<hora>.json
node dist/cli.js criar-abas-config
```

`--xlsx` lê uma cópia baixada da planilha, só leitura — serve para simular sem tocar no Google.

## Configuração

1. **Service Account** (Google Cloud) com a API do Sheets ativada. Compartilhe a planilha
   com o e-mail dela como **Editor**.
2. Nas **Configurações** do app: JSON da service account + link da planilha → "Testar conexão".
3. Em **Horários e regras** (bandeja ou botão na tela principal): entrada padrão, tolerância,
   horário de corte, horários individuais (com vigência), exceções de um dia e apelidos.
   A tela valida tudo antes de gravar e salva nas abas `CONFIG_*` da planilha (criadas se faltarem),
   então vale para qualquer máquina/responsável que rodar o bot.

| Aba | Colunas |
|---|---|
| `CONFIG_GERAL` | `tolerancia_min`, `entrada_padrao`, `horario_corte` |
| `CONFIG_HORARIOS` | `adm`, `entrada`, `saida`, `tolerancia_min`, `vigencia_inicio`, `vigencia_fim`, `obs` |
| `CONFIG_EXCECOES` | `data`, `adm`, `entrada_prevista`, `codigo`, `obs` |
| `CONFIG_APELIDOS` | `nome_no_ponto`, `adm`, `obs` |

Horário previsto: exceção do dia → horário individual vigente → padrão.
Tolerância inclusiva: entrada ≤ previsto + tolerância → `.`; depois → `P`.

## Escopo por responsável

A tela de ponto só lista os colaboradores sob responsabilidade de quem fez login; a aba do mês
tem todos os setores. Quem não aparece no ponto é mostrado como "fora do seu ponto (outros
setores)" — recolhido, não é pendência — e nunca é tocado (exceto por código forçado em exceção).

## HTML do ponto

Âncora: cada colaborador é um `<div id="dia-resumido-AAAA-MM-DD">`; a data do id precisa bater
com o dia escolhido. Ícones: `exclamation-circle` (vermelho), `exclamation-triangle` (amarelo),
`check-circle` (verde) — não entram na decisão. Entrada 1 = primeira célula depois do nome.
Para obter o HTML: F12 → Elements → botão direito em `<html>` → Copy outerHTML, depois que a
lista carregar.

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
src/regras.ts    tela "Horários e regras" ↔ abas CONFIG_* (carregar, validar, salvar)
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
