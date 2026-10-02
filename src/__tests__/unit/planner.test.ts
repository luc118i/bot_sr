import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfigPlanilha, type GridsConfig } from '../../core/configPlanilha'
import { detectarLayout } from '../../core/layoutMes'
import {
  AntesDoCorteError, contarPendencias, decidir, DiaNaoUtilError, montarPlano, recontarResumo, validarData, type EntradaPlano,
} from '../../core/planner'
import type { PontoRegistro } from '../../core/pontoParser'
import { colDoDia, gridMes, NOITE } from '../helpers/planilha'

const GERAL = [['tolerancia_min', 'entrada_padrao', 'horario_corte'], ['5', '08:00', '18:00']]
const cfgDe = (g: Partial<GridsConfig> = {}) => parseConfigPlanilha({ geral: GERAL, horarios: null, excecoes: null, apelidos: null, ...g })
const cfg = cfgDe()

const reg = (nome: string, entrada1: string | null, status: PontoRegistro['status'] = 'batido'): PontoRegistro =>
  ({ nome, icone: 'verde', status, entrada1, textos: [nome] })

function entrada(linhas: [string, string, Record<number, string>?][], registros: PontoRegistro[], extra: Partial<EntradaPlano> = {}): EntradaPlano {
  const grid = gridMes(2026, 9, linhas)
  const layout = detectarLayout('Setembro', grid, 2026, 9, new Set([colDoDia(7)]))
  return { data: '2026-09-28', registros, layout, grid, cfg, now: NOITE, ...extra }
}

describe('decidir', () => {
  const h = { entradaMin: 480, toleranciaMin: 5, origem: 'padrão' }
  it('limite da tolerância é inclusivo: 08:05 = ".", 08:06 = "P"', () => {
    assert.equal(decidir(reg('A', '08:05'), h).codigo, '.')
    assert.equal(decidir(reg('A', '08:06'), h).codigo, 'P')
    assert.match(decidir(reg('A', '08:06'), h).motivo, /atraso de 1 min/)
    assert.equal(decidir(reg('A', '00:00'), h).codigo, '.')
  })
  it('tolerância zero: só o minuto exato é pontual', () => {
    const h0 = { ...h, toleranciaMin: 0 }
    assert.equal(decidir(reg('A', '08:00'), h0).codigo, '.')
    assert.equal(decidir(reg('A', '08:01'), h0).codigo, 'P')
  })
  it('férias → FE; sem registro e desconhecido → nada (revisão)', () => {
    assert.equal(decidir(reg('A', null, 'ferias'), h).codigo, 'FE')
    assert.equal(decidir(reg('A', null, 'sem_registro'), h).codigo, null)
    assert.equal(decidir(reg('A', null, 'desconhecido'), h).codigo, null)
  })
  it('batido com entrada ilegível → nada', () => {
    assert.equal(decidir(reg('A', '99:99'), h).codigo, null)
  })
  it('NUNCA devolve "F", qualquer que seja a entrada', () => {
    for (const st of ['batido', 'sem_registro', 'ferias', 'desconhecido'] as const) {
      for (const e of [null, '', '07:00', '23:59', 'lixo']) assert.notEqual(decidir(reg('A', e, st), h).codigo, 'F')
    }
  })
})

