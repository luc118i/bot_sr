# frequencia-agent

Agente local (Electron, bandeja do Windows — mesmo molde do `rizer-agent`) que lê o
acompanhamento de ponto (Central do Funcionário / Secullum) e preenche a planilha de
frequência no Google Sheets com `.` (pontual), `P` (atraso) e `FE` (férias).

**Um clique:** escolha o dia no calendário (abre sempre em hoje) e clique em **Preencher
dia**, ou em **Conferir semana** para segunda a sábado daquela semana (até hoje). O bot lê
o ponto, confere com a planilha e grava **dia por dia**, com barra de progresso e uma linha
por dia mostrando a fase (lendo o ponto → conferindo → gravando → pronto / pulado / erro).
No fim, resumo por dia (preenchido, precisa de revisão, diverge do que já estava lançado)
com botão **Desfazer**. Marcando **simular (não grava)**, faz tudo sem gravar.

**Proteções:** célula já preenchida nunca é alterada · "sem ponto" nunca vira `F` sozinho ·
qualquer dúvida de nome vai para revisão · antes de gravar, relê cada célula e pula as que
alguém preencheu nesse meio tempo · domingos e feriados (colunas ocultas) nunca são
preenchidos · toda escrita pode ser **desfeita** (apaga só as células que ainda têm o código
gravado pelo bot — o que alguém mudou depois fica).

## Testando na planilha original

1. Google Sheets → Arquivo → Histórico de versões → **Nomear versão atual** ("Antes do bot").
2. **Horários e regras** → salvar (fica nesta máquina, não mexe na planilha).
3. **Simular (não grava)** + **Conferir semana** numa semana já lançada à mão: os dias
   aparecem como "confere" ou "diverge". Ajuste horários individuais até zerar as divergências.
4. Desmarque "simular" e **Preencher dia**. Se algo sair errado: **Desfazer esta escrita**
   (ou **Desfazer escrita anterior...** escolhendo os relatórios).

## Ponto (Secullum)

O bot não abre navegador: chama a mesma API que a tela "Acompanhamento de Ponto" usa
(`https://pontowebapp.secullum.com.br/<banco>/Batidas/<AAAA-MM-DD>`), autenticando com o
login da Central do Funcionário em **Configurações → Ponto (Secullum)** (banco, Nº Folha ou
Nº Identificador, número e senha — "Testar login" confere). Só leitura: nada é alterado no
ponto. A senha e o token do Apps Script ficam **criptografados** no `config.json` (cofre do
Windows, amarrado ao usuário da máquina). A resposta traz, por colaborador, as batidas,
o saldo e se o dia é feriado — se o ponto disser feriado e a coluna estiver visível, o
resumo avisa.

Alternativa (Avançado na tela principal / CLI): conferir a partir do HTML da tela copiado
pelo F12 — um arquivo por dia, a data vem de dentro do HTML.

## Domingos e feriados

A planilha marca os dias não trabalhados **escondendo a coluna do dia**. O bot lê isso: coluna
oculta = feriado, domingo = sempre não útil — esses dias nunca são preenchidos, nem com
"forçar". Para cadastrar um feriado, esconda a coluna na aba do mês; a tela **Horários e
regras** mostra os feriados que o bot encontrou no mês atual e no seguinte. Um dia não
trabalhado cuja coluna foi esquecida visível só gera "sem ponto → revisão" (nunca `F`).

## Uso

```
npm install
npm run dev          # app na bandeja → "Preencher frequência"
npm test             # suíte completa (unit + integração + propriedade) — ver "Testes"
```

CLI (mesmo núcleo):

```
node dist/cli.js simular --html seg.html --html ter.html --html qua.html
node dist/cli.js simular --html ponto.html --xlsx copia.xlsx --entrada-padrao 08:00 --tolerancia 5
node dist/cli.js escrever --plano relatorios/<data>_simulacao_<hora>.json   # um dia por vez
node dist/cli.js desfazer --escrita relatorios/<data>_escrita_<hora>.json
```

`--xlsx` lê uma cópia baixada da planilha, só leitura — serve para simular sem tocar no Google.

## Configuração

1. Conecte o bot à planilha — **Apps Script** (recomendado, não precisa de Google Cloud) ou
   **Service Account** (JSON). Ver "Conectar via Apps Script" abaixo.
2. Nas **Configurações** do app: escolha a conexão, preencha → "Testar conexão".
3. Em **Horários e regras** (bandeja ou botão na tela principal): entrada padrão, tolerância,
   horário de corte, horários individuais (com vigência), exceções de um dia e apelidos.
   A tela valida tudo antes de gravar e salva **nesta máquina**, em `regras.json` (pasta de
   dados do app, junto com `logs/` e `relatorios/`; a versão anterior fica em
   `regras.anterior.json`). **A planilha de frequência não recebe nenhuma configuração**:
   dela o bot só lê a BASE DE DADOS e as abas dos meses, e só grava as células dos dias.

Horário previsto: exceção do dia → horário individual vigente → padrão.
Tolerância inclusiva: entrada ≤ previsto + tolerância → `.`; depois → `P`.

## Conectar via Apps Script

