import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pontoDizFeriado, registrosDaApi } from '../../core/pontoApi'
import { parsePontoHtml } from '../../core/pontoParser'
import { normalize } from '../../core/normalize'
import { htmlFixture, listaApi } from '../helpers/planilha'

describe('registrosDaApi', () => {
  it('vira os mesmos registros do leitor de HTML', () => {
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

  it('API e HTML concordam em status e entrada de quem aparece nos dois', () => {
    const html = Object.fromEntries(parsePontoHtml(htmlFixture()).registros.map(r => [normalize(r.nome), r]))
    for (const r of registrosDaApi(listaApi()).registros) {
      const h = html[normalize(r.nome)]
      if (!h) continue
      assert.equal(r.status, h.status, r.nome)
      assert.equal(r.entrada1, h.entrada1, r.nome)
    }
  })

  it('campos ausentes/nulos não derrubam a conversão', () => {
    const { registros, avisos } = registrosDaApi([
      { funcionarioNome: 'SEM BATIDAS', data: '' },
      { funcionarioNome: 'BATIDA NULA', data: '', batidas: [{ valor: null }, {} as any, null as any] },
      { funcionarioNome: '  ', data: '' },
      { funcionarioNome: null as any, data: '' },
    ])
    assert.deepEqual(registros.map(r => r.status), ['sem_registro', 'sem_registro'])
    assert.equal(avisos.filter(a => /sem nome/.test(a)).length, 2)
  })

  it('ícone: registro pendente vira "outro"; situação desconhecida também', () => {
    const base = { data: '', batidas: [{ valor: '08:00' }] }
    const { registros } = registrosDaApi([
      { ...base, funcionarioNome: 'A', situacao: 0 },
      { ...base, funcionarioNome: 'B', situacao: 2, registroPendente: true },
      { ...base, funcionarioNome: 'C', situacao: 7 },
      { ...base, funcionarioNome: 'D' },
    ])
    assert.deepEqual(registros.map(r => r.icone), ['verde', 'outro', 'outro', 'outro'])
  })

  it('justificativa que não é férias (atestado...) vai pra revisão', () => {
    const { registros } = registrosDaApi([{ funcionarioNome: 'A', data: '', batidas: [{ valor: 'ATESTADO' }] }])
    assert.equal(registros[0]!.status, 'desconhecido')
  })

  it('nome repetido vira aviso', () => {
    const { avisos } = registrosDaApi([{ funcionarioNome: 'Zé', data: '' }, { funcionarioNome: 'ZE ', data: '' }])
    assert.match(avisos.join(), /"ZE" aparece 2 vezes/)
  })
})

describe('pontoDizFeriado', () => {
  it('só quando TODA a lista diz feriado (e ela não é vazia)', () => {
    assert.equal(pontoDizFeriado(listaApi(true)), true)
    assert.equal(pontoDizFeriado(listaApi(false)), false)
    assert.equal(pontoDizFeriado([]), false)
    const misto = listaApi(true)
    misto[0] = { ...misto[0]!, feriado: false }
    assert.equal(pontoDizFeriado(misto), false)
  })
})
