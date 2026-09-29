import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { parsePontoHtml } from './pontoParser'
import { detectarLayout, LayoutInvalidoError, nomeAbaDoMes } from './layoutMes'
import { parseConfigPlanilha, resolverHorario } from './configPlanilha'
import { validarData } from './planner'
import { colunaA1, parseDataPlanilha, parseHora } from './tempo'
import { normalize } from './normalize'
import type { SheetGateway } from '../sheets/gateway'
import { desfazerEscrita, executarEscrita, executarEscritaLote, preencherAutomatico, simular, simularLote } from '../service'
import { registrosDaApi } from './pontoApi'
import { PontoAuthError } from '../ponto/secullum'
import { carregarRegras, salvarRegras, validarRegras } from '../regras'
import { AppsScriptGateway } from '../sheets/appsScriptGateway'

const FIXTURE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'ponto-sintetico.html')
const LETRAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

// Aba de mês no layout observado na cópia real: linha 6 = dias da semana,
// linha 7 = cabeçalho (ADM em C, colaborador em D, dia 1 em G), dados a partir
// da linha 8. `dias` permite montar cabeçalhos quebrados como os de Maio/Julho.
function gridMes(ano: number, mes: number, linhas: [string, string, Record<number, string>?][], dias?: number[]): string[][] {
  const seq = dias ?? Array.from({ length: 31 }, (_, i) => i + 1)
  const g: string[][] = Array.from({ length: 7 + linhas.length }, () => [])
  g[6]![1] = 'Nº'; g[6]![2] = 'ADM'; g[6]![3] = 'COLABORADOR'; g[6]![4] = 'SETOR'; g[6]![5] = 'Função'
  seq.forEach((d, i) => {
    g[6]![6 + i] = String(d)
    g[5]![6 + i] = LETRAS[new Date(ano, mes - 1, d).getDay()]!
  })
  g[6]![6 + seq.length + 1] = 'FALTA'
  linhas.forEach(([adm, nome, cel], i) => {
    const r = g[7 + i]!
    r[2] = adm; r[3] = nome
    for (const [d, v] of Object.entries(cel ?? {})) r[6 + Number(d) - 1] = v
  })
  return g.map(r => Array.from(r, v => v ?? ''))
}

