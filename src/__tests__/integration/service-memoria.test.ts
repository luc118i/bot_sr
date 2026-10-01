// O que o app lembra entre aberturas: relatórios, histórico, último resultado
// e dias conferidos. Tudo na pasta de dados temporária do setup.
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { contarPendencias } from '../../core/planner'
import { getRelatoriosDir } from '../../logger'
import {
  executarEscrita, lerConferencias, lerUltimoResultado, listarHistorico, registrarConferencias, registrarFeriados,
  salvarRelatorio, salvarUltimoResultado, simular,
} from '../../service'
import { cenario, htmlFixture, NOITE } from '../helpers/planilha'

const dataDir = () => process.env['DATA_DIR']!
const limparDados = () => { for (const f of fs.readdirSync(dataDir())) fs.rmSync(path.join(dataDir(), f), { recursive: true, force: true }) }

/** ISO local de N dias atrás. */
function diasAtras(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('conferências (dias já conferidos)', () => {
  beforeEach(limparDados)

  it('registra o dia conferido com pendências e feriado como resolvido', async () => {
    const plano = await simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    plano.data = diasAtras(1)
    registrarConferencias([plano], '2026-09-30T16:00:00.000Z')
    registrarFeriados([
      { data: diasAtras(2), arquivo: 'ponto', motivo: 'coluna oculta (feriado)' },
      { data: diasAtras(3), arquivo: 'ponto', motivo: 'Ainda são 10:00' },
    ], '2026-09-30T16:00:00.000Z')
    const c = lerConferencias()
    assert.equal(c[diasAtras(1)]!.pendencias, contarPendencias(plano))
    assert.equal(c[diasAtras(1)]!.pendentes.length, contarPendencias(plano))
    assert.ok(c[diasAtras(2)]!.feriado)
    assert.equal(c[diasAtras(3)], undefined) // antes do corte não conta como conferido
  })

  it('sem "quando", mantém a hora da conferência anterior', async () => {
    const plano = await simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    plano.data = diasAtras(1)
    registrarConferencias([plano], '2026-09-30T16:00:00.000Z')
    registrarConferencias([plano])
    assert.equal(lerConferencias()[diasAtras(1)]!.quando, '2026-09-30T16:00:00.000Z')
  })

  it('guarda só ~100 dias', async () => {
    const plano = await simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    const velho = { ...plano, data: diasAtras(150) }
    const novo = { ...plano, data: diasAtras(5) }
    registrarConferencias([velho, novo], 'x')
    assert.deepEqual(Object.keys(lerConferencias()), [diasAtras(5)])
  })

  it('arquivo corrompido não derruba o app — começa vazio', () => {
    fs.writeFileSync(path.join(dataDir(), 'conferencias.json'), '{ isto não é json')
    assert.deepEqual(lerConferencias(), {})
  })
})

describe('último resultado', () => {
  beforeEach(limparDados)

  it('ida e volta pelo disco', async () => {
    const plano = await simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    salvarUltimoResultado({ quando: 'x', modo: 'gravado', lote: { geradoEm: '', planos: [plano], pulados: [], erros: [] }, gravadas: 3 })
    const u = lerUltimoResultado()!
    assert.equal(u.lote.planos[0]!.data, plano.data)
    assert.deepEqual(u.lote.planos[0]!.itens, plano.itens)
  })

  it('sem arquivo ou corrompido → null', () => {
    assert.equal(lerUltimoResultado(), null)
    fs.writeFileSync(path.join(dataDir(), 'ultimo-resultado.json'), '')
    assert.equal(lerUltimoResultado(), null)
  })
})

describe('relatórios e histórico', () => {
  beforeEach(limparDados)

  it('salva .txt e .json lado a lado; o .json traz o plano e as células mexidas', async () => {
    const gw = cenario()
    const plano = await simular(gw, { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    const r = await executarEscrita(gw, plano)
    const txt = salvarRelatorio(plano, 'escrita', r)
    assert.ok(txt.startsWith(getRelatoriosDir()))
    assert.match(path.basename(txt), /^2026-09-28_escrita_2026-09-28T22-00-00-000Z\.txt$|^2026-09-28_escrita_.*\.txt$/)
    const json = JSON.parse(fs.readFileSync(txt.replace(/\.txt$/, '.json'), 'utf-8'))
    assert.deepEqual(json.extra.escritas, r.escritas)
    assert.match(fs.readFileSync(txt, 'utf-8'), /── Gravadas \(4\) ──/)
  })

  it('nome do arquivo não tem caractere proibido no Windows', async () => {
    const plano = await simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    for (const modo of ['simulacao', 'escrita', 'justificativa', 'desfeita'] as const) {
      assert.doesNotMatch(path.basename(salvarRelatorio(plano, modo)), /[<>:"/\\|?*]/)
    }
  })

  it('duas justificativas do mesmo plano não se sobrescrevem', async () => {
    const plano = await simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    const a = salvarRelatorio(plano, 'justificativa', { escritas: [{ celula: 'AH11', codigo: 'AT' }], puladas: [] })
    await new Promise(r => setTimeout(r, 5))
    const b = salvarRelatorio(plano, 'justificativa', { escritas: [{ celula: 'AH11', codigo: 'F' }], puladas: [] })
    assert.notEqual(a, b)
  })

  it('histórico: mais recente primeiro, conta células, ignora simulação e arquivo corrompido', async () => {
    const gw = cenario()
    const plano = await simular(gw, { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    const dir = getRelatoriosDir()
    salvarRelatorio(plano, 'simulacao')
    const esc = salvarRelatorio(plano, 'escrita', { escritas: [{ celula: 'AH8', codigo: '.' }, { celula: 'AH9', codigo: '.' }], puladas: [] })
    fs.utimesSync(esc.replace(/\.txt$/, '.json'), new Date(2026, 8, 28, 20), new Date(2026, 8, 28, 20))
    const des = salvarRelatorio({ ...plano, geradoEm: '2026-09-28T23:00:00.000Z' }, 'desfeita', { apagadas: ['AH8'], mantidas: [] })
    fs.utimesSync(des.replace(/\.txt$/, '.json'), new Date(2026, 8, 28, 21), new Date(2026, 8, 28, 21))
    fs.writeFileSync(path.join(dir, '2026-09-28_escrita_quebrado.json'), '{')

    const h = listarHistorico()
    assert.deepEqual(h.map(x => [x.tipo, x.celulas]), [['desfeita', 1], ['escrita', 2]])
    assert.ok(h.every(x => x.aba === 'Setembro' && x.data === '2026-09-28'))
  })

  it('histórico respeita o limite e funciona sem pasta', () => {
    assert.deepEqual(listarHistorico(), [])
  })
})