describe('validarData', () => {
  it('"forçar" libera só o horário de corte; futuro nunca', () => {
    assert.throws(() => validarData('2026-09-28', cfg, new Date(2026, 8, 28, 11, 0), false), /18:00/)
    assert.equal(validarData('2026-09-28', cfg, new Date(2026, 8, 28, 11, 0), true).length, 1)
    assert.deepEqual(validarData('2026-09-28', cfg, new Date(2026, 8, 28, 18, 30), false), [])
    assert.throws(() => validarData('2026-09-29', cfg, new Date(2026, 8, 28, 20), true), /futuro/)
  })
  it('exatamente no horário de corte já pode', () => {
    assert.deepEqual(validarData('2026-09-28', cfg, new Date(2026, 8, 28, 18, 0), false), [])
    assert.throws(() => validarData('2026-09-28', cfg, new Date(2026, 8, 28, 17, 59), false), AntesDoCorteError)
  })
  it('hoje sem horário de corte configurado → bloqueia (forçar libera)', () => {
    const semCorte = cfgDe({ geral: [GERAL[0]!, ['5', '08:00', '']] })
    assert.throws(() => validarData('2026-09-28', semCorte, NOITE, false), /não há horário de corte/)
    assert.match(validarData('2026-09-28', semCorte, NOITE, true)[0]!, /^FORÇADO/)
  })
  it('dia anterior a hoje nunca bloqueia, nem antes do corte', () => {
    assert.deepEqual(validarData('2026-09-27', cfg, new Date(2026, 8, 28, 6, 0), false), [])
  })
  it('data inválida → erro', () => {
    assert.throws(() => validarData('2026-02-30', cfg, NOITE, true), /inexistente/)
  })
})