class MemoryGateway implements SheetGateway {
  descricao = 'memória'
  escritas: { aba: string; celula: string; valor: string }[] = []
  constructor(public abas: Record<string, string[][]>, private tit = '[SR] - Frequência logística 2026') {}
  async titulo() { return this.tit }
  async listarAbas() { return Object.keys(this.abas) }
  async lerGrid(aba: string) { return this.abas[aba] ?? null }
  private pos(c: string): [number, number] {
    const m = /^([A-Z]+)(\d+)$/.exec(c)!
    return [+m[2]! - 1, [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1]
  }
  async lerCelulas(aba: string, celulas: string[]) {
    return celulas.map(c => { const [r, k] = this.pos(c); return this.abas[aba]?.[r]?.[k] ?? '' })
  }
  async escrever(aba: string, valores: { celula: string; valor: string }[]) {
    for (const v of valores) {
      this.escritas.push({ aba, ...v })
      const [r, k] = this.pos(v.celula)
      this.abas[aba]![r]![k] = v.valor
    }
  }
  async limpar(aba: string, celulas: string[]) {
    for (const c of celulas) { const [r, k] = this.pos(c); this.abas[aba]![r]![k] = '' }
  }
  ocultas: Record<string, Set<number>> = {}
  async colunasOcultas(aba: string) { return this.ocultas[aba] ?? new Set<number>() }
  async criarAba() {}
  async substituirTabela(aba: string, linhas: string[][]) { this.abas[aba] = linhas.map(l => [...l]) }
}

// ── utilitários ─────────────────────────────────────────────────────────────

test('normalize tira acento, caixa e espaços', () => {
  assert.equal(normalize('  Ândréa  Fictícia '), 'ANDREA FICTICIA')
  assert.equal(normalize('PEDRO TESTE DE ARAUJO '), 'PEDRO TESTE DE ARAUJO')
})

test('parseHora e datas da planilha', () => {
  assert.equal(parseHora('8:05'), 485)
  assert.equal(parseHora('08:05:00'), 485)
  assert.equal(parseHora('0.3333333333'), 480)
  assert.equal(parseHora('25:00'), null)
  assert.equal(parseDataPlanilha('28/09/2026'), '2026-09-28')
  assert.equal(parseDataPlanilha('46293'), '2026-09-28')
  assert.equal(colunaA1(34), 'AH')
  assert.equal(colunaA1(52), 'AZ')
})

// ── parser do ponto ─────────────────────────────────────────────────────────

test('parser lê os estados do ponto pela estrutura real (dia-resumido + posição)', () => {
  const { data, registros, avisos } = parsePontoHtml(fs.readFileSync(FIXTURE, 'utf-8'))
  assert.deepEqual(avisos, [])
  assert.equal(data, '2026-09-28')
  const por = Object.fromEntries(registros.map(r => [normalize(r.nome), r]))
  assert.equal(registros.length, 9)
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.status, 'batido')
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.entrada1, '07:58')
  // Triângulo amarelo (entrada + saída de almoço) — não previsto no plano,
  // era ignorado pela primeira versão do parser.
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.icone, 'amarelo')
  assert.equal(por['LUIZ EXCECAO OLIVEIRA']!.entrada1, '09:30')
  assert.equal(por['PEDRO TESTE DE ARAUJO']!.entrada1, '08:05')
  assert.equal(por['PAULO MODELO DA SILVA']!.status, 'sem_registro')
  assert.equal(por['ANDRE JOSE DE EXEMPLO']!.status, 'ferias')
  assert.equal(por['ANDRE JOSE DE EXEMPLO']!.entrada1, null)
  // Entrada 1 vazia com Saída 1 preenchida: não chuta, vai pra revisão.
  assert.equal(por['OTAVIO SEMENTRADA']!.status, 'desconhecido')
})

test('parser avisa quando o HTML não é a tela do ponto', () => {
  const r = parsePontoHtml('<html><body><p>Faça login</p></body></html>')
  assert.equal(r.registros.length, 0)
  assert.equal(r.data, null)
  assert.match(r.avisos[0]!, /dia-resumido/)
})

// ── layout da aba do mês ────────────────────────────────────────────────────

test('layout: acha colunas pelo cabeçalho e avisa sobre o dia 31 de setembro preenchido', () => {
  const g = gridMes(2026, 9, [['2082', 'ALAN', { 28: '.', 31: 'FE' }]])
  const l = detectarLayout('Setembro', g, 2026, 9)
  assert.equal(l.linhaCabecalho, 7)
  assert.equal(l.colAdm, 3)
  assert.equal(l.colunaDoDia.get(1), 7)
  assert.equal(colunaA1(l.colunaDoDia.get(28)!), 'AH')
  assert.equal(l.colunaDoDia.has(31), false)
  assert.match(l.avisos.join('\n'), /AK.*dia 31.*1 célula/)
})

test('layout: recusa cabeçalho com dia repetido (como Julho) e com dia faltando (como Maio)', () => {
  const julho = [1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 13, 14, 14, 15, 16, 17, 18, 20, 21, 21, 22, 23, 24, 25, 27, 28, 28, 29, 30, 31]
  assert.throws(() => detectarLayout('Julho', gridMes(2026, 7, [['1', 'X']], julho), 2026, 7), LayoutInvalidoError)
  const maio = [1, 2, ...Array.from({ length: 28 }, (_, i) => i + 4)]
  assert.throws(() => detectarLayout('Maio', gridMes(2026, 5, [['1', 'X']], maio), 2026, 5), /fora de sequência/)
})

test('layout: acha a aba do mês com acento', () => {
  assert.equal(nomeAbaDoMes(['BASE DE DADOS', 'Março', 'Abril'], 3), 'Março')
  assert.throws(() => nomeAbaDoMes(['Abril'], 3), /não encontrada/)
})

// ── configuração ────────────────────────────────────────────────────────────

