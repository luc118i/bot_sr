import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectarLayout, LayoutInvalidoError, nomeAbaDoMes } from '../../core/layoutMes'
import { colunaA1 } from '../../core/tempo'
import { colDoDia, gridMes } from '../helpers/planilha'

describe('detectarLayout: cabeçalho', () => {
  it('acha colunas pelo cabeçalho e avisa sobre o dia 31 de setembro preenchido', () => {
    const g = gridMes(2026, 9, [['2082', 'ALAN', { 28: '.', 31: 'FE' }]])
    const l = detectarLayout('Setembro', g, 2026, 9)
    assert.equal(l.linhaCabecalho, 7)
    assert.equal(l.colAdm, 3)
    assert.equal(l.colNome, 4)
    assert.equal(l.colunaDoDia.get(1), 7)
    assert.equal(colunaA1(l.colunaDoDia.get(28)!), 'AH')
    assert.equal(l.colunaDoDia.has(31), false)
    assert.match(l.avisos.join('\n'), /AK.*dia 31.*1 célula/)
  })

  it('coluna 31 vazia num mês de 30 só avisa que foi ignorada', () => {
    const l = detectarLayout('Setembro', gridMes(2026, 9, [['1', 'X']]), 2026, 9)
    assert.match(l.avisos.join('\n'), /dia 31.*ignorada\.$/m)
  })

  it('recusa cabeçalho com dia repetido (Julho) e com dia faltando (Maio)', () => {
    const julho = [1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 13, 14, 14, 15, 16, 17, 18, 20, 21, 21, 22, 23, 24, 25, 27, 28, 28, 29, 30, 31]
    assert.throws(() => detectarLayout('Julho', gridMes(2026, 7, [['1', 'X']], julho), 2026, 7), LayoutInvalidoError)
    const maio = [1, 2, ...Array.from({ length: 28 }, (_, i) => i + 4)]
    assert.throws(() => detectarLayout('Maio', gridMes(2026, 5, [['1', 'X']], maio), 2026, 5), /fora de sequência/)
  })

  it('a mensagem de sequência quebrada mostra no máximo 5 problemas', () => {
    const embaralhado = Array.from({ length: 31 }, (_, i) => (i === 0 ? 1 : 31 - i))
    assert.throws(() => detectarLayout('X', gridMes(2026, 1, [['1', 'X']], embaralhado), 2026, 1), /e mais \d+/)
  })

  it('recusa mês com colunas de dia a menos', () => {
    const g = gridMes(2026, 10, [['1', 'X']], Array.from({ length: 30 }, (_, i) => i + 1))
    assert.throws(() => detectarLayout('Outubro', g, 2026, 10), /Só 30 colunas.*31 dias/)
  })

  it('fevereiro: 28 colunas bastam em 2026, 29 são exigidas em 2028', () => {
    const fev = (n: number) => gridMes(2026, 2, [['1', 'X']], Array.from({ length: n }, (_, i) => i + 1))
    assert.equal(detectarLayout('Fevereiro', fev(28), 2026, 2).colunaDoDia.size, 28)
    assert.throws(() => detectarLayout('Fevereiro', fev(28), 2028, 2), /29 dias/)
  })

  it('sem "ADM"/"COLABORADOR" nas 20 primeiras linhas → erro claro', () => {
    assert.throws(() => detectarLayout('X', [['a', 'b']], 2026, 9), /ADM.*COLABORADOR/)
    const fundo = [...Array.from({ length: 20 }, () => ['']), ['', 'ADM', 'COLABORADOR', '1']]
    assert.throws(() => detectarLayout('X', fundo, 2026, 9), /20 primeiras/)
  })

  it('sem coluna "1" depois do nome → erro claro', () => {
    assert.throws(() => detectarLayout('X', [['ADM', 'COLABORADOR', 'SETOR']], 2026, 9), /Nenhuma coluna de dia "1"/)
  })

  it('"1" ANTES da coluna de nome não conta como dia 1', () => {
    const g = [['1', 'ADM', 'COLABORADOR', ...Array.from({ length: 30 }, (_, i) => String(i + 1))]]
    const l = detectarLayout('X', g, 2026, 9)
    assert.equal(l.colunaDoDia.get(1), 4)
  })

  it('cabeçalho com acento/caixa diferentes ("Colaborador(a)") ainda é achado', () => {
    const g = [['adm', 'Colaborador(a)', ...Array.from({ length: 30 }, (_, i) => String(i + 1))], ['10', 'ANA']]
    const l = detectarLayout('X', g, 2026, 9)
    assert.equal(l.colNome, 2)
    assert.deepEqual(l.linhas, [{ linha: 2, adm: '10', nome: 'ANA' }])
  })
})

