import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { RAIZ_PROJETO } from '../helpers/planilha'

// comando.js é JavaScript puro do renderer (sem build) — carregado como na tela.
const { interpretarComando: c, normalizar } = require(path.join(RAIZ_PROJETO, 'src', 'renderer', 'comando.js')) as {
  interpretarComando: (t: string, hoje: string) => { acao: string; data?: string; simular?: boolean; erro?: string }
  normalizar: (s: string) => string
}
const HOJE = '2026-09-30' // quarta

describe('comando: frases do dia a dia', () => {
  it('frases em português viram ações do bot', () => {
    assert.deepEqual(c('Preencher hoje', HOJE), { acao: 'dia', data: '2026-09-30', simular: false })
    assert.deepEqual(c('conferir semana de 21/09', HOJE), { acao: 'semana', data: '2026-09-21', simular: false })
    assert.deepEqual(c('Conferir semana', HOJE), { acao: 'semana', data: '2026-09-30', simular: false })
    assert.deepEqual(c('simular ontem', HOJE), { acao: 'dia', data: '2026-09-29', simular: true })
    assert.deepEqual(c('preencher segunda', HOJE), { acao: 'dia', data: '2026-09-28', simular: false })
    assert.deepEqual(c('semana passada sem gravar', HOJE), { acao: 'semana', data: '2026-09-23', simular: true })
    assert.deepEqual(c('28/09/2026', HOJE), { acao: 'dia', data: '2026-09-28', simular: false })
    assert.equal(c('Pendências de revisão', HOJE).acao, 'pendencias')
    assert.equal(c('Lançar férias', HOJE).acao, 'ferias')
    assert.equal(c('ferias da Ana em outubro', HOJE).acao, 'ferias')
    assert.equal(c('ver histórico', HOJE).acao, 'historico')
    assert.equal(c('Gerar relatório', HOJE).acao, 'relatorios')
    assert.equal(c('mudar horário do Pedro', HOJE).acao, 'regras')
    assert.equal(c('testar login do ponto', HOJE).acao, 'config')
    assert.match(c('preencher 02/10', HOJE).erro!, /ainda não aconteceu/)
    assert.match(c('preencher 31/09', HOJE).erro!, /não é uma data válida/)
    assert.equal(c('qual a previsão do tempo', HOJE).acao, 'ajuda')
  })

  it('anteontem, sábado, dia da semana igual a hoje', () => {
    assert.equal(c('preencher anteontem', HOJE).data, '2026-09-28')
    assert.equal(c('preencher sábado', HOJE).data, '2026-09-26')
    assert.equal(c('preencher quarta', HOJE).data, HOJE)
    assert.equal(c('preencher domingo', HOJE).acao, 'dia') // "domingo" não é dia de preencher, mas ainda é frase de preencher
  })

  it('ano com 2 dígitos e virada de ano', () => {
    assert.equal(c('preencher 28/09/26', HOJE).data, '2026-09-28')
    assert.equal(c('preencher ontem', '2027-01-01').data, '2026-12-31')
    assert.equal(c('semana passada', '2027-01-04').data, '2026-12-28')
  })

  it('dia/mês sem ano = o mais próximo de hoje (31/12 dito em janeiro é o do ano passado)', () => {
    assert.deepEqual(c('preencher 31/12', '2027-01-02'), { acao: 'dia', data: '2026-12-31', simular: false })
    // Daqui a 2 dias continua sendo "ainda não aconteceu", não o do ano passado.
    assert.match(c('preencher 02/10', HOJE).erro!, /ainda não aconteceu/)
    // Com o ano escrito, futuro continua sendo erro.
    assert.match(c('preencher 31/12/2027', '2027-01-02').erro!, /ainda não aconteceu/)
  })

  it('datas impossíveis viram erro, não outra data', () => {
    for (const d of ['29/02/2026', '00/09', '10/13', '32/01', '31/04']) {
      assert.match(c(`preencher ${d}`, HOJE).erro ?? '', /não é uma data válida/, d)
    }
    assert.equal(c('preencher 29/02/2028', '2028-03-01').data, '2028-02-29')
  })

  it('ano com 3 dígitos ou fora de 2000–2099 vira erro — nunca outra data nem "hoje"', () => {
    for (const t of ['preencher 01/01/202', 'preencher 01/01/0099', 'preencher 01/01/1899', 'preencher 1/1/20266']) {
      const r = c(t, HOJE)
      assert.equal(r.acao, 'ajuda', `${t} → ${JSON.stringify(r)}`)
      assert.ok(r.erro, t)
    }
  })

  it('vazio e só espaços → ajuda', () => {
    assert.deepEqual(c('', HOJE), { acao: 'ajuda' })
    assert.deepEqual(c('   ', HOJE), { acao: 'ajuda' })
  })

  it('normalizar tira acento, caixa e espaço', () => {
    assert.equal(normalizar('  Pendências  DE revisão '), 'pendencias de revisao')
  })

  it('desfazer é reconhecido mesmo com data na frase', () => {
    assert.equal(c('desfazer o de ontem', HOJE).acao, 'desfazer')
  })
})