const CFG_GRIDS = {
  geral: [['tolerancia_min', 'entrada_padrao', 'horario_corte'], ['5', '08:00', '18:00']],
  horarios: [
    ['adm', 'entrada', 'saida', 'tolerancia_min', 'vigencia_inicio', 'vigencia_fim'],
    ['76', '07:00', '', '', '', '2026-09-15'],
    ['76', '07:30', '', '10', '2026-09-16', ''],
  ],
  excecoes: [['data', 'adm', 'entrada_prevista', 'codigo', 'obs'], ['28/09/2026', '771', '10:00', '', 'avisou'], ['28/09/2026', '143', '', 'AT', '']],
  apelidos: [['nome_no_ponto', 'adm']],
}

test('horário previsto: exceção > individual vigente > padrão', () => {
  const cfg = parseConfigPlanilha(CFG_GRIDS)
  assert.deepEqual(cfg.avisos, [])
  assert.equal(resolverHorario(cfg, '76', '2026-09-10').entradaMin, 7 * 60)
  const h = resolverHorario(cfg, '76', '2026-09-28')
  assert.equal(h.entradaMin, 7 * 60 + 30)
  assert.equal(h.toleranciaMin, 10)
  assert.equal(resolverHorario(cfg, '771', '2026-09-28').entradaMin, 10 * 60)
  assert.equal(resolverHorario(cfg, '999', '2026-09-28').origem, 'padrão')
})

test('validarData: "forçar" libera só o horário de corte; futuro nunca', () => {
  const cfg = parseConfigPlanilha(CFG_GRIDS)
  assert.throws(() => validarData('2026-09-28', cfg, new Date(2026, 8, 28, 11, 0), false), /18:00/)
  assert.equal(validarData('2026-09-28', cfg, new Date(2026, 8, 28, 11, 0), true).length, 1)
  assert.deepEqual(validarData('2026-09-28', cfg, new Date(2026, 8, 28, 18, 30), false), [])
  assert.throws(() => validarData('2026-09-29', cfg, new Date(2026, 8, 28, 20), true), /futuro/)
})

test('layout: coluna oculta vira dia não útil; domingo é não útil mesmo visível', () => {
  const g = gridMes(2026, 9, [['1', 'X']])
  const l = detectarLayout('Setembro', g, 2026, 9, new Set([6 + 7])) // coluna do dia 7 oculta
  assert.equal(l.diasNaoUteis.get(7), 'coluna oculta')
  assert.equal(l.diasNaoUteis.get(27), 'domingo')
  assert.equal(l.diasNaoUteis.has(28), false)
})

// ── fluxo completo (simular + escrever) ─────────────────────────────────────

function cenario() {
  const setembro = gridMes(2026, 9, [
    ['374', 'JOAO EXEMPLO DA SILVA'],                          // 07:58 → .
    ['2376', 'PEDRO TESTE DE ARAUJO'],                   // 08:05 → . (tolerância inclusiva)
    ['76', 'MARCOS FICTICIO PEREIRA'],                       // 08:06, individual 07:30+10 → P
    ['2554', 'PAULO MODELO DA SILVA'],                       // sem registro → revisar
    ['1040', 'ANDRE JOSE DE EXEMPLO', { 28: 'FE' }],          // férias, já lançado → confere
    ['1417', 'RAIMUNDO DAS NEVES PRADO DOS'],              // nome truncado → sugestão
    ['771', 'LUIZ EXCECAO OLIVEIRA', { 28: 'FO' }],         // 09:30 c/ exceção 10:00 → '.', mas célula FO → diverge
    ['147', 'SERGIO ATESTADO QUEIROZ', { 28: 'AT' }],        // fora do ponto, lançado à mão
    ['143', 'RENATO FORCADO BUENO'],                         // fora do ponto, código forçado AT
    ['1069', 'NELSON AUSENTE CAMPOS'],                      // fora do ponto, vazio
  ])
  const outubro = gridMes(2026, 10, [['374', 'JOAO EXEMPLO DA SILVA']])
  const base = [['Nº', 'ADM', 'Colaborador'], ['1', '9999', 'FELIPE SEMLINHA DE FARIA']]
  const gw = new MemoryGateway({ 'BASE DE DADOS': base, Setembro: setembro, Outubro: outubro, CONFIG_GERAL: CFG_GRIDS.geral, CONFIG_HORARIOS: CFG_GRIDS.horarios, CONFIG_EXCECOES: CFG_GRIDS.excecoes, CONFIG_APELIDOS: CFG_GRIDS.apelidos })
  // Como na planilha real: domingos e o feriado de 7/09 com a coluna oculta
  // (dia d fica na coluna 6 + d).
  gw.ocultas['Setembro'] = new Set([6, 7, 13, 20, 27].map(d => 6 + d))
  gw.ocultas['Outubro'] = new Set([4, 11, 12, 18, 25].map(d => 6 + d))
  return gw
}

