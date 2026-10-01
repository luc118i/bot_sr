// Conector da planilha via Apps Script, com fetch simulado.
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AppsScriptGateway, explicarPaginaDoGoogle } from '../../sheets/appsScriptGateway'
import { instalarFetch, json, type PedidoFetch } from '../helpers/fetchFalso'

const URL_OK = 'https://script.google.com/macros/s/ABC123/exec'
let restaurar = () => {}
afterEach(() => restaurar())

function fetchCom(resp: (p: PedidoFetch, n: number) => Response) {
  const f = instalarFetch(resp)
  restaurar = f.restaurar
  return f.pedidos
}

describe('AppsScriptGateway: construção', () => {
  it('só aceita o link /exec da implantação, com token', () => {
    for (const u of ['https://script.google.com/macros/s/ABC/dev', 'http://script.google.com/macros/s/ABC/exec',
      'https://evil.com/macros/s/ABC/exec', 'https://script.google.com/macros/s/ABC/exec?x=1', '']) {
      assert.throws(() => new AppsScriptGateway(u, 't'), /termina(ndo)? em \/exec/, u)
    }
    assert.throws(() => new AppsScriptGateway(URL_OK, ''), /Token/)
    assert.doesNotThrow(() => new AppsScriptGateway(`  ${URL_OK}  `, 't'))
  })
})

describe('AppsScriptGateway: protocolo', () => {
  it('manda token+ação, entende {ok,dados} e guarda o info em cache', async () => {
    const pedidos = fetchCom(() => json({ ok: true, dados: { titulo: '[SR] - Frequência logística 2026', abas: ['Setembro'] } }))
    const gw = new AppsScriptGateway(URL_OK, 'segredo')
    assert.deepEqual(await gw.listarAbas(), ['Setembro'])
    assert.equal(await gw.titulo(), '[SR] - Frequência logística 2026')
    assert.equal(pedidos.length, 1)
    assert.deepEqual(pedidos[0]!.corpo, { token: 'segredo', acao: 'info' })
    assert.equal(pedidos[0]!.metodo, 'POST')
    assert.match(pedidos[0]!.headers['content-type']!, /^text\/plain/) // sem preflight
  })

  it('cada operação manda os parâmetros certos', async () => {
    const pedidos = fetchCom(p => json({ ok: true, dados: p.corpo.acao === 'colunasOcultas' ? [3, 7] : p.corpo.acao === 'lerCelulas' ? ['.', ''] : null }))
    const gw = new AppsScriptGateway(URL_OK, 't')
    assert.deepEqual([...await gw.colunasOcultas('Setembro')], [3, 7])
    assert.deepEqual(await gw.lerCelulas('Setembro', ['AH8', 'AH9']), ['.', ''])
    await gw.escrever('Setembro', [{ celula: 'AH8', valor: '.' }])
    await gw.limpar('Setembro', ['AH8'])
    assert.equal(await gw.lerGrid('Nao existe'), null)
    assert.deepEqual(pedidos.map(p => p.corpo), [
      { token: 't', acao: 'colunasOcultas', aba: 'Setembro' },
      { token: 't', acao: 'lerCelulas', aba: 'Setembro', celulas: ['AH8', 'AH9'] },
      { token: 't', acao: 'escrever', aba: 'Setembro', valores: [{ celula: 'AH8', valor: '.' }] },
      { token: 't', acao: 'limpar', aba: 'Setembro', celulas: ['AH8'] },
      { token: 't', acao: 'lerGrid', aba: 'Nao existe' },
    ])
  })

  it('listas vazias não vão pra rede (escrever/limpar/lerCelulas)', async () => {
    const pedidos = fetchCom(() => json({ ok: true }))
    const gw = new AppsScriptGateway(URL_OK, 't')
    await gw.escrever('S', [])
    await gw.limpar('S', [])
    assert.deepEqual(await gw.lerCelulas('S', []), [])
    assert.equal(pedidos.length, 0)
  })

  it('{ok:false} vira erro com a mensagem do script', async () => {
    fetchCom(() => json({ ok: false, erro: 'Token inválido.' }))
    await assert.rejects(new AppsScriptGateway(URL_OK, 't').lerGrid('Setembro'), /Apps Script: Token inválido/)
    restaurar()
    fetchCom(() => json({ ok: false }))
    await assert.rejects(new AppsScriptGateway(URL_OK, 't').lerGrid('Setembro'), /erro desconhecido/)
  })

  it('página HTML no lugar do JSON vira instrução', async () => {
    fetchCom(() => new Response('<html>Faça login</html>', { status: 200 }))
    await assert.rejects(new AppsScriptGateway(URL_OK, 't').lerGrid('Setembro'), /Qualquer pessoa/)
  })

  it('erro de rede/timeout → mensagem amigável', async () => {
    restaurar = instalarFetch(() => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }).restaurar
    await assert.rejects(new AppsScriptGateway(URL_OK, 't').titulo(), /Sem resposta do Apps Script \(tempo esgotado\)/)
  })

  it('info com erro NÃO fica em cache — a próxima chamada tenta de novo', async () => {
    let n = 0
    fetchCom(() => (++n === 1 ? json({ ok: false, erro: 'ocupado' }) : json({ ok: true, dados: { titulo: 'T', abas: [] } })))
    const gw = new AppsScriptGateway(URL_OK, 't')
    await assert.rejects(gw.titulo(), /ocupado/)
    assert.equal(await gw.titulo(), 'T')
  })

  it('o token nunca aparece em mensagens de erro', async () => {
    fetchCom(() => new Response('<html>erro qualquer</html>', { status: 500 }))
    await assert.rejects(new AppsScriptGateway(URL_OK, 'TOKEN-SUPER-SECRETO').titulo(), (e: Error) => !e.message.includes('TOKEN-SUPER-SECRETO'))
  })
})

describe('explicarPaginaDoGoogle', () => {
  it('função não encontrada → publicar nova versão', () => {
    const pagina = '<html><head><title>Erro</title><script>var x="TypeError(...)"</script></head><body><div>Erro</div><div>Função de script não encontrada: doPost</div></body></html>'
    assert.match(explicarPaginaDoGoogle(pagina, 200), /Função de script não encontrada: doPost.*Nova versão/)
    assert.match(explicarPaginaDoGoogle('<div>Script function not found: doPost</div>', 200), /Nova versão/)
  })

  it('login do Google (pela URL final ou pelo texto) → acesso "Qualquer pessoa"', () => {
    assert.match(explicarPaginaDoGoogle('<html>x</html>', 200, 'https://accounts.google.com/x'), /Qualquer pessoa/)
    assert.match(explicarPaginaDoGoogle('<html>Sign in</html>', 200), /Qualquer pessoa/)
  })

  it('autorização pendente → rodar no editor e aceitar', () => {
    assert.match(explicarPaginaDoGoogle('<p>Authorization is required to perform that action.</p>', 200), /aceite as permissões/)
  })

  it('qualquer outra coisa → mostra o texto (sem tags, sem script/style, curto)', () => {
    const m = explicarPaginaDoGoogle(`<style>.a{}</style><script>alert(1)</script><p>Algo&nbsp;deu &quot;errado&quot;</p>${'x'.repeat(500)}`, 502)
    assert.match(m, /HTTP 502.*Algo deu "errado"/)
    assert.doesNotMatch(m, /alert|<p>|\.a\{\}/)
    assert.ok(m.length < 500)
  })

  it('corpo vazio → "vazia"', () => {
    assert.match(explicarPaginaDoGoogle('', 500), /"vazia"/)
  })
})
