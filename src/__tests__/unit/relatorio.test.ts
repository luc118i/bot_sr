import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { relatorioTexto, ROTULO_SITUACAO } from '../../core/relatorio'
import type { ItemPlano, Plano, Situacao } from '../../core/planner'

function item(situacao: Situacao, extra: Partial<ItemPlano> = {}): ItemPlano {
  return {
    situacao, nomePonto: 'ANA', adm: '1', nomePlanilha: 'ANA TESTE', linha: 8, celula: 'AH8', valorAtual: '',
    codigo: null, motivo: `motivo ${situacao}`, ponto: null, horario: null, ...extra,
  }
}

function plano(itens: ItemPlano[], avisos: string[] = []): Plano {
  const resumo = Object.fromEntries(Object.keys(ROTULO_SITUACAO).map(s => [s, itens.filter(i => i.situacao === s).length])) as Record<Situacao, number>
  return { data: '2026-09-28', aba: 'Setembro', geradoEm: '2026-09-28T22:00:00.000Z', escritas: [], itens, avisos, resumo }
}

describe('relatorioTexto', () => {
  it('cabeçalho diz o modo — simulação deixa claro que nada foi escrito', () => {
    const p = plano([])
    assert.match(relatorioTexto(p, 'simulacao'), /^Frequência — 2026-09-28 — aba "Setembro" — SIMULAÇÃO \(nada foi escrito\)/)
    assert.match(relatorioTexto(p, 'escrita'), /— ESCRITA$/m)
    assert.match(relatorioTexto(p, 'desfeita'), /ESCRITA DESFEITA/)
    assert.match(relatorioTexto(p, 'justificativa'), /JUSTIFICATIVA/)
  })

  it('toda situação tem rótulo', () => {
    for (const r of Object.values(ROTULO_SITUACAO)) assert.ok(r.length > 3)
  })

  it('lista pendências e escritas; esconde "fora do ponto" e "já lançado" (só no resumo)', () => {
    const t = relatorioTexto(plano([
      item('escrever', { codigo: '.' }), item('revisar'), item('ausente_no_ponto', { celula: 'AH9' }), item('ja_lancado', { celula: 'AH10', valorAtual: 'FO' }),
    ]), 'simulacao')
    assert.match(t, /── Será escrito \(1\) ──/)
    assert.match(t, /AH8 +ADM 1 +ANA TESTE → "\."/)
    assert.match(t, /── Precisa de revisão \(1\) ──/)
    assert.doesNotMatch(t, /── Fora do seu ponto/)
    assert.doesNotMatch(t, /── Já lançado à mão/)
    assert.match(t, /Fora do seu ponto \(outros setores\) +1/)
  })

  it('item sem célula/ADM/nome não quebra a linha', () => {
    const t = relatorioTexto(plano([item('nao_encontrado', { celula: null, adm: null, nomePlanilha: null, nomePonto: null })]), 'simulacao')
    assert.match(t, /- +ADM \? +\?/)
  })

  it('avisos aparecem com "!"', () => {
    assert.match(relatorioTexto(plano([], ['cuidado']), 'simulacao'), /Avisos:\n {2}! cuidado/)
  })

  it('ordem: escrever antes de revisar antes de confere', () => {
    const t = relatorioTexto(plano([item('confere', { codigo: '.', valorAtual: '.' }), item('revisar'), item('escrever', { codigo: 'P' })]), 'simulacao')
    const pos = (s: string) => t.indexOf(`── ${s}`)
    assert.ok(pos('Será escrito') < pos('Precisa de revisão'))
    assert.ok(pos('Precisa de revisão') < pos('Já lançado — confere'))
  })
})