// O fixture é de 28/09; troca a data do id pra simular outros dias.
function htmlDoDia(data: string): string {
  return fs.readFileSync(FIXTURE, 'utf-8').replace(/dia-resumido-2026-09-28/g, `dia-resumido-${data}`)
}

const NOITE = new Date(2026, 8, 28, 19, 0)

test('simulação classifica cada caso do plano e nunca decide falta', async () => {
  const gw = cenario()
  const plano = await simular(gw, { data: '2026-09-28', html: fs.readFileSync(FIXTURE, 'utf-8'), now: NOITE })
  const por = (nome: string) => plano.itens.find(i => normalize(i.nomePonto ?? i.nomePlanilha) === nome)!

  assert.deepEqual(plano.escritas.map(e => `${e.celula}=${e.codigo}`).sort(), ['AH16=AT', 'AH8=.', 'AH9=.', 'AH10=P'].sort())
  assert.equal(por('PAULO MODELO DA SILVA').situacao, 'revisar')
  assert.equal(por('ANDRE JOSE DE EXEMPLO').situacao, 'confere')
  assert.equal(por('RAIMUNDO DAS NEVES PRADO DOS SANTOS').situacao, 'nao_encontrado')
  assert.match(por('RAIMUNDO DAS NEVES PRADO DOS SANTOS').motivo, /ADM 1417.*CONFIG_APELIDOS/)
  assert.equal(por('FELIPE SEMLINHA DE FARIA').situacao, 'sem_linha_no_mes')
  assert.equal(por('LUIZ EXCECAO OLIVEIRA').situacao, 'divergente')
  assert.equal(por('SERGIO ATESTADO QUEIROZ').situacao, 'ausente_no_ponto')
  assert.equal(por('NELSON AUSENTE CAMPOS').situacao, 'ausente_no_ponto')
  assert.ok(!plano.escritas.some(e => e.codigo === 'F'))
})

test('apelido resolve nome truncado', async () => {
  const gw = cenario()
  gw.abas['CONFIG_APELIDOS'] = [['nome_no_ponto', 'adm'], ['Raimundo das Neves Prado dos Santos', '1417']]
  const plano = await simular(gw, { data: '2026-09-28', html: fs.readFileSync(FIXTURE, 'utf-8'), now: NOITE })
  assert.ok(plano.escritas.some(e => e.celula === 'AH13' && e.codigo === '.'))
})

test('escrita relê as células e pula quem foi preenchido depois da simulação; é idempotente', async () => {
  const gw = cenario()
  const html = fs.readFileSync(FIXTURE, 'utf-8')
  const plano = await simular(gw, { data: '2026-09-28', html, now: NOITE })
  gw.abas['Setembro']![8 - 1]![34 - 1] = 'FO' // alguém lançou AH8 à mão nesse meio tempo
  const r = await executarEscrita(gw, plano)
  assert.deepEqual(r.puladas, [{ celula: 'AH8', valorEncontrado: 'FO' }])
  assert.equal(gw.escritas.length, 3)

  // Aplica as escritas no grid e roda de novo: nada novo a escrever.
  for (const e of gw.escritas) {
    const m = /^AH(\d+)$/.exec(e.celula)!
    gw.abas['Setembro']![+m[1]! - 1]![33] = e.valor
  }
  const plano2 = await simular(gw, { data: '2026-09-28', html, now: NOITE })
  assert.equal(plano2.escritas.length, 0)
})

