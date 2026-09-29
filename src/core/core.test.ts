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
import { executarEscrita, simular } from '../service'

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
  async lerCelulas(aba: string, celulas: string[]) {
    return celulas.map(c => {
      const m = /^([A-Z]+)(\d+)$/.exec(c)!
      const col = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
      return this.abas[aba]?.[+m[2]! - 1]?.[col - 1] ?? ''
    })
  }
  async escrever(aba: string, valores: { celula: string; valor: string }[]) {
    for (const v of valores) this.escritas.push({ aba, ...v })
  }
  async criarAba() {}
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

test('parser lê os três estados do ponto e ignora classes geradas', () => {
  const { registros, avisos } = parsePontoHtml(fs.readFileSync(FIXTURE, 'utf-8'))
  assert.deepEqual(avisos, [])
  const por = Object.fromEntries(registros.map(r => [normalize(r.nome), r]))
  assert.equal(registros.length, 8)
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.status, 'batido')
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.entrada1, '07:58')
  assert.equal(por['JOAO EXEMPLO DA SILVA']!.icone, 'verde')
  assert.equal(por['PEDRO TESTE DE ARAUJO']!.entrada1, '08:05')
  assert.equal(por['PAULO MODELO DA SILVA']!.status, 'sem_registro')
  assert.equal(por['ANDRE JOSE DE EXEMPLO']!.status, 'ferias')
  assert.equal(por['ANDRE JOSE DE EXEMPLO']!.entrada1, null)
})

test('parser avisa quando o HTML não é a tela do ponto', () => {
  const r = parsePontoHtml('<html><body><p>Faça login</p></body></html>')
  assert.equal(r.registros.length, 0)
  assert.match(r.avisos[0]!, /Nenhum ícone de status/)
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
  feriados: [['data', 'descricao'], ['07/09/2026', 'Independência']],
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

test('validarData: bloqueia hoje antes do corte, domingo, feriado e futuro', () => {
  const cfg = parseConfigPlanilha(CFG_GRIDS)
  assert.throws(() => validarData('2026-09-28', cfg, new Date(2026, 8, 28, 11, 0), false), /18:00/)
  assert.deepEqual(validarData('2026-09-28', cfg, new Date(2026, 8, 28, 18, 30), false), [])
  assert.throws(() => validarData('2026-09-27', cfg, new Date(2026, 8, 28, 20), false), /domingo/)
  assert.throws(() => validarData('2026-09-07', cfg, new Date(2026, 8, 28, 20), false), /FERIADOS/)
  assert.throws(() => validarData('2026-09-29', cfg, new Date(2026, 8, 28, 20), true), /futuro/)
  assert.equal(validarData('2026-09-07', cfg, new Date(2026, 8, 28, 20), true).length, 1)
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
  const base = [['Nº', 'ADM', 'Colaborador'], ['1', '9999', 'FELIPE SEMLINHA DE FARIA']]
  return new MemoryGateway({ 'BASE DE DADOS': base, Setembro: setembro, CONFIG_GERAL: CFG_GRIDS.geral, CONFIG_HORARIOS: CFG_GRIDS.horarios, CONFIG_EXCECOES: CFG_GRIDS.excecoes, CONFIG_APELIDOS: CFG_GRIDS.apelidos, CONFIG_FERIADOS: CFG_GRIDS.feriados })
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
  assert.equal(por('SERGIO ATESTADO QUEIROZ').situacao, 'ja_lancado')
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

test('recusa planilha de outro ano', async () => {
  const gw = cenario()
  await assert.rejects(simular(gw, { data: '2027-01-05', html: '', now: new Date(2027, 0, 6) }), /é de 2026/)
})
