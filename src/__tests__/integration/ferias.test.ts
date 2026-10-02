// Férias: FE em todos os dias úteis do período, de uma vez, sem nunca
// sobrescrever o que já está na planilha. Nomes fictícios.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mesesDoPeriodo } from '../../core/ferias'
import { desfazerEscrita, gravarFerias, planejarFerias } from '../../service'
import { colDoDia, gridMes, MemoryGateway, posA1 } from '../helpers/planilha'

const AGORA = new Date(2026, 9, 2, 10, 0)

function planilha() {
  const gw = new MemoryGateway({
    Setembro: gridMes(2026, 9, [['101', 'ANA TESTE'], ['202', 'BRUNO EXEMPLO']]),
    Outubro: gridMes(2026, 10, [['101', 'ANA TESTE', { 5: 'AT', 6: 'FE', 7: ' ' }], ['202', 'BRUNO EXEMPLO']]),
  })
  gw.ocultas['Outubro'] = new Set([colDoDia(12)]) // feriado
  return gw
}
const valor = (gw: MemoryGateway, aba: string, celula: string) => { const [r, c] = posA1(celula); return gw.abas[aba]![r]![c] }

describe('férias', () => {
  it('o mês todo: grava FE só nos dias úteis vazios, sem domingo, feriado nem célula preenchida', async () => {
    const gw = planilha()
    const [plano, ...resto] = await planejarFerias(gw, '101', { inicio: '2026-10-01', fim: '2026-10-31' }, AGORA)
    assert.equal(resto.length, 0)
    assert.equal(plano!.aba, 'Outubro')
    // 31 dias − 4 domingos − 1 feriado − AT − FE − célula só com espaço = 23
    assert.equal(plano!.escritas.length, 23)
    assert.equal(plano!.resumo.confere, 1)
    assert.equal(plano!.resumo.ja_lancado, 2)
    assert.ok(plano!.escritas.every(e => e.codigo === 'FE' && e.linha === 8))
    const cols = new Set(plano!.escritas.map(e => e.coluna))
    for (const d of [4, 11, 18, 25, 12, 5, 6, 7]) assert.ok(!cols.has(colDoDia(d)), `dia ${d} não pode ser gravado`)
    assert.match(plano!.avisos.join('\n'), /04 \(domingo\).*12 \(feriado\)/)

    assert.deepEqual(gw.escritas, []) // planejar não grava
    const { dias, erro } = await gravarFerias(gw, [plano!])
    assert.equal(erro, null)
    assert.equal(dias[0]!.escritas.length, 23)
    assert.equal(gw.abas['Outubro']![7]![colDoDia(1) - 1], 'FE')
    assert.equal(gw.abas['Outubro']![7]![colDoDia(5) - 1], 'AT') // atestado continua
    assert.equal(valor(gw, 'Outubro', 'G9') ?? '', '')             // outro colaborador (linha 9, dia 1) intocado
  })

  it('período que cruza o mês vira um plano por aba', async () => {
    const gw = planilha()
    const planos = await planejarFerias(gw, '202', { inicio: '2026-09-28', fim: '2026-10-03' }, AGORA)
    assert.deepEqual(planos.map(p => [p.aba, p.escritas.length]), [['Setembro', 3], ['Outubro', 3]])
    const { dias } = await gravarFerias(gw, planos)
    assert.equal(dias.length, 2)
    assert.equal(valor(gw, 'Setembro', dias[0]!.escritas[0]!.celula), 'FE')
  })

  it('não sobrescreve quem preencheu entre a prévia e a gravação; Desfazer apaga só o FE do bot', async () => {
    const gw = planilha()
    const [plano] = await planejarFerias(gw, '202', { inicio: '2026-10-01', fim: '2026-10-03' }, AGORA)
    gw.abas['Outubro']![8]![colDoDia(2) - 1] = 'AT'
    const { dias } = await gravarFerias(gw, [plano!])
    assert.equal(dias[0]!.escritas.length, 2)
    assert.equal(dias[0]!.puladas.length, 1)
    assert.equal(gw.abas['Outubro']![8]![colDoDia(2) - 1], 'AT')

    gw.abas['Outubro']![8]![colDoDia(3) - 1] = 'FO' // alguém trocou depois
    const r = await desfazerEscrita(gw, dias[0]!.aba, dias[0]!.escritas)
    assert.equal(r.apagadas.length, 1)
    assert.equal(r.mantidas.length, 1)
    assert.equal(gw.abas['Outubro']![8]![colDoDia(1) - 1], '')
    assert.equal(gw.abas['Outubro']![8]![colDoDia(3) - 1], 'FO')
  })

  it('erros claros e nada planejado: ADM sem linha, mês sem aba, datas trocadas, período longo demais', async () => {
    const gw = planilha()
    await assert.rejects(planejarFerias(gw, '999', { inicio: '2026-10-01', fim: '2026-10-31' }), /ADM 999 não tem linha na aba Outubro/)
    await assert.rejects(planejarFerias(gw, '101', { inicio: '2026-10-20', fim: '2026-11-10' }), /Novembro/)
    await assert.rejects(planejarFerias(gw, '101', { inicio: '2026-10-10', fim: '2026-10-01' }), /antes de começar/)
    await assert.rejects(planejarFerias(gw, '101', { inicio: '2026-08-01', fim: '2026-10-31' }), /máximo/)
    await assert.rejects(planejarFerias(gw, '', { inicio: '2026-10-01', fim: '2026-10-31' }), /Escolha o colaborador/)
    await assert.rejects(planejarFerias(gw, '101', { inicio: '2027-01-02', fim: '2027-01-30' }), /é de 2026/)
    assert.deepEqual(gw.escritas, [])
  })

  it('mesesDoPeriodo divide na virada de mês e de ano', () => {
    assert.deepEqual(mesesDoPeriodo({ inicio: '2026-12-20', fim: '2027-01-10' }), [
      { ano: 2026, mes: 12, diaIni: 20, diaFim: 31 },
      { ano: 2027, mes: 1, diaIni: 1, diaFim: 10 },
    ])
    assert.deepEqual(mesesDoPeriodo({ inicio: '2026-02-01', fim: '2026-02-28' }), [{ ano: 2026, mes: 2, diaIni: 1, diaFim: 28 }])
  })
})