test('recusa HTML do ponto de um dia diferente do escolhido', async () => {
  const gw = cenario()
  const html = fs.readFileSync(FIXTURE, 'utf-8') // linhas de 2026-09-28
  await assert.rejects(simular(gw, { data: '2026-09-25', html, now: NOITE }), /é do dia 2026-09-28/)
})

test('recusa planilha de outro ano', async () => {
  const gw = cenario()
  await assert.rejects(simular(gw, { data: '2027-01-05', html: '', now: new Date(2027, 0, 6) }), /é de 2026/)
})

// ── tela "Horários e regras" ────────────────────────────────────────────────

test('regras: salva na planilha e a simulação passa a usar o horário individual', async () => {
  const gw = cenario()
  const { regras } = await carregarRegras(gw)
  assert.equal(regras.geral.entrada_padrao, '08:00')
  assert.equal(regras.excecoes[0]!.data, '2026-09-28') // dd/mm/aaaa da planilha → ISO na tela

  regras.horarios.push({ adm: '2376', entrada: '09:00', saida: '', tolerancia_min: '', vigencia_inicio: '2026-09-01', vigencia_fim: '', obs: 'entra 9h' })
  const v = await salvarRegras(gw, regras)
  assert.deepEqual(v.erros, [])
  assert.deepEqual(gw.abas['CONFIG_HORARIOS']!.at(-1), ['2376', '09:00', '', '', '01/09/2026', '', 'entra 9h'])

  const plano = await simular(gw, { data: '2026-09-28', html: fs.readFileSync(FIXTURE, 'utf-8'), now: NOITE })
  const pedro = plano.itens.find(i => i.adm === '2376')!
  assert.equal(pedro.horario!.previsto, '09:00')
  assert.match(pedro.horario!.origem, /CONFIG_HORARIOS/)
})

test('regras: bloqueia salvamento inválido e não toca na planilha', async () => {
  const gw = cenario()
  const antes = JSON.stringify(gw.abas['CONFIG_HORARIOS'])
  const { regras } = await carregarRegras(gw)

  regras.excecoes.push({ data: '2026-09-30', adm: '374', entrada_prevista: '', codigo: 'XX', obs: '' })
  let v = await salvarRegras(gw, regras)
  assert.match(v.erros.join('\n'), /código "XX"/)

  regras.excecoes.pop()
  regras.horarios.push({ adm: '76', entrada: '06:00', saida: '', tolerancia_min: '', vigencia_inicio: '2026-09-20', vigencia_fim: '', obs: '' })
  v = await salvarRegras(gw, regras)
  assert.match(v.erros.join('\n'), /ADM 76: dois horários/)

  regras.horarios.pop()
  regras.geral.entrada_padrao = ''
  v = await salvarRegras(gw, regras)
  assert.match(v.erros.join('\n'), /entrada_padrao/)
  assert.equal(JSON.stringify(gw.abas['CONFIG_HORARIOS']), antes)
})

test('regras: avisa ADM que não existe na BASE DE DADOS', () => {
  const v = validarRegras({
    geral: { tolerancia_min: '5', entrada_padrao: '08:00', horario_corte: '18:00' },
    horarios: [{ adm: '123456', entrada: '09:00', saida: '', tolerancia_min: '', vigencia_inicio: '', vigencia_fim: '', obs: '' }],
    excecoes: [], apelidos: [],
  }, [{ adm: '1', nome: 'X', setor: '', ativo: true }])
  assert.deepEqual(v.erros, [])
  assert.match(v.avisos[0]!, /123456/)
})

// ── desfazer ────────────────────────────────────────────────────────────────

