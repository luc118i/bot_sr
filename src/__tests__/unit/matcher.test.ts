import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Matcher } from '../../core/matcher'
import type { LinhaColaborador } from '../../core/layoutMes'

const L = (linha: number, adm: string, nome: string): LinhaColaborador => ({ linha, adm, nome })

describe('Matcher', () => {
  const linhas = [
    L(8, '374', 'JOÃO EXEMPLO DA SILVA'),
    L(9, '2376', 'PEDRO TESTE DE ARAUJO'),
    L(10, '1417', 'RAIMUNDO DAS NEVES PRADO DOS'),
    L(11, '50', 'MARIA HOMONIMA'),
    L(12, '51', 'MARIA HOMONIMA'),
    L(13, '60', 'ADM REPETIDO UM'),
    L(14, '60', 'ADM REPETIDO DOIS'),
  ]

  it('casa pelo nome normalizado (acento, caixa, espaço sobrando)', () => {
    const m = new Matcher(linhas, []).resolver('joao exemplo da silva ')
    assert.equal(m.tipo, 'ok')
    assert.equal(m.tipo === 'ok' && m.linha.linha, 8)
    assert.equal(m.tipo === 'ok' && m.via, 'nome')
  })

  it('apelido tem prioridade sobre o nome', () => {
    const m = new Matcher(linhas, [{ nomePonto: 'PEDRO TESTE DE ARAUJO', adm: '374' }]).resolver('Pedro Teste de Araujo')
    assert.equal(m.tipo === 'ok' && m.linha.adm, '374')
    assert.equal(m.tipo === 'ok' && m.via, 'apelido')
  })

  it('apelido pra ADM sem linha no mês → sem_linha_no_mes (via apelido)', () => {
    assert.deepEqual(new Matcher(linhas, [{ nomePonto: 'FULANO', adm: '9' }]).resolver('fulano'), { tipo: 'sem_linha_no_mes', adm: '9', via: 'apelido' })
  })

  it('apelido pra ADM repetido na aba → ambíguo', () => {
    const m = new Matcher(linhas, [{ nomePonto: 'X', adm: '60' }]).resolver('x')
    assert.equal(m.tipo, 'ambiguo')
    assert.equal(m.tipo === 'ambiguo' && m.candidatos.length, 2)
  })

  it('homônimos → ambíguo, nunca escolhe um', () => {
    const m = new Matcher(linhas, []).resolver('MARIA HOMONIMA')
    assert.equal(m.tipo, 'ambiguo')
  })

  it('nome único mas com ADM repetido na aba → ambíguo', () => {
    const m = new Matcher(linhas, []).resolver('ADM REPETIDO UM')
    assert.equal(m.tipo, 'ambiguo')
    assert.deepEqual(m.tipo === 'ambiguo' && m.candidatos.map(c => c.linha), [13, 14])
  })

  it('na BASE mas sem linha no mês → sem_linha_no_mes (via base)', () => {
    assert.deepEqual(new Matcher(linhas, [], [{ adm: '9999', nome: 'Felipe Semlinha' }]).resolver('FELIPE SEMLINHA'),
      { tipo: 'sem_linha_no_mes', adm: '9999', via: 'base' })
  })

  it('homônimo na BASE não decide nada → não encontrado', () => {
    const base = [{ adm: '1', nome: 'ZE' }, { adm: '2', nome: 'ZE' }]
    assert.equal(new Matcher(linhas, [], base).resolver('ZE').tipo, 'nao_encontrado')
  })

  it('nome truncado vira SUGESTÃO, nunca match', () => {
    const m = new Matcher(linhas, []).resolver('RAIMUNDO DAS NEVES PRADO DOS SANTOS')
    assert.equal(m.tipo, 'nao_encontrado')
    assert.equal(m.tipo === 'nao_encontrado' && m.sugestao?.adm, '1417')
  })

  it('prefixo curto demais não sugere (evita "JOAO" → qualquer JOAO)', () => {
    const m = new Matcher([L(8, '1', 'JOAO')], []).resolver('JOAO PEDRO DA SILVA')
    assert.deepEqual(m, { tipo: 'nao_encontrado', sugestao: null })
  })

  it('dois candidatos por prefixo → sem sugestão', () => {
    const ls = [L(8, '1', 'FRANCISCO DE ASSIS PEREIRA'), L(9, '2', 'FRANCISCO DE ASSIS PEREIRA LIMA')]
    const m = new Matcher(ls, []).resolver('FRANCISCO DE ASSIS PEREIRA LIMA SOUZA')
    assert.deepEqual(m, { tipo: 'nao_encontrado', sugestao: null })
  })

  it('linha sem nome não casa com nome vazio do ponto nem vira sugestão', () => {
    const m = new Matcher([L(8, '1', '')], []).resolver('ALGUEM COM NOME BEM COMPRIDO')
    assert.deepEqual(m, { tipo: 'nao_encontrado', sugestao: null })
  })
})
