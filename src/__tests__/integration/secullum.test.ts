// Cliente da API do ponto (Secullum) com fetch simulado — nada sai pra rede.
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PontoAuthError, SecullumClient, type CredenciaisPonto } from '../../ponto/secullum'
import { instalarFetch, json } from '../helpers/fetchFalso'
import { listaApi } from '../helpers/planilha'

const CRED: CredenciaisPonto = { banco: ' 12345 ', tipo: 'folha', numero: ' 42 ', senha: 'p:ss word' }
let restaurar = () => {}
afterEach(() => restaurar())

function fetchCom(resp: (url: string, n: number) => Response) {
  const f = instalarFetch((p, n) => resp(p.url, n))
  restaurar = f.restaurar
  return f.pedidos
}

describe('SecullumClient: validação', () => {
  it('banco precisa ser número; número e senha obrigatórios', () => {
    assert.throws(() => new SecullumClient({ ...CRED, banco: 'abc' }), /Banco do ponto inválido/)
    assert.throws(() => new SecullumClient({ ...CRED, banco: '' }), /Banco do ponto inválido/)
    assert.throws(() => new SecullumClient({ ...CRED, numero: '  ' }), /não configurados/)
    assert.throws(() => new SecullumClient({ ...CRED, senha: '' }), /não configurados/)
  })
})

describe('SecullumClient.pontoDiario', () => {
  it('GET /<banco>/Batidas/<data> com Basic numero:senha:tipo e o header de versão', async () => {
    const pedidos = fetchCom(() => json({ lista: listaApi() }))
    const lista = await new SecullumClient(CRED).pontoDiario('2026-09-28')
    assert.equal(lista.length, 6)
    assert.equal(pedidos[0]!.url, 'https://pontowebapp.secullum.com.br/12345/Batidas/2026-09-28')
    const basic = Buffer.from(pedidos[0]!.headers['authorization']!.replace(/^Basic /, ''), 'base64').toString()
    assert.equal(basic, '42:p:ss word:0') // número com trim; senha EXATA (pode ter ":" e espaço)
    assert.equal(pedidos[0]!.headers['x-sec-centralfuncionarioversao'], '1.45.0')
  })

  it('tipo "identificador" manda 1 no Basic', async () => {
    const pedidos = fetchCom(() => json({ lista: [] }))
    await new SecullumClient({ ...CRED, tipo: 'identificador' }).pontoDiario('2026-09-28')
    assert.match(Buffer.from(pedidos[0]!.headers['authorization']!.slice(6), 'base64').toString(), /:1$/)
  })

  it('senha com acento vai em UTF-8', async () => {
    const pedidos = fetchCom(() => json({ lista: [] }))
    await new SecullumClient({ ...CRED, senha: 'ção' }).pontoDiario('2026-09-28')
    assert.equal(Buffer.from(pedidos[0]!.headers['authorization']!.slice(6), 'base64').toString('utf-8'), '42:ção:0')
  })

  it('401 → faz login e tenta de novo uma vez', async () => {
    const pedidos = fetchCom((url, n) => (n === 1 ? new Response('', { status: 401 }) : url.endsWith('/Login') ? new Response('{}') : json({ lista: [] })))
    assert.deepEqual(await new SecullumClient(CRED).pontoDiario('2026-09-28'), [])
    assert.deepEqual(pedidos.map(p => `${p.metodo} ${p.url.replace(/^.*12345/, '')}`), ['GET /Batidas/2026-09-28', 'POST /Login', 'GET /Batidas/2026-09-28'])
    assert.deepEqual({ ...pedidos[1]!.corpo, identificacaoDispositivo: 'x' },
      { usuario: '42', senha: 'p:ss word', plataformaLogin: 1, UsuarioAutenticacao: 0, identificacaoDispositivo: 'x' })
  })

  it('login recusado → PontoAuthError (para tudo)', async () => {
    fetchCom((url) => (url.endsWith('/Login') ? new Response('', { status: 400 }) : new Response('', { status: 401 })))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), PontoAuthError)
  })

  it('401 de novo depois do login → PontoAuthError (sem laço infinito)', async () => {
    const pedidos = fetchCom((url) => (url.endsWith('/Login') ? new Response('{}') : new Response('', { status: 401 })))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), PontoAuthError)
    assert.equal(pedidos.length, 3)
  })

  it('login com erro 500 → erro comum (não é senha errada)', async () => {
    fetchCom((url) => (url.endsWith('/Login') ? new Response('', { status: 500 }) : new Response('', { status: 401 })))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), (e: Error) => !(e instanceof PontoAuthError) && /HTTP 500/.test(e.message))
  })

  it('HTTP 500 na consulta → erro com o dia e o status', async () => {
    fetchCom(() => new Response('', { status: 503, statusText: 'Service Unavailable' }))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), /2026-09-28: HTTP 503/)
  })

  it('resposta sem "lista" ou corpo vazio → erro dizendo que a API pode ter mudado', async () => {
    fetchCom(() => json({ itens: [] }))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), /sem "lista"/)
    restaurar()
    fetchCom(() => new Response(''))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), /sem "lista"/)
  })

  it('corpo que não é JSON (página de manutenção) → erro legível, não "Unexpected token"', async () => {
    fetchCom(() => new Response('<html>manutenção</html>'))
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), (e: Error) =>
      /2026-09-28/.test(e.message) && /não é JSON|resposta inválida/i.test(e.message) && !/Unexpected token/.test(e.message))
  })

  it('sem rede / timeout → mensagem amigável', async () => {
    restaurar = instalarFetch(() => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }) }).restaurar
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), /Sem resposta do servidor do ponto \(fetch failed\)/)
    restaurar()
    restaurar = instalarFetch(() => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }).restaurar
    await assert.rejects(new SecullumClient(CRED).pontoDiario('2026-09-28'), /tempo esgotado/)
  })
})

describe('SecullumClient.testar', () => {
  it('banco válido + leitura ok → mensagem com a contagem', async () => {
    fetchCom((url) => (url.includes('VerificarBancoValido') ? new Response('true') : json({ lista: listaApi() })))
    assert.match(await new SecullumClient(CRED).testar('2026-09-28'), /Login ok — 6 colaborador/)
  })

  it('banco inexistente → erro dizendo o banco', async () => {
    fetchCom(() => new Response('false'))
    await assert.rejects(new SecullumClient(CRED).testar('2026-09-28'), /Banco  ?12345 ?.*não encontrado/)
  })

  it('verificação com corpo vazio = banco inválido', async () => {
    fetchCom(() => new Response(''))
    await assert.rejects(new SecullumClient(CRED).testar('2026-09-28'), /não encontrado/)
  })
})