test('desfazer apaga só o que o bot gravou e mantém o que alguém mudou depois', async () => {
  const gw = cenario()
  const plano = await simular(gw, { data: '2026-09-28', html: fs.readFileSync(FIXTURE, 'utf-8'), now: NOITE })
  const antesAH = gw.abas['Setembro']!.map(r => r[33] ?? '')
  const r = await executarEscrita(gw, plano)
  assert.equal(r.escritas.length, 4)

  gw.abas['Setembro']![10 - 1]![33] = 'AT' // AH10: bot gravou "P", alguém trocou por "AT"
  const d = await desfazerEscrita(gw, plano.aba, r.escritas)

  assert.deepEqual(d.apagadas.sort(), ['AH16', 'AH8', 'AH9'].sort())
  assert.deepEqual(d.mantidas, [{ celula: 'AH10', valorEncontrado: 'AT', escritoPeloBot: 'P' }])
  const depoisAH = gw.abas['Setembro']!.map(r => r[33] ?? '')
  // Tudo voltou ao estado de antes, menos a célula que alguém alterou.
  assert.deepEqual(depoisAH.map((v, i) => (i === 9 ? antesAH[i] : v)), antesAH)
  assert.equal(depoisAH[9], 'AT')

  // Desfazer de novo não apaga nada (as células já estão vazias ou mudadas).
  const d2 = await desfazerEscrita(gw, plano.aba, r.escritas)
  assert.deepEqual(d2.apagadas, [])
})

// ── feriados (colunas ocultas) e conferência da semana ─────────────────────

test('feriado com coluna oculta não é preenchido nem com "forçar"', async () => {
  const gw = cenario()
  await assert.rejects(simular(gw, { data: '2026-09-07', html: htmlDoDia('2026-09-07'), now: NOITE, forcar: true }), /coluna oculta.*feriado/)
  await assert.rejects(simular(gw, { data: '2026-09-27', html: htmlDoDia('2026-09-27'), now: NOITE, forcar: true }), /domingo/)
})

test('semana: um plano por dia, pula domingo/feriado, cruza o mês e aponta dia repetido', async () => {
  const gw = cenario()
  const dias = ['2026-09-25', '2026-09-27', '2026-09-28', '2026-09-30', '2026-10-01', '2026-09-07']
  const lote = await simularLote(gw, {
    htmls: [...dias.map(d => ({ arquivo: `${d}.html`, html: htmlDoDia(d) })), { arquivo: 'copia.html', html: htmlDoDia('2026-09-28') }],
    now: new Date(2026, 9, 1, 19, 0),
  })

  assert.deepEqual(lote.planos.map(p => `${p.data}@${p.aba}`), ['2026-09-25@Setembro', '2026-09-28@Setembro', '2026-09-30@Setembro', '2026-10-01@Outubro'])
  assert.deepEqual(lote.pulados.map(p => p.data), ['2026-09-07', '2026-09-27'])
  assert.equal(lote.erros.length, 1)
  assert.match(lote.erros[0]!.motivo, /repetido.*2026-09-28\.html/)
  // Cada dia na sua coluna: 25/09 = AE, 30/09 = AJ, 01/10 = G.
  assert.ok(lote.planos[0]!.escritas.every(e => e.celula.startsWith('AE')))
  assert.ok(lote.planos[2]!.escritas.every(e => e.celula.startsWith('AJ')))
  assert.deepEqual(lote.planos[3]!.escritas.map(e => e.celula), ['G8'])
})

// Só as células com conteúdo — no grid em memória, "nunca escrita" (undefined)
// e "apagada" ('') são a mesma coisa que numa planilha: célula vazia.
function preenchidas(gw: MemoryGateway): string[] {
  const out: string[] = []
  for (const [aba, grid] of Object.entries(gw.abas)) {
    grid.forEach((linha, r) => linha.forEach((v, c) => { if (v) out.push(`${aba}!${r + 1},${c + 1}=${v}`) }))
  }
  return out
}

