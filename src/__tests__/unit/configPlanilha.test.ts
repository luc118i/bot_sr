import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { codigoForcado, parseConfigPlanilha, resolverHorario, type GridsConfig } from '../../core/configPlanilha'

const GERAL = [['tolerancia_min', 'entrada_padrao', 'horario_corte'], ['5', '08:00', '18:00']]
const HDR_HOR = ['adm', 'entrada', 'saida', 'tolerancia_min', 'vigencia_inicio', 'vigencia_fim']
const HDR_EXC = ['data', 'adm', 'entrada_prevista', 'codigo', 'obs']

const grids = (g: Partial<GridsConfig> = {}): GridsConfig => ({ geral: GERAL, horarios: null, excecoes: null, apelidos: null, ...g })

const CFG_GRIDS: GridsConfig = {
  geral: GERAL,
  horarios: [HDR_HOR, ['76', '07:00', '', '', '', '2026-09-15'], ['76', '07:30', '', '10', '2026-09-16', '']],
  excecoes: [HDR_EXC, ['28/09/2026', '771', '10:00', '', 'avisou'], ['28/09/2026', '143', '', 'AT', '']],
  apelidos: [['nome_no_ponto', 'adm']],
}

describe('parseConfigPlanilha: padrão', () => {
  it('lê tolerância, entrada e corte', () => {
    const c = parseConfigPlanilha(grids())
    assert.deepEqual(c.geral, { toleranciaMin: 5, entradaPadraoMin: 480, horarioCorteMin: 1080 })
    assert.deepEqual(c.avisos, [])
  })

  it('tolerância ausente, negativa ou texto → erro', () => {
    for (const t of ['', '-1', 'cinco']) {
      assert.throws(() => parseConfigPlanilha(grids({ geral: [GERAL[0]!, [t, '08:00', '']] })), /tolerância/, t)
    }
  })

  it('tolerância 0 é válida', () => {
    assert.equal(parseConfigPlanilha(grids({ geral: [GERAL[0]!, ['0', '08:00', '']] })).geral.toleranciaMin, 0)
  })

  it('entrada padrão inválida → erro', () => {
    assert.throws(() => parseConfigPlanilha(grids({ geral: [GERAL[0]!, ['5', '8h', '']] })), /entrada padrão/)
  })

  it('sem horário de corte = null; corte inválido vira aviso e é ignorado', () => {
    assert.equal(parseConfigPlanilha(grids({ geral: [GERAL[0]!, ['5', '08:00', '']] })).geral.horarioCorteMin, null)
    const c = parseConfigPlanilha(grids({ geral: [GERAL[0]!, ['5', '08:00', '25:00']] }))
    assert.equal(c.geral.horarioCorteMin, null)
    assert.match(c.avisos[0]!, /corte inválido/)
  })

  it('overrides da CLI ganham da tabela', () => {
    const c = parseConfigPlanilha(grids(), { toleranciaMin: 15, entradaPadrao: '07:00' })
    assert.equal(c.geral.toleranciaMin, 15)
    assert.equal(c.geral.entradaPadraoMin, 420)
  })

  it('cabeçalho com caixa/acento/espaço diferentes ainda é lido', () => {
    const c = parseConfigPlanilha(grids({ geral: [['Tolerância Min', 'Entrada Padrão', 'Horário Corte'], ['5', '08:00', '18:00']] }))
    assert.equal(c.geral.horarioCorteMin, 1080)
  })
})

