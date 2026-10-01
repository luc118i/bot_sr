// Simular → escrever → justificar → desfazer, contra a planilha em memória.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../../core/normalize'
import {
  desfazerEscrita, executarEscrita, executarEscritaLote, justificar, reverterJustificativas, simular, simularLote,
} from '../../service'
import { cenario, definirRegras, htmlDoDia, htmlFixture, MemoryGateway, NOITE, preenchidas, regrasCenario } from '../helpers/planilha'

const simular28 = (gw: MemoryGateway) => simular(gw, { data: '2026-09-28', html: htmlFixture(), now: NOITE })

describe('simular', () => {
  it('classifica cada caso do plano e nunca decide falta', async () => {
    const plano = await simular28(cenario())
    const por = (nome: string) => plano.itens.find(i => normalize(i.nomePonto ?? i.nomePlanilha) === nome)!

    assert.deepEqual(plano.escritas.map(e => `${e.celula}=${e.codigo}`).sort(), ['AH16=AT', 'AH8=.', 'AH9=.', 'AH10=P', 'AH13=.'].sort())
    assert.equal(por('PAULO MODELO DA SILVA').situacao, 'revisar')
    assert.equal(por('ANDRE JOSE DE EXEMPLO').situacao, 'confere')
    // Nome cortado na planilha: 3 de 4 palavras (75%) → casa sozinho, e o motivo diz que foi por semelhança.
    assert.equal(por('RAIMUNDO DAS NEVES PRADO DOS SANTOS').situacao, 'escrever')
    assert.match(por('RAIMUNDO DAS NEVES PRADO DOS SANTOS').motivo, /^\[nome parecido 75%: ponto "RAIMUNDO DAS NEVES PRADO DOS SANTOS" × planilha "RAIMUNDO DAS NEVES PRADO DOS"\]/)
    assert.equal(por('FELIPE SEMLINHA DE FARIA').situacao, 'sem_linha_no_mes')
    assert.equal(por('LUIZ EXCECAO OLIVEIRA').situacao, 'divergente')
    assert.equal(por('SERGIO ATESTADO QUEIROZ').situacao, 'ausente_no_ponto')
    assert.equal(por('NELSON AUSENTE CAMPOS').situacao, 'ausente_no_ponto')
    assert.ok(!plano.escritas.some(e => e.codigo === 'F'))
  })

  it('simular NÃO escreve nem limpa nada na planilha', async () => {
    const gw = cenario()
    const antes = preenchidas(gw)
    await simular28(gw)
    assert.deepEqual(gw.escritas, [])
    assert.deepEqual(gw.limpezas, [])
    assert.deepEqual(preenchidas(gw), antes)
  })

  it('apelido resolve nome truncado', async () => {
    const gw = cenario()
    definirRegras({ ...regrasCenario(), apelidos: [{ nome_no_ponto: 'Raimundo das Neves Prado dos Santos', adm: '1417', obs: '' }] })
    const plano = await simular28(gw)
    assert.ok(plano.escritas.some(e => e.celula === 'AH13' && e.codigo === '.'))
  })

  it('recusa HTML do ponto de um dia diferente do escolhido', async () => {
    await assert.rejects(simular(cenario(), { data: '2026-09-25', html: htmlFixture(), now: NOITE }), /é do dia 2026-09-28/)
  })

  it('recusa planilha de outro ano', async () => {
    await assert.rejects(simular(cenario(), { data: '2027-01-05', html: '', now: new Date(2027, 0, 6) }), /é de 2026/)
  })

  it('planilha sem ano no título é aceita', async () => {
    const gw = cenario()
    const semAno = new MemoryGateway(gw.abas, 'Frequência logística')
    semAno.ocultas = gw.ocultas
    assert.ok((await simular(semAno, { data: '2026-09-28', html: htmlFixture(), now: NOITE })).escritas.length > 0)
  })

  it('feriado com coluna oculta e domingo não são preenchidos nem com "forçar"', async () => {
    const gw = cenario()
    await assert.rejects(simular(gw, { data: '2026-09-07', html: htmlDoDia('2026-09-07'), now: NOITE, forcar: true }), /coluna oculta.*feriado/)
    await assert.rejects(simular(gw, { data: '2026-09-27', html: htmlDoDia('2026-09-27'), now: NOITE, forcar: true }), /domingo/)
  })

  it('aba do mês faltando vira erro do dia, sem derrubar o lote', async () => {
    const gw = cenario()
    delete gw.abas['Outubro']
    const lote = await simularLote(gw, { htmls: ['2026-09-30', '2026-10-01'].map(d => ({ arquivo: d, html: htmlDoDia(d) })), now: new Date(2026, 9, 1, 19) })
    assert.deepEqual(lote.planos.map(p => p.data), ['2026-09-30'])
    assert.match(lote.erros[0]!.motivo, /Outubro.*não encontrada/)
  })

  it('cada mês é lido uma vez só, mesmo com vários dias', async () => {
    const gw = cenario()
    await simularLote(gw, { htmls: ['2026-09-28', '2026-09-29', '2026-09-30'].map(d => ({ arquivo: d, html: htmlDoDia(d) })), now: new Date(2026, 9, 1, 19) })
    // BASE DE DADOS + Setembro.
    assert.equal(gw.leituras, 2)
  })
})