test('semana: escreve todos os dias e o desfazer volta tudo', async () => {
  const gw = cenario()
  const antes = preenchidas(gw)
  const lote = await simularLote(gw, {
    htmls: ['2026-09-29', '2026-09-30', '2026-10-01'].map(d => ({ arquivo: d, html: htmlDoDia(d) })),
    now: new Date(2026, 9, 1, 19, 0),
  })
  const { dias, erro } = await executarEscritaLote(gw, lote.planos)
  assert.equal(erro, null)
  assert.deepEqual(dias.map(d => d.data), ['2026-09-29', '2026-09-30', '2026-10-01'])
  assert.notDeepEqual(preenchidas(gw), antes)

  for (const d of dias) await desfazerEscrita(gw, d.aba, d.escritas)
  assert.deepEqual(preenchidas(gw), antes)
})

test('semana: falha no meio devolve os dias já gravados (pro Desfazer)', async () => {
  const gw = cenario()
  const lote = await simularLote(gw, {
    htmls: ['2026-09-29', '2026-10-01'].map(d => ({ arquivo: d, html: htmlDoDia(d) })),
    now: new Date(2026, 9, 1, 19, 0),
  })
  const escreverOriginal = gw.escrever.bind(gw)
  gw.escrever = async (aba, valores) => {
    if (aba === 'Outubro') throw new Error('sem rede')
    return escreverOriginal(aba, valores)
  }
  const { dias, erro } = await executarEscritaLote(gw, lote.planos)
  assert.deepEqual(dias.map(d => d.data), ['2026-09-29'])
  assert.match(erro!, /2026-10-01.*sem rede/)
})

test('regras: mostra os feriados encontrados (colunas ocultas que não são domingo)', async () => {
  const gw = cenario()
  const r = await carregarRegras(gw, '2026-09-29')
  assert.deepEqual(r.feriados, [{ aba: 'Setembro', dias: [7], erro: null }, { aba: 'Outubro', dias: [12], erro: null }])
})

// ── conector Apps Script (fetch simulado) ───────────────────────────────────

test('Apps Script: manda token+ação, entende {ok,dados} e explica os erros comuns', async () => {
  const URL_OK = 'https://script.google.com/macros/s/ABC123/exec'
  const pedidos: any[] = []
  const original = globalThis.fetch
  let resposta: () => Response = () => new Response(JSON.stringify({ ok: true, dados: { titulo: '[SR] - Frequência logística 2026', abas: ['Setembro'] } }))
  globalThis.fetch = (async (url: string, init: any) => { pedidos.push({ url, corpo: JSON.parse(init.body) }); return resposta() }) as any
  try {
    assert.throws(() => new AppsScriptGateway('https://script.google.com/macros/s/ABC/dev', 't'), /termina(ndo)? em \/exec/)
    const gw = new AppsScriptGateway(URL_OK, 'segredo')
    assert.deepEqual(await gw.listarAbas(), ['Setembro'])
    assert.equal(await gw.titulo(), '[SR] - Frequência logística 2026')
    assert.equal(pedidos.length, 1) // info fica em cache
    assert.deepEqual(pedidos[0].corpo, { token: 'segredo', acao: 'info' })

    resposta = () => new Response(JSON.stringify({ ok: true, dados: [3, 7] }))
    assert.deepEqual([...await gw.colunasOcultas('Setembro')], [3, 7])
    assert.deepEqual(pedidos.at(-1).corpo, { token: 'segredo', acao: 'colunasOcultas', aba: 'Setembro' })

    resposta = () => new Response(JSON.stringify({ ok: false, erro: 'Token inválido.' }))
    await assert.rejects(gw.lerGrid('Setembro'), /Apps Script: Token inválido/)

    resposta = () => new Response('<html>Faça login</html>', { status: 200 })
    await assert.rejects(gw.lerGrid('Setembro'), /Qualquer pessoa/)
  } finally {
    globalThis.fetch = original
  }
})

// ── fluxo de um clique (API do ponto simulada) ──────────────────────────────