describe('detectarLayout: linhas e conferências', () => {
  it('pula linha sem ADM e canoniza o ADM ("2082.0" → "2082")', () => {
    const g = gridMes(2026, 9, [['2082.0', 'A'], ['', 'SEM ADM'], [' 7 ', 'B']])
    assert.deepEqual(detectarLayout('S', g, 2026, 9).linhas, [{ linha: 8, adm: '2082', nome: 'A' }, { linha: 10, adm: '7', nome: 'B' }])
  })

  it('ADM repetido vira aviso', () => {
    const l = detectarLayout('S', gridMes(2026, 9, [['5', 'A'], ['5', 'B']]), 2026, 9)
    assert.match(l.avisos.join('\n'), /ADM 5 aparece em mais de uma linha \(8, 9\)/)
  })

  it('letra do dia da semana errada vira aviso (sem bloquear)', () => {
    const g = gridMes(2026, 9, [['1', 'X']])
    g[5]![colDoDia(1) - 1] = 'D' // 01/09/2026 é terça
    const l = detectarLayout('S', g, 2026, 9)
    assert.match(l.avisos.join('\n'), /dia 1: "D" \(esperado "T"\)/)
  })

  it('coluna oculta vira dia não útil; domingo é não útil mesmo visível', () => {
    const l = detectarLayout('Setembro', gridMes(2026, 9, [['1', 'X']]), 2026, 9, new Set([colDoDia(7)]))
    assert.equal(l.diasNaoUteis.get(7), 'coluna oculta')
    assert.equal(l.diasNaoUteis.get(27), 'domingo')
    assert.equal(l.diasNaoUteis.has(28), false)
  })

  it('domingo oculto continua "domingo" (motivo mais específico)', () => {
    const l = detectarLayout('Setembro', gridMes(2026, 9, [['1', 'X']]), 2026, 9, new Set([colDoDia(27)]))
    assert.equal(l.diasNaoUteis.get(27), 'domingo')
  })

  it('coluna oculta FORA dos dias (ex.: total) não marca dia nenhum', () => {
    const l = detectarLayout('Setembro', gridMes(2026, 9, [['1', 'X']]), 2026, 9, new Set([1, 2, 60]))
    assert.ok([...l.diasNaoUteis.values()].every(v => v === 'domingo'))
  })
})

describe('nomeAbaDoMes', () => {
  it('acha a aba com acento/caixa/espaço diferentes', () => {
    assert.equal(nomeAbaDoMes(['BASE DE DADOS', 'Março', 'Abril'], 3), 'Março')
    assert.equal(nomeAbaDoMes(['  marco '], 3), '  marco ')
  })

  it('aba ausente ou duplicada → erro (nunca escolhe)', () => {
    assert.throws(() => nomeAbaDoMes(['Abril'], 3), /não encontrada/)
    assert.throws(() => nomeAbaDoMes(['Março', 'MARCO'], 3), /Mais de uma aba/)
  })

  it('"Setembro (cópia)" não é Setembro', () => {
    assert.throws(() => nomeAbaDoMes(['Setembro (cópia)'], 9), /não encontrada/)
  })
})