describe('executarEscrita', () => {
  it('relê as células e pula quem foi preenchido depois da simulação; é idempotente', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    gw.abas['Setembro']![8 - 1]![34 - 1] = 'FO' // alguém lançou AH8 à mão nesse meio tempo
    const r = await executarEscrita(gw, plano)
    assert.deepEqual(r.puladas, [{ celula: 'AH8', valorEncontrado: 'FO' }])
    assert.equal(gw.escritas.length, 4)
    assert.equal(gw.abas['Setembro']![7]![33], 'FO')

    const plano2 = await simular28(gw)
    assert.equal(plano2.escritas.length, 0)
  })

  it('aplicar o MESMO plano duas vezes não escreve nada na segunda', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    await executarEscrita(gw, plano)
    const n = gw.escritas.length
    const r2 = await executarEscrita(gw, plano)
    assert.equal(r2.escritas.length, 0)
    assert.equal(r2.puladas.length, plano.escritas.length)
    assert.equal(gw.escritas.length, n)
  })

  it('célula que virou só espaços nesse meio tempo também é pulada', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    gw.abas['Setembro']![7]![33] = ' '
    const r = await executarEscrita(gw, plano)
    assert.ok(r.puladas.some(p => p.celula === 'AH8'))
  })

  it('SEGURANÇA: se a leitura de conferência vier incompleta, não escreve NADA', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    gw.abas['Setembro']![10 - 1]![33] = 'AT' // AH10 foi preenchida à mão
    // Conector devolve menos valores do que o pedido (resposta truncada/bug).
    gw.lerCelulas = async () => ['']
    await assert.rejects(executarEscrita(gw, plano), /leitura/i)
    assert.deepEqual(gw.escritas, [])
    assert.equal(gw.abas['Setembro']![9]![33], 'AT')
  })

  it('erro na escrita propaga (o lote decide o que fazer)', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    gw.escrever = async () => { throw new Error('quota') }
    await assert.rejects(executarEscrita(gw, plano), /quota/)
  })
})

