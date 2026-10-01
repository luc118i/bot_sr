// Fluxo de um clique (preencherAutomatico) e conferência em lote, com a API do
// ponto simulada.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { preencherAutomatico, semanaDe, simularLote, type EventoProgresso } from '../../service'
import { PontoAuthError } from '../../ponto/secullum'
import { cenario, htmlDoDia, listaApi, preenchidas } from '../helpers/planilha'

const pontoFixo = { pontoDiario: async () => listaApi() }

describe('preencherAutomatico', () => {
  it('busca 7 dias, pula domingo sem consultar, hoje antes do corte; grava o resto', async () => {
    const gw = cenario()
    const consultados: string[] = []
    const ponto = { pontoDiario: async (data: string) => { consultados.push(data); return listaApi() } }
    const r = await preencherAutomatico(gw, ponto, { now: new Date(2026, 8, 30, 11, 0) })

    assert.deepEqual(consultados, ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29', '2026-09-30'])
    assert.deepEqual(r.lote.pulados.map(p => p.data), ['2026-09-27', '2026-09-30'])
    assert.match(r.lote.pulados[1]!.motivo, /18:00/)
    assert.deepEqual(r.lote.planos.map(p => p.data), ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29'])
    assert.equal(r.escrita!.erro, null)
    assert.ok(r.escrita!.dias.every(d => d.escritas.every(e => e.codigo !== 'F')))
    assert.equal(gw.abas['Setembro']![7]![34], '.') // JOAO (linha 8) no dia 29 (AI)
  })

  it('modo "só conferir" não grava nada', async () => {
    const gw = cenario()
    const antes = preenchidas(gw)
    const r = await preencherAutomatico(gw, pontoFixo, { now: new Date(2026, 8, 30, 19, 0), apenasConferir: true })
    assert.equal(r.escrita, null)
    assert.ok(r.lote.planos.some(p => p.escritas.length > 0))
    assert.deepEqual(preenchidas(gw), antes)
    assert.deepEqual(gw.escritas, [])
  })

  it('feriado no ponto com coluna visível vira aviso; senha errada para tudo', async () => {
    const gw = cenario()
    const r = await preencherAutomatico(gw, { pontoDiario: async (d: string) => listaApi(d === '2026-09-29') }, { now: new Date(2026, 8, 30, 19, 0), apenasConferir: true })
    assert.match(r.lote.planos.find(p => p.data === '2026-09-29')!.avisos.join('\n'), /marca 2026-09-29 como feriado/)

    const semAcesso = { pontoDiario: async () => { throw new PontoAuthError('Número ou senha do ponto inválidos.') } }
    await assert.rejects(preencherAutomatico(gw, semAcesso, { now: new Date(2026, 8, 30, 19, 0) }), /senha do ponto/)
  })

  it('senha errada não grava NADA, nem dias que já tinham sido lidos', async () => {
    const gw = cenario()
    let n = 0
    const ponto = { pontoDiario: async () => { if (++n === 3) throw new PontoAuthError('senha'); return listaApi() } }
    await assert.rejects(preencherAutomatico(gw, ponto, { now: new Date(2026, 8, 30, 19, 0) }), PontoAuthError)
    assert.deepEqual(gw.escritas, [])
  })

  it('erro de rede num dia não impede os outros', async () => {
    const gw = cenario()
    const ponto = { pontoDiario: async (d: string) => { if (d === '2026-09-29') throw new Error('timeout'); return listaApi() } }
    const r = await preencherAutomatico(gw, ponto, { datas: ['2026-09-28', '2026-09-29'], now: new Date(2026, 8, 30, 19, 0) })
    assert.deepEqual(r.lote.erros.map(e => [e.data, e.motivo]), [['2026-09-29', 'timeout']])
    assert.deepEqual(r.escrita!.dias.map(d => d.data), ['2026-09-28'])
  })

  it('ponto vazio num dia vira erro desse dia', async () => {
    const r = await preencherAutomatico(cenario(), { pontoDiario: async () => [] }, { datas: ['2026-09-28'], now: new Date(2026, 8, 30, 19, 0) })
    assert.match(r.lote.erros[0]!.motivo, /nenhum colaborador/)
  })

  it('data futura não consulta o ponto', async () => {
    let chamadas = 0
    const r = await preencherAutomatico(cenario(), { pontoDiario: async () => { chamadas++; return listaApi() } },
      { datas: ['2026-10-01'], now: new Date(2026, 8, 30, 19, 0) })
    assert.equal(chamadas, 0)
    assert.match(r.lote.erros[0]!.motivo, /futuro/)
  })

  it('datas repetidas/fora de ordem são consultadas uma vez, em ordem', async () => {
    const vistos: string[] = []
    await preencherAutomatico(cenario(), { pontoDiario: async (d: string) => { vistos.push(d); return listaApi() } },
      { datas: ['2026-09-29', '2026-09-28', '2026-09-29'], now: new Date(2026, 8, 30, 19, 0), apenasConferir: true })
    assert.deepEqual(vistos, ['2026-09-28', '2026-09-29'])
  })

  it('a janela padrão de 7 dias atravessa a virada de mês e de ano', async () => {
    const vistos: string[] = []
    await preencherAutomatico(cenario(), { pontoDiario: async (d: string) => { vistos.push(d); return [] } },
      { now: new Date(2027, 0, 2, 19, 0), apenasConferir: true })
    // 27/12 é domingo; 2027 nem tem aba (planilha de 2026) — só confere que os dias certos foram pedidos.
    assert.deepEqual(vistos, ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  })

  it('semana: cada dia vai pra SUA coluna com o ponto DAQUELE dia', async () => {
    const gw = cenario()
    const entradaJoao: Record<string, string> = {
      '2026-09-21': '07:55', '2026-09-22': '08:20', '2026-09-23': '08:05',
      '2026-09-24': '09:00', '2026-09-25': '07:59', '2026-09-26': '08:06',
    }
    const ponto = {
      pontoDiario: async (data: string) => listaApi().map(l =>
        l.funcionarioNome === 'JOAO EXEMPLO DA SILVA' ? { ...l, batidas: [{ valor: entradaJoao[data]! }] } : l),
    }
    const r = await preencherAutomatico(gw, ponto, { datas: semanaDe('2026-09-24'), now: new Date(2026, 8, 30, 19, 0) })
    assert.equal(r.escrita!.erro, null)
    const joao = (dia: number) => gw.abas['Setembro']![7]![5 + dia]
    assert.deepEqual([21, 22, 23, 24, 25, 26].map(joao), ['.', 'P', '.', 'P', '.', 'P'])
    assert.ok([...Array(31).keys()].map(i => i + 1).filter(d => d < 21 || d > 26).every(d => !joao(d)))
  })
})

describe('andamento (eventos de progresso)', () => {
  it('cada dia passa pelas fases em ordem e o total fecha', async () => {
    const eventos: EventoProgresso[] = []
    await preencherAutomatico(cenario(), pontoFixo, {
      datas: ['2026-09-26', '2026-09-27', '2026-09-28'], now: new Date(2026, 8, 30, 19, 0), onProgresso: e => eventos.push(e),
    })
    assert.deepEqual(eventos[0], { tipo: 'inicio', datas: ['2026-09-26', '2026-09-27', '2026-09-28'], gravando: true })
    assert.deepEqual(eventos.at(-1), { tipo: 'fim' })
    const fases = (data: string) => eventos.filter((e): e is Extract<EventoProgresso, { tipo: 'dia' }> => e.tipo === 'dia' && e.data === data).map(e => e.fase)
    assert.deepEqual(fases('2026-09-27'), ['pulado'])
    assert.deepEqual(fases('2026-09-28'), ['ponto', 'planilha', 'planilha', 'conferido', 'gravar', 'pronto'])
  })

  it('em simulação termina em "pronto" sem passar por "gravar"', async () => {
    const eventos: EventoProgresso[] = []
    await preencherAutomatico(cenario(), pontoFixo, {
      datas: ['2026-09-28'], apenasConferir: true, now: new Date(2026, 8, 30, 19, 0), onProgresso: e => eventos.push(e),
    })
    const fases = eventos.filter(e => e.tipo === 'dia').map(e => (e as any).fase)
    assert.ok(!fases.includes('gravar'))
    assert.equal(fases.at(-1), 'pronto')
    assert.equal((eventos[0] as any).gravando, false)
  })

  it('todo dia termina num estado final (pronto/pulado/erro), sempre com "fim"', async () => {
    const eventos: EventoProgresso[] = []
    const ponto = { pontoDiario: async (d: string) => { if (d === '2026-09-25') throw new Error('x'); return listaApi() } }
    await preencherAutomatico(cenario(), ponto, { now: new Date(2026, 8, 30, 11, 0), onProgresso: e => eventos.push(e) })
    const ultimo = new Map<string, string>()
    for (const e of eventos) if (e.tipo === 'dia') ultimo.set(e.data, e.fase)
    assert.ok([...ultimo.values()].every(f => ['pronto', 'pulado', 'erro'].includes(f)), JSON.stringify([...ultimo]))
    assert.equal(ultimo.size, 7)
    assert.deepEqual(eventos.at(-1), { tipo: 'fim' })
  })

  it('senha errada também fecha o andamento com "fim"', async () => {
    const eventos: EventoProgresso[] = []
    await assert.rejects(preencherAutomatico(cenario(), { pontoDiario: async () => { throw new PontoAuthError('x') } },
      { datas: ['2026-09-28'], now: new Date(2026, 8, 30, 19), onProgresso: e => eventos.push(e) }))
    assert.deepEqual(eventos.at(-1), { tipo: 'fim' })
  })
})

describe('simularLote (vários HTMLs)', () => {
  it('um plano por dia, pula domingo/feriado, cruza o mês e aponta dia repetido', async () => {
    const gw = cenario()
    const dias = ['2026-09-25', '2026-09-27', '2026-09-28', '2026-09-30', '2026-10-01', '2026-09-07']
    const lote = await simularLote(gw, {
      htmls: [...dias.map(d => ({ arquivo: `${d}.html`, html: htmlDoDia(d) })), { arquivo: 'copia.html', html: htmlDoDia('2026-09-28') }],
      now: new Date(2026, 9, 1, 19, 0),
    })
    assert.deepEqual(lote.planos.map(p => `${p.data}@${p.aba}`), ['2026-09-25@Setembro', '2026-09-28@Setembro', '2026-09-30@Setembro', '2026-10-01@Outubro'])
    assert.deepEqual(lote.pulados.map(p => p.data), ['2026-09-07', '2026-09-27'])
    assert.equal(lote.erros.length, 1)
    assert.match(lote.erros[0]!.motivo, /repetido.*2026-09-28\.html/)
    assert.ok(lote.planos[0]!.escritas.every(e => e.celula.startsWith('AE')))
    assert.ok(lote.planos[2]!.escritas.every(e => e.celula.startsWith('AJ')))
    assert.deepEqual(lote.planos[3]!.escritas.map(e => e.celula), ['G8'])
  })

  it('HTML que não é do ponto e HTML com dois dias viram erro', async () => {
    const misto = htmlDoDia('2026-09-28').replace('dia-resumido-2026-09-28', 'dia-resumido-2026-09-29')
    const lote = await simularLote(cenario(), {
      htmls: [{ arquivo: 'login.html', html: '<p>login</p>' }, { arquivo: 'misto.html', html: misto }],
      now: new Date(2026, 9, 1, 19),
    })
    assert.deepEqual(lote.planos, [])
    assert.match(lote.erros[0]!.motivo, /Nenhum colaborador/)
    assert.match(lote.erros[1]!.motivo, /de que dia/)
  })
})

describe('semanaDe', () => {
  it('segunda a sábado da semana da data (domingo encerra a semana anterior)', () => {
    assert.deepEqual(semanaDe('2026-09-30'), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'])
    assert.deepEqual(semanaDe('2026-09-27'), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'])
    assert.equal(semanaDe('2026-09-28')[0], '2026-09-28')
  })

  it('atravessa a virada de ano', () => {
    assert.deepEqual(semanaDe('2027-01-01'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
  })

  it('não erra na semana do horário de verão (fuso com DST)', () => {
    // Datas de mudança de horário em vários países — 6 dias distintos e consecutivos, sempre.
    for (const d of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01', '2018-11-04', '2018-02-18']) {
      const s = semanaDe(d)
      assert.equal(new Set(s).size, 6, d)
      for (let i = 1; i < 6; i++) {
        const [a, b] = [new Date(s[i - 1] + 'T12:00:00Z'), new Date(s[i] + 'T12:00:00Z')]
        assert.equal(b.getTime() - a.getTime(), 86400000, `${d}: ${s.join(',')}`)
      }
    }
  })
})
