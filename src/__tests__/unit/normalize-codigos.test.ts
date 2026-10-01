import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, normalizeAdm } from '../../core/normalize'
import { CODIGOS, parseCodigo } from '../../core/codigos'

describe('normalize', () => {
  it('tira acento, caixa e espaços', () => {
    assert.equal(normalize('  Ândréa  Fictícia '), 'ANDREA FICTICIA')
    assert.equal(normalize('PEDRO TESTE DE ARAUJO '), 'PEDRO TESTE DE ARAUJO')
    assert.equal(normalize('joão\tda\nsilva'), 'JOAO DA SILVA')
    assert.equal(normalize('Ç ç ñ ü'), 'C C N U')
  })

  it('NFC e NFD do mesmo nome ficam iguais (texto colado de fontes diferentes)', () => {
    const nfc = 'JOSÉ'.normalize('NFC')
    const nfd = 'JOSÉ'.normalize('NFD')
    assert.notEqual(nfc, nfd)
    assert.equal(normalize(nfc), normalize(nfd))
  })

  it('espaço não separável (copiado do navegador) conta como espaço', () => {
    assert.equal(normalize('JOAO SILVA'), 'JOAO SILVA')
  })

  it('null/undefined viram vazio', () => {
    assert.equal(normalize(null), '')
    assert.equal(normalize(undefined), '')
  })
})

describe('normalizeAdm', () => {
  it('forma canônica de número inteiro', () => {
    assert.equal(normalizeAdm('2082'), '2082')
    assert.equal(normalizeAdm(2082), '2082')
    assert.equal(normalizeAdm(' 2082.0 '), '2082')
    assert.equal(normalizeAdm('2082,0'), '2082')
    assert.equal(normalizeAdm('007'), '7')
  })

  it('não-inteiro e texto ficam como estão', () => {
    assert.equal(normalizeAdm('A-12'), 'A-12')
    assert.equal(normalizeAdm('12.5'), '12.5')
  })

  it('vazio fica vazio', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(normalizeAdm(v), '')
  })
})

describe('codigos', () => {
  it('parseCodigo aceita todos da legenda, sem diferenciar caixa', () => {
    for (const c of Object.keys(CODIGOS)) {
      assert.equal(parseCodigo(c), c)
      assert.equal(parseCodigo(` ${c.toLowerCase()} `), c)
    }
  })

  it('recusa o que não está na legenda (inclusive nomes herdados de Object)', () => {
    for (const s of ['XX', 'FALTA', '..', 'toString', 'constructor', '__proto__', '', null, undefined]) {
      assert.equal(parseCodigo(s as string), null, String(s))
    }
  })
})