describe('parseConfigPlanilha: itens', () => {
  it('cenário completo sem avisos', () => {
    const cfg = parseConfigPlanilha(CFG_GRIDS)
    assert.deepEqual(cfg.avisos, [])
    assert.equal(cfg.horarios.length, 2)
    assert.equal(cfg.excecoes.length, 2)
  })

  it('linhas em branco são puladas e o número do item continua batendo com a tela', () => {
    const c = parseConfigPlanilha(grids({ horarios: [HDR_HOR, ['', '', '', '', '', ''], ['9', 'xx', '', '', '', '']] }))
    assert.match(c.avisos[0]!, /item 2/)
  })

  it('horário individual com tolerância inválida → aviso (não usa o padrão em silêncio)', () => {
    const c = parseConfigPlanilha(grids({ horarios: [HDR_HOR, ['9', '07:00', '', 'dez', '', '']] }))
    assert.match(c.avisos.join('\n'), /item 1.*tolerância/)
  })

  it('horário individual com vigência inválida → aviso e item ignorado (não vale "pra sempre")', () => {
    for (const [ini, fim] of [['31/02/2026', ''], ['', 'amanhã'], ['2026-13-01', '']]) {
      const c = parseConfigPlanilha(grids({ horarios: [HDR_HOR, ['9', '07:00', '', '', ini!, fim!]] }))
      assert.equal(c.horarios.length, 0, `${ini}|${fim}`)
      assert.match(c.avisos.join('\n'), /item 1.*vigência/, `${ini}|${fim}`)
    }
  })

  it('vigência com início depois do fim → aviso', () => {
    const c = parseConfigPlanilha(grids({ horarios: [HDR_HOR, ['9', '07:00', '', '', '2026-09-30', '2026-09-01']] }))
    assert.match(c.avisos.join('\n'), /item 1.*vigência/)
  })

  it('exceção: data/ADM/código/entrada inválidos → aviso e item ignorado', () => {
    const c = parseConfigPlanilha(grids({
      excecoes: [HDR_EXC,
        ['', '1', '09:00', '', ''],
        ['2026-09-28', '', '09:00', '', ''],
        ['2026-09-28', '1', '', 'XX', ''],
        ['2026-09-28', '1', '9h', '', ''],
        ['31/02/2026', '1', '09:00', '', ''],
      ],
    }))
    assert.equal(c.excecoes.length, 0)
    assert.equal(c.avisos.length, 5)
  })

  it('apelidos: nome normalizado, ADM canônico; linha incompleta ignorada', () => {
    const c = parseConfigPlanilha(grids({ apelidos: [['nome_no_ponto', 'adm'], ['  joão  silva ', '12.0'], ['SEM ADM', '']] }))
    assert.deepEqual(c.apelidos, [{ nomePonto: 'JOAO SILVA', adm: '12' }])
  })
})

describe('resolverHorario / codigoForcado', () => {
  it('exceção > individual vigente > padrão', () => {
    const cfg = parseConfigPlanilha(CFG_GRIDS)
    assert.equal(resolverHorario(cfg, '76', '2026-09-10').entradaMin, 7 * 60)
    const h = resolverHorario(cfg, '76', '2026-09-28')
    assert.equal(h.entradaMin, 7 * 60 + 30)
    assert.equal(h.toleranciaMin, 10)
    assert.equal(resolverHorario(cfg, '771', '2026-09-28').entradaMin, 10 * 60)
    assert.equal(resolverHorario(cfg, '999', '2026-09-28').origem, 'padrão')
  })

  it('vigência é inclusiva nas duas pontas', () => {
    const cfg = parseConfigPlanilha(CFG_GRIDS)
    assert.equal(resolverHorario(cfg, '76', '2026-09-15').entradaMin, 7 * 60)
    assert.equal(resolverHorario(cfg, '76', '2026-09-16').entradaMin, 7 * 60 + 30)
  })

  it('exceção sem entrada prevista (só código) não muda o horário', () => {
    const cfg = parseConfigPlanilha(CFG_GRIDS)
    assert.equal(resolverHorario(cfg, '143', '2026-09-28').origem, 'padrão')
    assert.equal(codigoForcado(cfg, '143', '2026-09-28')?.codigoForcado, 'AT')
    assert.equal(codigoForcado(cfg, '143', '2026-09-29'), null)
  })

  it('exceção de horário mantém a tolerância do horário individual', () => {
    const cfg = parseConfigPlanilha({
      ...CFG_GRIDS,
      excecoes: [HDR_EXC, ['2026-09-28', '76', '09:00', '', '']],
    })
    const h = resolverHorario(cfg, '76', '2026-09-28')
    assert.equal(h.entradaMin, 9 * 60)
    assert.equal(h.toleranciaMin, 10)
    assert.match(h.origem, /exceção/)
  })
})