O bot fala com a planilha por um script publicado dentro dela, que roda com a permissão de
quem publicou. Quem faz os passos precisa ser dono ou editor da planilha.

1. Na planilha: **Extensões → Apps Script**. Apague o conteúdo de `Código.gs` e cole
   [`apps-script/Codigo.gs`](apps-script/Codigo.gs). Salve.
   *(Se o projeto foi criado fora da planilha, em script.google.com, adicione também a
   propriedade `PLANILHA_ID` no passo 3.)*
2. No bot: **Configurações → Conexão: Apps Script → Gerar token**. Copie o token.
3. No Apps Script: **Configurações do projeto** (engrenagem) → **Propriedades do script** →
   adicionar `TOKEN` = o token copiado.
4. **Implantar → Nova implantação** → tipo **App da Web** → Executar como: **Eu** →
   Quem pode acessar: **Qualquer pessoa** → Implantar. Autorize o acesso quando o Google pedir.
5. Copie o **URL do app da Web** (termina em `/exec`) para o bot → **Testar conexão** → Salvar.

"Qualquer pessoa" é necessário porque o bot não faz login no Google; quem protege é o token —
sem ele o script não lê nem grava nada. Link e token ficam só no `config.json` da máquina.
Ao mudar o código do script, use **Implantar → Gerenciar implantações → editar → Nova versão**
para manter o mesmo link. No histórico de versões da planilha, as alterações do bot aparecem
no nome de quem publicou.

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
src/core/        regras puras (sem Electron/Google)
  pontoApi       resposta da API do ponto → registros
  pontoParser    HTML do ponto → registros (modo avançado)
  layoutMes      acha/valida colunas da aba do mês; colunas ocultas = dias não úteis
  configPlanilha regras tipadas e resolução do horário previsto
  matcher        nome do ponto → linha (apelidos, sugestão p/ nome truncado)
  planner        decisão por colaborador + plano de escrita
src/ponto/       SecullumClient (API da Central do Funcionário)
src/sheets/      AppsScriptGateway, GoogleSheetsGateway (Service Account), XlsxGateway (cópia, só leitura)
apps-script/     Codigo.gs — o script que vai dentro da planilha
src/service.ts   preencherAutomatico (um clique) / simularLote / escrita / desfazer
src/regras.ts    tela "Horários e regras" ↔ regras.json local (carregar, validar, salvar)
src/main.ts      bandeja + janelas; src/cli.ts linha de comando
```

## Testes

| Comando | O que roda | Tempo |
|---|---|---|
| `npm test` | compila e roda tudo de `src/__tests__/` (unit, integração, propriedade) | ~1 min |
| `npm run test:unit` / `test:integration` / `test:property` | só uma camada | |
| `npm run test:coverage` | suíte + cobertura; **falha** abaixo de 85% linhas / 80% ramos / 85% funções | ~1 min |
| `npm run test:tz` | a suíte em 7 fusos (UTC, Brasília, +14, −11, +5:30, dois com horário de verão) | ~6 min |
| `npm run test:ui` | **E2E do app real** no Electron: main + preload + as 3 telas, com o ponto simulado e o `Codigo.gs` real numa sandbox fazendo papel do Google — abre janelas por ~1 min | ~1 min |
| `npm run test:all` | tudo acima, menos cobertura | |

Camadas (`src/__tests__/`):

- `unit/` — núcleo puro: datas, normalização, leitor do ponto (HTML e API), layout da aba, regras, plano, relatório, intérprete de comandos.
- `integration/` — fluxos do serviço contra uma planilha em memória (simular → gravar → justificar → desfazer), regras locais, `config.json` com segredos cifrados, os conectores (Secullum, Apps Script, Google Sheets, .xlsx) com rede simulada, o `Codigo.gs` executado de verdade numa sandbox `vm`, e a CLI num processo separado.
- `property/` — centenas de planilhas/pontos aleatórios checando as regras inegociáveis: nunca decide F, só escreve em célula vazia da coluna do dia, idempotente, desfazer devolve a planilha exatamente como era. Semente fixa; uma falha mostra como reproduzir (`FUZZ_SEED=… FUZZ_RUNS=1 npm run test:property`).
- `ui/runner.ts` — o E2E. Nada sai pra internet (chamada fora do mundo simulado falha o teste) e nada toca na pasta de dados do app de verdade. `E2E_MANTER=1` guarda a pasta temporária com as capturas de tela.

Cada arquivo de teste roda isolado (`helpers/setup.ts`): pasta de dados, `regras.json` e `config.json` temporários, sem log na pasta do projeto. O CI (`.github/workflows/testes.yml`) roda cobertura, fusos e E2E em Windows.

## Fora do MVP

Saídas/Entradas 2–3, traduzir outras justificativas do ponto (atestado, folga...) em código,
correção das fórmulas de totais.

## Dados sensíveis

Nunca versionar `config.json` (credenciais), cópias `.xlsx` da planilha
(BASE DE DADOS tem CPF e telefones) nem HTML salvo do ponto — o `.gitignore` já bloqueia.
Testes usam só o fixture sintético em `test/fixtures/`.

## Licença

Uso interno, proprietário — ver [LICENSE](LICENSE).
