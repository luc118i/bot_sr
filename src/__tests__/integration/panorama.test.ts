// Tela inicial: "como está a equipe hoje?" (prévia do dia, nunca grava) e o
// nome de quem usa, vindo do login do ponto. Nomes fictícios.
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { primeiroNome } from '../../core/panorama'
import { extrairNome } from '../../ponto/secullum'
import { buscarNomeDoUsuario, nomeGuardado, panoramaDoDia } from '../../service'
import { getDataDir } from '../../logger'
import { cenario, listaApi, preenchidas } from '../helpers/planilha'

const MANHA = new Date(2026, 8, 28, 9, 0) // segunda 28/09, antes do horário de corte (18:00)
const ponto = { pontoDiario: async () => listaApi() }

describe('panorama do dia', () => {
  it('junta ponto, planilha e exceções; vale antes do corte; não grava nada', async () => {
    const gw = cenario()
    const antes = preenchidas(gw)
    const p = await panoramaDoDia(gw, ponto, MANHA)
    assert.equal(p.naoUtil, undefined)
    if (p.naoUtil !== undefined) return
    const sit = (trecho: string) => p.pessoas.find(x => x.nome.includes(trecho))?.situacao

    assert.equal(sit('JOAO'), 'presente')
    assert.equal(sit('MARCOS'), 'presente')        // atraso também está em atividade
    assert.equal(sit('PAULO'), 'sem_ponto')        // ainda não bateu
    assert.equal(sit('ANDRE'), 'ferias')           // FE já na planilha
    assert.equal(sit('LUIZ'), undefined)           // FO na planilha, mas fora do seu ponto = outro setor
    assert.equal(sit('RENATO'), 'atestado')        // exceção do dia com AT, mesmo fora do ponto
    assert.equal(sit('SERGIO'), undefined)         // outro setor (fora do ponto): não conta
    assert.equal(p.total, p.pessoas.length)
    assert.equal(p.contagem.presente + p.contagem.sem_ponto + p.contagem.folga + p.contagem.ferias + p.contagem.atestado + p.contagem.falta + p.contagem.outros + p.contagem.pendente, p.total)

    assert.deepEqual(gw.escritas, [])
    assert.deepEqual(preenchidas(gw), antes)
  })

  it('domingo e feriado: sem chamada', async () => {
    assert.match((await panoramaDoDia(cenario(), ponto, new Date(2026, 8, 27, 9, 0))).naoUtil ?? '', /domingo/i)
    assert.match((await panoramaDoDia(cenario(), ponto, new Date(2026, 8, 7, 9, 0))).naoUtil ?? '', /oculta/i)
  })
})

describe('nome de quem usa (saudação)', () => {
  beforeEach(() => fs.rmSync(path.join(getDataDir(), 'perfil.json'), { force: true }))

  it('acha o nome nos formatos mais prováveis da resposta do login', () => {
    assert.equal(extrairNome({ nome: 'LUCAS TESTE' }), 'LUCAS TESTE')
    assert.equal(extrairNome({ funcionario: { Nome: 'ANA EXEMPLO' } }), 'ANA EXEMPLO')
    const jwt = ['x', Buffer.from(JSON.stringify({ unique_name: 'BRUNO MODELO' })).toString('base64url'), 'y'].join('.')
    assert.equal(extrairNome({ token: jwt }), 'BRUNO MODELO')
    assert.equal(extrairNome({}), null)
    assert.equal(extrairNome({ nome: '123' }), null)
    assert.equal(extrairNome('texto'), null)
  })

  it('primeiro nome com só a inicial maiúscula', () => {
    assert.equal(primeiroNome('LUCAS LUIZ DA SILVA'), 'Lucas')
    assert.equal(primeiroNome('  élida teste '), 'Élida')
    assert.equal(primeiroNome(''), null)
    assert.equal(primeiroNome(null), null)
  })

  it('guarda por número de login; sem nome, pergunta de novo no dia seguinte', async () => {
    let perguntas = 0
    const cliente = (nome: string | null) => ({ nomeDoUsuario: async () => { perguntas++; return { nome, campos: ['token'] } } })
    assert.equal(nomeGuardado('42'), undefined)
    assert.equal(await buscarNomeDoUsuario(cliente('LUCAS TESTE'), '42'), 'LUCAS TESTE')
    assert.equal(nomeGuardado('42'), 'LUCAS TESTE')
    assert.equal(nomeGuardado('99'), undefined) // outro login

    await buscarNomeDoUsuario(cliente(null), '42')
    assert.equal(nomeGuardado('42'), null) // sem nome: não pergunta de novo hoje…
    const arq = path.join(getDataDir(), 'perfil.json')
    fs.writeFileSync(arq, JSON.stringify({ ...JSON.parse(fs.readFileSync(arq, 'utf-8')), quando: '2026-01-01T00:00:00Z' }))
    assert.equal(nomeGuardado('42'), undefined) // …mas tenta de novo depois de um dia
    assert.equal(perguntas, 2)
  })
})

describe('panorama: folga digitada na planilha', () => {
  it('quem está no seu ponto e tem FO na célula de hoje aparece de folga', async () => {
    const gw = cenario()
    gw.abas['Setembro']![10]![6 + 28 - 1] = 'FO' // PAULO (linha 11), dia 28: sem ponto, mas a planilha diz folga
    const p = await panoramaDoDia(gw, ponto, MANHA)
    if (p.naoUtil !== undefined) throw new Error('dia útil esperado')
    assert.equal(p.pessoas.find(x => x.nome.includes('PAULO'))?.situacao, 'folga')
    assert.equal(p.contagem.folga, 1)
  })
})
