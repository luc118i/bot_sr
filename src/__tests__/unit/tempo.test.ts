import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  colunaA1, diaDaSemana, diasNoMes, formatHora, hojeISO, parseDataISO, parseDataPlanilha, parseHora, toISO,
} from '../../core/tempo'
import { posA1 } from '../helpers/planilha'

describe('tempo.parseDataISO', () => {
  it('aceita datas reais, inclusive 29/02 em ano bissexto', () => {
    assert.deepEqual(parseDataISO('2026-09-28'), { ano: 2026, mes: 9, dia: 28 })
    assert.deepEqual(parseDataISO(' 2028-02-29 '), { ano: 2028, mes: 2, dia: 29 })
  })

  it('recusa formato errado e data que não existe', () => {
    for (const s of ['28/09/2026', '2026-9-28', '2026-09-28T00:00', '', 'abc']) {
      assert.throws(() => parseDataISO(s), /formato AAAA-MM-DD/, s)
    }
    for (const s of ['2026-02-29', '2026-09-31', '2026-13-01', '2026-00-10', '2026-01-00']) {
      assert.throws(() => parseDataISO(s), /inexistente/, s)
    }
  })

  it('toISO é o inverso de parseDataISO', () => {
    for (const s of ['2026-01-01', '2026-12-31', '2028-02-29']) assert.equal(toISO(parseDataISO(s)), s)
  })
})

describe('tempo: calendário', () => {
  it('diasNoMes cobre fevereiro bissexto, século não bissexto e 400', () => {
    assert.equal(diasNoMes(2026, 2), 28)
    assert.equal(diasNoMes(2028, 2), 29)
    assert.equal(diasNoMes(2100, 2), 28)
    assert.equal(diasNoMes(2000, 2), 29)
    assert.deepEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => diasNoMes(2026, m)), [31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
  })

  it('diaDaSemana não depende do fuso', () => {
    assert.equal(diaDaSemana({ ano: 2026, mes: 9, dia: 27 }), 0) // domingo
    assert.equal(diaDaSemana({ ano: 2026, mes: 9, dia: 28 }), 1)
    assert.equal(diaDaSemana({ ano: 2026, mes: 10, dia: 1 }), 4)
  })

  it('hojeISO usa a data LOCAL, não a UTC', () => {
    // 23:30 local: em UTC pode já ser o dia seguinte (ou o anterior).
    assert.equal(hojeISO(new Date(2026, 8, 28, 23, 30)), '2026-09-28')
    assert.equal(hojeISO(new Date(2026, 8, 28, 0, 5)), '2026-09-28')
  })
})

describe('tempo.parseDataPlanilha', () => {
  it('entende pt-BR, ISO e o serial do Excel', () => {
    assert.equal(parseDataPlanilha('28/09/2026'), '2026-09-28')
    assert.equal(parseDataPlanilha('1/2/2026'), '2026-02-01')
    assert.equal(parseDataPlanilha('2026-09-28'), '2026-09-28')
    assert.equal(parseDataPlanilha('2026-09-28T03:00:00.000Z'), '2026-09-28')
    assert.equal(parseDataPlanilha('46293'), '2026-09-28')
    assert.equal(parseDataPlanilha('46293.75'), '2026-09-28') // fração = hora, não muda o dia
    assert.equal(parseDataPlanilha('25569'), '1970-01-01')
  })

  it('vazio e lixo viram null', () => {
    for (const s of ['', '   ', 'amanhã', '28-09-2026', '123', '12:00']) assert.equal(parseDataPlanilha(s), null, s)
  })

  it('data impossível vira null, não uma ISO inválida', () => {
    for (const s of ['31/02/2026', '29/02/2026', '00/01/2026', '15/13/2026', '2026-02-30', '2026-13-01']) {
      assert.equal(parseDataPlanilha(s), null, s)
    }
  })
})

describe('tempo.parseHora / formatHora', () => {
  it('aceita H:MM, HH:MM e HH:MM:SS', () => {
    assert.equal(parseHora('8:05'), 485)
    assert.equal(parseHora('08:05'), 485)
    assert.equal(parseHora('08:05:59'), 485)
    assert.equal(parseHora(' 00:00 '), 0)
    assert.equal(parseHora('23:59'), 23 * 60 + 59)
  })

  it('aceita a fração de dia do Excel', () => {
    assert.equal(parseHora('0.3333333333'), 480)
    assert.equal(parseHora('.5'), 720)
    assert.equal(parseHora('0.0'), 0)
  })

  it('recusa o que não é horário', () => {
    for (const s of ['25:00', '24:00', '08:60', '8', '08h00', '8:5', 'abc', '-1:00', '1.5', '']) assert.equal(parseHora(s), null, s)
    assert.equal(parseHora(null), null)
    assert.equal(parseHora(undefined), null)
  })

  it('formatHora é o inverso de parseHora em todo o dia', () => {
    for (let m = 0; m < 24 * 60; m++) assert.equal(parseHora(formatHora(m)), m)
    assert.equal(formatHora(485), '08:05')
  })
})

describe('tempo.colunaA1', () => {
  it('converte as fronteiras de letra', () => {
    assert.deepEqual([1, 26, 27, 52, 53, 702, 703, 16384].map(colunaA1), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD'])
    assert.equal(colunaA1(34), 'AH')
  })

  it('ida e volta com o parser A1 dos testes, de A até XFD', () => {
    for (let c = 1; c <= 16384; c++) assert.equal(posA1(`${colunaA1(c)}1`)[1], c - 1)
  })

  it('coluna 0 ou negativa vira texto vazio (nunca uma coluna válida)', () => {
    assert.equal(colunaA1(0), '')
    assert.equal(colunaA1(-3), '')
  })
})
