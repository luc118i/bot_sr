// apps-script/Codigo.gs executado de verdade numa sandbox (vm), com
// SpreadsheetApp/PropertiesService/LockService simulados. Testa o lado do
// Google do contrato — e, ligando o AppsScriptGateway nele, o caminho inteiro.
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppsScriptGateway } from '../../sheets/appsScriptGateway'
import { executarEscrita, desfazerEscrita, simular } from '../../service'
import { instalarFetch } from '../helpers/fetchFalso'
import { colDoDia, htmlFixture, NOITE } from '../helpers/planilha'
import { planilhaDoCenario, sandbox, type Planilha } from '../helpers/appsScriptFalso'

describe('Codigo.gs: segurança', () => {
  it('sem TOKEN configurado → recusa tudo', () => {
    const { post } = sandbox(planilhaDoCenario(), {})
    assert.deepEqual(post({ token: '', acao: 'info' }), { ok: false, erro: 'O script não tem a propriedade TOKEN configurada.' })
  })

  it('token errado/ausente → recusa sem tocar na planilha nem pegar o lock', () => {
    const { post, lock } = sandbox(planilhaDoCenario())
    for (const req of [{ token: 'x', acao: 'info' }, { acao: 'info' }, { token: null, acao: 'info' }]) {
      assert.deepEqual(post(req), { ok: false, erro: 'Token inválido.' })
    }
    assert.equal(lock.esperas, 0)
  })

  it('ação desconhecida (inclusive nomes de Object) → recusa', () => {
    const { post } = sandbox(planilhaDoCenario())
    for (const acao of ['apagarTudo', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const r = post({ token: 'tok', acao })
      assert.equal(r.ok, false, acao)
      assert.match(r.erro, /Ação desconhecida/, acao)
    }
  })

  it('corpo que não é JSON → erro em JSON (nunca página de erro do Google)', () => {
    const { post } = sandbox(planilhaDoCenario())
    assert.equal(post('isto não é json').ok, false)
  })

  it('lock é SEMPRE liberado, mesmo quando a gravação falha', () => {
    const { post, lock } = sandbox(planilhaDoCenario())
    assert.equal(post({ token: 'tok', acao: 'escrever', aba: 'Nao existe', valores: [] }).ok, false)
    assert.equal(post({ token: 'tok', acao: 'limpar', aba: 'Setembro', celulas: [] }).ok, true)
    assert.equal(lock.esperas, 2)
    assert.equal(lock.liberacoes, 2)
  })

  it('leituras não entram na fila do lock (a tela de regras lê várias de uma vez)', () => {
    const { post, lock } = sandbox(planilhaDoCenario())
    lock.falhar = true // se alguma leitura pedisse o lock, falharia
    for (const req of [{ acao: 'info' }, { acao: 'lerGrid', aba: 'Setembro' }, { acao: 'colunasOcultas', aba: 'Setembro' }, { acao: 'lerCelulas', aba: 'Setembro', celulas: ['AH8'] }]) {
      assert.equal(post({ token: 'tok', ...req }).ok, true, req.acao)
    }
    assert.equal(lock.esperas, 0)
  })

  it('lock ocupado → erro, nada escrito', () => {
    const pl = planilhaDoCenario()
    const { post, lock } = sandbox(pl)
    lock.falhar = true
    const r = post({ token: 'tok', acao: 'escrever', aba: 'Setembro', valores: [{ celula: 'AH8', valor: '.' }] })
    assert.equal(r.ok, false)
    assert.equal(pl.abas['Setembro']!.grid[7]![33] ?? '', '')
  })

  it('doGet não expõe dados', () => {
    const { ctx } = sandbox(planilhaDoCenario())
    assert.deepEqual(JSON.parse(ctx.doGet().texto), { ok: true, servico: 'frequencia-agent', versao: 1 })
  })
})

describe('Codigo.gs: ações', () => {
  it('info, lerGrid, colunasOcultas, lerCelulas, escrever, limpar', () => {
    const pl = planilhaDoCenario()
    const { post } = sandbox(pl)
    const ok = (req: object) => { const r = post({ token: 'tok', ...req }); assert.equal(r.ok, true, JSON.stringify(r)); return r.dados }

    assert.deepEqual(ok({ acao: 'info' }).abas, ['BASE DE DADOS', 'Setembro', 'Outubro'])
    assert.equal(ok({ acao: 'lerGrid', aba: 'Nao existe' }), null)
    assert.equal(ok({ acao: 'lerGrid', aba: 'Setembro' })[6][2], 'ADM')
    assert.ok(ok({ acao: 'colunasOcultas', aba: 'Setembro' }).includes(colDoDia(7)))
    assert.deepEqual(ok({ acao: 'lerCelulas', aba: 'Setembro', celulas: [] }), [])
    assert.equal(ok({ acao: 'escrever', aba: 'Setembro', valores: [{ celula: 'AH8', valor: '.' }] }), 1)
    assert.deepEqual(ok({ acao: 'lerCelulas', aba: 'Setembro', celulas: ['AH8', 'AH12'] }), ['.', 'FE'])
    assert.equal(ok({ acao: 'limpar', aba: 'Setembro', celulas: ['AH8'] }), 1)
    assert.equal(ok({ acao: 'limpar', aba: 'Setembro', celulas: [] }), 0)
    assert.equal(pl.abas['Setembro']!.grid[7]![33], '')
  })

  it('valores: número vira texto, data vira AAAA-MM-DD e hora vira HH:mm', () => {
    const pl: Planilha = { nome: 'P', abas: { A: { grid: [[2082, new Date(Date.UTC(2026, 8, 28)), new Date(Date.UTC(1899, 11, 30, 8, 5)), null, true]], ocultas: new Set() } } }
    const { post } = sandbox(pl)
    assert.deepEqual(post({ token: 'tok', acao: 'lerGrid', aba: 'A' }).dados, [['2082', '2026-09-28', '08:05', '', 'true']])
  })

  it('aba inexistente nas ações de célula → erro com o nome', () => {
    const { post } = sandbox(planilhaDoCenario())
    assert.match(post({ token: 'tok', acao: 'lerCelulas', aba: 'X', celulas: ['A1'] }).erro, /Aba "X" não existe/)
  })
})

describe('Codigo.gs + AppsScriptGateway: ponta a ponta', () => {
  let restaurar = () => {}
  afterEach(() => restaurar())

  it('simular → escrever → desfazer pelo conector real, contra o script real', async () => {
    const pl = planilhaDoCenario()
    const { post } = sandbox(pl)
    restaurar = instalarFetch(p => new Response(JSON.stringify(post(p.corpo)))).restaurar
    const gw = new AppsScriptGateway('https://script.google.com/macros/s/ID/exec', 'tok')

    const plano = await simular(gw, { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    assert.deepEqual(plano.escritas.map(e => `${e.celula}=${e.codigo}`).sort(), ['AH10=P', 'AH13=.', 'AH16=AT', 'AH8=.', 'AH9=.'])
    const r = await executarEscrita(gw, plano)
    assert.equal(r.escritas.length, 5)
    assert.equal(pl.abas['Setembro']!.grid[9]![33], 'P')
    const d = await desfazerEscrita(gw, plano.aba, r.escritas)
    assert.equal(d.apagadas.length, 5)
    assert.equal(pl.abas['Setembro']!.grid[9]![33], '')
  })

  it('token errado no bot → erro claro, planilha intacta', async () => {
    const pl = planilhaDoCenario()
    const { post } = sandbox(pl)
    restaurar = instalarFetch(p => new Response(JSON.stringify(post(p.corpo)))).restaurar
    await assert.rejects(new AppsScriptGateway('https://script.google.com/macros/s/ID/exec', 'errado').escrever('Setembro', [{ celula: 'AH8', valor: '.' }]), /Token inválido/)
    assert.equal(pl.abas['Setembro']!.grid[7]![33] ?? '', '')
  })
})