describe('executarEscritaLote', () => {
  it('escreve todos os dias e o desfazer volta tudo', async () => {
    const gw = cenario()
    const antes = preenchidas(gw)
    const lote = await simularLote(gw, {
      htmls: ['2026-09-29', '2026-09-30', '2026-10-01'].map(d => ({ arquivo: d, html: htmlDoDia(d) })),
      now: new Date(2026, 9, 1, 19, 0),
    })
    const { dias, erro } = await executarEscritaLote(gw, lote.planos)
    assert.equal(erro, null)
    assert.deepEqual(dias.map(d => d.data), ['2026-09-29', '2026-09-30', '2026-10-01'])
    assert.notDeepEqual(preenchidas(gw), antes)

    for (const d of dias) await desfazerEscrita(gw, d.aba, d.escritas)
    assert.deepEqual(preenchidas(gw), antes)
  })

  it('falha no meio devolve os dias já gravados (pro Desfazer)', async () => {
    const gw = cenario()
    const lote = await simularLote(gw, {
      htmls: ['2026-09-29', '2026-10-01'].map(d => ({ arquivo: d, html: htmlDoDia(d) })),
      now: new Date(2026, 9, 1, 19, 0),
    })
    const original = gw.escrever.bind(gw)
    gw.escrever = async (aba, valores) => {
      if (aba === 'Outubro') throw new Error('sem rede')
      return original(aba, valores)
    }
    const { dias, erro } = await executarEscritaLote(gw, lote.planos)
    assert.deepEqual(dias.map(d => d.data), ['2026-09-29'])
    assert.match(erro!, /2026-10-01.*sem rede.*já gravados: 2026-09-29/)
  })

  it('dia sem nada a escrever não chama a planilha', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    plano.escritas = []
    let chamadas = 0
    gw.lerCelulas = async () => { chamadas++; return [] }
    const r = await executarEscritaLote(gw, [plano])
    assert.equal(chamadas, 0)
    assert.deepEqual(r, { dias: [], erro: null })
  })
})

describe('desfazerEscrita', () => {
  it('apaga só o que o bot gravou e mantém o que alguém mudou depois', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const antesAH = gw.abas['Setembro']!.map(r => r[33] ?? '')
    const r = await executarEscrita(gw, plano)
    assert.equal(r.escritas.length, 5)

    gw.abas['Setembro']![10 - 1]![33] = 'AT' // AH10: bot gravou "P", alguém trocou por "AT"
    const d = await desfazerEscrita(gw, plano.aba, r.escritas)

    assert.deepEqual(d.apagadas.sort(), ['AH13', 'AH16', 'AH8', 'AH9'].sort())
    assert.deepEqual(d.mantidas, [{ celula: 'AH10', valorEncontrado: 'AT', escritoPeloBot: 'P' }])
    const depoisAH = gw.abas['Setembro']!.map(r => r[33] ?? '')
    assert.deepEqual(depoisAH.map((v, i) => (i === 9 ? antesAH[i] : v)), antesAH)
    assert.equal(depoisAH[9], 'AT')

    const d2 = await desfazerEscrita(gw, plano.aba, r.escritas)
    assert.deepEqual(d2.apagadas, [])
  })

  it('código igual com espaço/caixa diferente ainda é do bot', async () => {
    const gw = cenario()
    gw.abas['Setembro']![7]![33] = ' p '
    const d = await desfazerEscrita(gw, 'Setembro', [{ celula: 'AH8', codigo: 'P' }])
    assert.deepEqual(d.apagadas, ['AH8'])
  })

  it('SEGURANÇA: leitura incompleta não apaga NADA', async () => {
    const gw = cenario()
    gw.abas['Setembro']![7]![33] = '.'
    gw.abas['Setembro']![8]![33] = 'FO'
    gw.lerCelulas = async () => ['.']
    await assert.rejects(desfazerEscrita(gw, 'Setembro', [{ celula: 'AH8', codigo: '.' }, { celula: 'AH9', codigo: '.' }]), /leitura/i)
    assert.deepEqual(gw.limpezas, [])
  })

  it('lista vazia não chama limpar com nada perigoso', async () => {
    const gw = cenario()
    const d = await desfazerEscrita(gw, 'Setembro', [])
    assert.deepEqual(d, { apagadas: [], mantidas: [] })
  })
})