// Resposta no formato da API /Batidas/AAAA-MM-DD (nomes fictícios).
function listaApi(feriado = false) {
  const hora = (...h: string[]) => [...h, '', '', '', '', '', ''].slice(0, 6).map(valor => ({ valor }))
  return [
    { funcionarioNome: 'JOAO EXEMPLO DA SILVA', data: '', feriado, batidas: hora('07:58', '12:02'), saldo: '-04:00', situacao: 1 },
    { funcionarioNome: 'PEDRO TESTE DE ARAUJO ', data: '', feriado, batidas: hora('8:05'), saldo: '-08:00', situacao: 2 },
    { funcionarioNome: 'MARCOS FICTICIO PEREIRA', data: '', feriado, batidas: hora('08:06'), saldo: '-08:00', situacao: 2 },
    { funcionarioNome: 'PAULO MODELO DA SILVA', data: '', feriado, batidas: [], saldo: '-08:00', situacao: 2 },
    { funcionarioNome: 'ANDRÉ JOSÉ DE EXEMPLO', data: '', feriado, batidas: Array(6).fill({ valor: 'FÉRIAS' }), saldo: '', situacao: 0 },
    { funcionarioNome: 'OTAVIO SEMENTRADA', data: '', feriado, batidas: hora('', '12:00'), saldo: '-08:00', situacao: 2 },
  ]
}

test('API do ponto: vira os mesmos registros do leitor de HTML', () => {
  const { registros, avisos } = registrosDaApi(listaApi())
  assert.deepEqual(avisos, [])
  const por = Object.fromEntries(registros.map(r => [normalize(r.nome), r]))
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.entrada1, '07:58')
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.icone, 'amarelo')
  assert.equal(por['PEDRO TESTE DE ARAUJO']!.entrada1, '08:05') // "8:05" normalizado
  assert.equal(por['PAULO MODELO DA SILVA']!.status, 'sem_registro')
  assert.equal(por['ANDRE JOSE DE EXEMPLO']!.status, 'ferias')
  assert.equal(por['OTAVIO SEMENTRADA']!.status, 'desconhecido')
})

test('um clique: busca 7 dias, pula domingo sem consultar, hoje antes do corte e feriado; grava o resto', async () => {
  const gw = cenario()
  const consultados: string[] = []
  const ponto = { pontoDiario: async (data: string) => { consultados.push(data); return listaApi() } }
  // Quarta 30/09 às 11h: janela 24/09 (qui) a 30/09 (qua).
  const r = await preencherAutomatico(gw, ponto, { now: new Date(2026, 8, 30, 11, 0) })

  assert.deepEqual(consultados, ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29', '2026-09-30'])
  assert.deepEqual(r.lote.pulados.map(p => p.data), ['2026-09-27', '2026-09-30'])
  assert.match(r.lote.pulados[1]!.motivo, /18:00/) // hoje, antes do horário de corte
  assert.deepEqual(r.lote.planos.map(p => p.data), ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29'])
  assert.equal(r.escrita!.erro, null)
  assert.ok(r.escrita!.dias.every(d => d.escritas.every(e => e.codigo !== 'F')))
  // Gravou de verdade: JOAO (linha 8) na coluna do dia 29 (AI).
  assert.equal(gw.abas['Setembro']![7]![34], '.')
})

test('um clique em modo "só conferir" não grava nada', async () => {
  const gw = cenario()
  const antes = preenchidas(gw)
  const r = await preencherAutomatico(gw, { pontoDiario: async () => listaApi() }, { now: new Date(2026, 8, 30, 19, 0), apenasConferir: true })
  assert.equal(r.escrita, null)
  assert.ok(r.lote.planos.some(p => p.escritas.length > 0))
  assert.deepEqual(preenchidas(gw), antes)
})

test('um clique: feriado no ponto com coluna visível vira aviso; senha errada para tudo', async () => {
  const gw = cenario()
  const r = await preencherAutomatico(gw, { pontoDiario: async (d: string) => listaApi(d === '2026-09-29') }, { now: new Date(2026, 8, 30, 19, 0), apenasConferir: true })
  assert.match(r.lote.planos.find(p => p.data === '2026-09-29')!.avisos.join('\n'), /marca 2026-09-29 como feriado/)

  const semAcesso = { pontoDiario: async () => { throw new PontoAuthError('Número ou senha do ponto inválidos.') } }
  await assert.rejects(preencherAutomatico(gw, semAcesso, { now: new Date(2026, 8, 30, 19, 0) }), /senha do ponto/)
})