describe('montarPlano: proteções', () => {
  it('célula preenchida NUNCA é escrita, nem com código igual', () => {
    const e = entrada([['1', 'ANA', { 28: '.' }], ['2', 'BIA', { 28: 'FO' }], ['3', 'CAU', { 28: '-' }]],
      [reg('ANA', '07:50'), reg('BIA', '07:50'), reg('CAU', '07:50')])
    const p = montarPlano(e)
    assert.deepEqual(p.escritas, [])
    assert.deepEqual(p.itens.map(i => i.situacao), ['confere', 'divergente', 'divergente'])
  })

  it('célula só com espaços conta como preenchida (não sobrescreve)', () => {
    const p = montarPlano(entrada([['1', 'ANA', { 28: '  ' }]], [reg('ANA', '07:50')]))
    assert.deepEqual(p.escritas, [])
    assert.equal(p.itens[0]!.situacao, 'ja_lancado')
    assert.match(p.itens[0]!.motivo, /só espaços/)
  })

  it('código igual com caixa diferente ("p" × "P") confere', () => {
    const p = montarPlano(entrada([['1', 'ANA', { 28: 'p' }]], [reg('ANA', '09:00')]))
    assert.equal(p.itens[0]!.situacao, 'confere')
  })

  it('sem ponto não vira F; vai pra revisão', () => {
    const p = montarPlano(entrada([['1', 'ANA']], [reg('ANA', null, 'sem_registro')]))
    assert.deepEqual(p.escritas, [])
    assert.equal(p.itens[0]!.situacao, 'revisar')
    assert.equal(contarPendencias(p), 1)
  })

  it('duas pessoas do ponto na mesma linha (nome + apelido) → nenhuma escreve', () => {
    const c = cfgDe({ apelidos: [['nome_no_ponto', 'adm'], ['ANINHA', '1']] })
    const p = montarPlano(entrada([['1', 'ANA']], [reg('ANA', '07:50'), reg('ANINHA', '07:55')], { cfg: c }))
    assert.deepEqual(p.escritas, [])
    assert.ok(p.itens.filter(i => i.nomePonto).every(i => i.situacao === 'ambiguo'))
  })

  it('ADM repetido na aba bloqueia a escrita das duas linhas', () => {
    const p = montarPlano(entrada([['5', 'ANA'], ['5', 'BIA']], [reg('ANA', '07:50'), reg('BIA', '07:50')]))
    assert.deepEqual(p.escritas, [])
  })

  it('código forçado pra quem não aparece no ponto é escrito; sem código fica "fora do ponto"', () => {
    const c = cfgDe({ excecoes: [['data', 'adm', 'entrada_prevista', 'codigo'], ['2026-09-28', '2', '', 'AT']] })
    const p = montarPlano(entrada([['1', 'ANA'], ['2', 'BIA']], [], { cfg: c }))
    assert.deepEqual(p.escritas.map(e => `${e.celula}=${e.codigo}`), ['AH9=AT'])
    assert.equal(p.itens.find(i => i.adm === '1')!.situacao, 'ausente_no_ponto')
  })

  it('exceção permanente vale na decisão e aparece no motivo', () => {
    const c = cfgDe({ excecoes: [['data', 'adm', 'entrada_prevista', 'codigo', 'recorrente'], ['', '1', '09:00', '', 'sempre'], ['', '2', '', 'FO', 'sempre']] })
    const p = montarPlano(entrada([['1', 'ANA'], ['2', 'BIA']], [reg('ANA', '09:04')], { cfg: c }))
    assert.deepEqual(p.escritas.map(e => `${e.celula}=${e.codigo}`), ['AH8=.', 'AH9=FO'])
    assert.match(p.itens.find(i => i.adm === '1')!.horario!.origem, /exceção permanente/)
    assert.match(p.itens.find(i => i.adm === '2')!.motivo, /exceção permanente.*não aparece no ponto/)
  })

  it('caso real: permanente 09:00 salva com código "." — decide pelo ponto de cada dia', () => {
    const c = cfgDe({ excecoes: [['data', 'adm', 'entrada_prevista', 'codigo', 'recorrente'], ['', '1', '09:00', '.', 'sempre']] })
    const dec = (h: string) => montarPlano(entrada([['1', 'CARLOS']], [reg('CARLOS', h)], { cfg: c })).escritas[0]?.codigo
    assert.equal(dec('08:56'), '.')   // antes do previsto, dentro da tolerância
    assert.equal(dec('08:30'), '.')   // chegar cedo nunca é atraso
    assert.equal(dec('09:05'), '.')   // limite da tolerância (inclusivo)
    assert.equal(dec('09:06'), 'P')
    assert.equal(dec('13:10'), 'P')   // antes era "." forçado — o bug
    const p = montarPlano(entrada([['1', 'CARLOS']], [reg('CARLOS', '13:10')], { cfg: c }))
    assert.doesNotMatch(p.itens[0]!.motivo, /forçado/)
  })

  it('código forçado ganha do ponto (ex.: atestado mesmo tendo batido)', () => {
    const c = cfgDe({ excecoes: [['data', 'adm', 'entrada_prevista', 'codigo'], ['2026-09-28', '1', '', 'AC']] })
    const p = montarPlano(entrada([['1', 'ANA']], [reg('ANA', '09:30')], { cfg: c }))
    assert.deepEqual(p.escritas.map(e => e.codigo), ['AC'])
  })

  it('escritas só na coluna do dia pedido', () => {
    const p = montarPlano(entrada([['1', 'ANA'], ['2', 'BIA']], [reg('ANA', '07:50'), reg('BIA', '09:00')]))
    assert.ok(p.escritas.every(e => e.coluna === colDoDia(28) && e.celula.startsWith('AH')))
  })

  it('domingo e coluna oculta → DiaNaoUtilError (nem com forçar)', () => {
    assert.throws(() => montarPlano(entrada([['1', 'A']], [], { data: '2026-09-27', forcar: true })), DiaNaoUtilError)
    assert.throws(() => montarPlano(entrada([['1', 'A']], [], { data: '2026-09-07', forcar: true })), /coluna oculta/)
  })

  it('resumo bate com os itens e recontarResumo é idempotente', () => {
    const p = montarPlano(entrada([['1', 'ANA'], ['2', 'BIA', { 28: 'FO' }], ['3', 'CAU']],
      [reg('ANA', '07:50'), reg('BIA', '07:50'), reg('ZÉ NINGUÉM', '08:00')]))
    const total = Object.values(p.resumo).reduce((a, b) => a + b, 0)
    assert.equal(total, p.itens.length)
    const antes = { ...p.resumo }
    recontarResumo(p)
    assert.deepEqual(p.resumo, antes)
  })

  it('avisos do layout e da configuração chegam ao plano', () => {
    const e = entrada([['5', 'ANA'], ['5', 'BIA']], [])
    assert.match(montarPlano(e).avisos.join('\n'), /ADM 5 aparece/)
  })
})