describe('justificar', () => {
  it('grava o código escolhido só em pendência vazia e pode ser desfeito', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const rev = plano.itens.find(i => i.situacao === 'revisar' && i.celula)!
    assert.ok(rev, 'o cenário precisa de alguém sem ponto')
    const outra = plano.itens.find(i => i.situacao === 'escrever')!

    await assert.rejects(justificar(gw, plano, [{ celula: outra.celula!, codigo: 'AT' }]), /pendências/)
    await assert.rejects(justificar(gw, plano, [{ celula: rev.celula!, codigo: 'XX' }]), /legenda/)
    assert.deepEqual(gw.escritas, [])

    const antiga = structuredClone(plano)
    const r = await justificar(gw, plano, [{ celula: rev.celula!, codigo: 'at' }])
    assert.deepEqual(r.escritas, [{ celula: rev.celula, codigo: 'AT' }])
    assert.deepEqual(await gw.lerCelulas(plano.aba, [rev.celula!]), ['AT'])

    // Outra tela com a conferência antiga: pula, não sobrescreve.
    const r2 = await justificar(gw, antiga, [{ celula: rev.celula!, codigo: 'F' }])
    assert.deepEqual(r2.puladas, [{ celula: rev.celula, valorEncontrado: 'AT' }])

    assert.equal(rev.situacao, 'justificado')
    assert.equal(plano.resumo.justificado, 1)

    const d = await desfazerEscrita(gw, plano.aba, r.escritas)
    assert.deepEqual(d.apagadas, [rev.celula])
    assert.ok(reverterJustificativas(plano, d.apagadas))
    assert.equal(rev.situacao, 'revisar')
    assert.equal(plano.resumo.justificado, 0)
  })

  it('um pedido inválido no meio recusa o lote inteiro (nada gravado)', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const rev = plano.itens.find(i => i.situacao === 'revisar' && i.celula)!
    await assert.rejects(justificar(gw, plano, [{ celula: rev.celula!, codigo: 'AT' }, { celula: 'ZZ999', codigo: 'AT' }]), /ZZ999/)
    assert.deepEqual(gw.escritas, [])
  })

  it('a mesma célula duas vezes no pedido é recusada (estado do plano ficaria corrompido)', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const rev = plano.itens.find(i => i.situacao === 'revisar' && i.celula)!
    await assert.rejects(justificar(gw, plano, [{ celula: rev.celula!, codigo: 'AT' }, { celula: rev.celula!, codigo: 'F' }]), /repetida/)
    assert.deepEqual(gw.escritas, [])
  })

  it('justificar de novo uma célula já justificada é recusado', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const rev = plano.itens.find(i => i.situacao === 'revisar' && i.celula)!
    await justificar(gw, plano, [{ celula: rev.celula!, codigo: 'AT' }])
    await assert.rejects(justificar(gw, plano, [{ celula: rev.celula!, codigo: 'F' }]), /pendências/)
  })

  it('pendência sem célula (nome não achado) não pode ser justificada', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    await assert.rejects(justificar(gw, plano, [{ celula: null as any, codigo: 'AT' }]), /pendências/)
  })

  it('SEGURANÇA: leitura incompleta não grava justificativa', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const rev = plano.itens.find(i => i.situacao === 'revisar' && i.celula)!
    gw.lerCelulas = async () => []
    await assert.rejects(justificar(gw, plano, [{ celula: rev.celula!, codigo: 'AT' }]), /leitura/i)
    assert.deepEqual(gw.escritas, [])
    assert.equal(rev.situacao, 'revisar')
  })

  it('reverterJustificativas ignora células que não foram apagadas', async () => {
    const gw = cenario()
    const plano = await simular28(gw)
    const rev = plano.itens.find(i => i.situacao === 'revisar' && i.celula)!
    await justificar(gw, plano, [{ celula: rev.celula!, codigo: 'AT' }])
    assert.equal(reverterJustificativas(plano, ['AH99']), false)
    assert.equal(rev.situacao, 'justificado')
  })
})
