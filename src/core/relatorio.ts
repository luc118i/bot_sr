import type { ItemPlano, Plano, Situacao } from './planner'

export const ROTULO_SITUACAO: Record<Situacao, string> = {
  escrever: 'Será escrito',
  confere: 'Já lançado — confere com o bot',
  divergente: 'Já lançado — DIVERGE do bot (não mexo)',
  ja_lancado: 'Já lançado à mão (não mexo)',
  revisar: 'Precisa de revisão',
  ambiguo: 'Match ambíguo — revisão',
  sem_linha_no_mes: 'Sem linha na aba do mês',
  nao_encontrado: 'Não encontrado na planilha',
  ausente_no_ponto: 'Não aparece no ponto',
}

const ORDEM: Situacao[] = [
  'escrever', 'revisar', 'divergente', 'nao_encontrado', 'sem_linha_no_mes', 'ambiguo',
  'confere', 'ja_lancado', 'ausente_no_ponto',
]

function linhaItem(i: ItemPlano): string {
  const quem = i.nomePlanilha || i.nomePonto || '?'
  const onde = i.celula ? `${i.celula}` : '-'
  const adm = i.adm ? `ADM ${i.adm}` : 'ADM ?'
  const cod = i.codigo ? ` → "${i.codigo}"` : ''
  const atual = i.valorAtual.trim() ? ` (célula: "${i.valorAtual}")` : ''
  return `  ${onde.padEnd(6)} ${adm.padEnd(9)} ${quem}${cod}${atual}\n           ${i.motivo}`
}

export function relatorioTexto(p: Plano, modo: 'simulacao' | 'escrita'): string {
  const out: string[] = []
  out.push(`Frequência — ${p.data} — aba "${p.aba}" — ${modo === 'simulacao' ? 'SIMULAÇÃO (nada foi escrito)' : 'ESCRITA'}`)
  out.push(`Gerado em ${p.geradoEm}`)
  out.push('')
  out.push('Resumo:')
  for (const s of ORDEM) if (p.resumo[s]) out.push(`  ${ROTULO_SITUACAO[s].padEnd(42)} ${p.resumo[s]}`)
  if (p.avisos.length) {
    out.push('')
    out.push('Avisos:')
    for (const a of p.avisos) out.push(`  ! ${a}`)
  }
  for (const s of ORDEM) {
    if (s === 'ausente_no_ponto' || s === 'ja_lancado') continue
    const its = p.itens.filter(i => i.situacao === s)
    if (!its.length) continue
    out.push('')
    out.push(`── ${ROTULO_SITUACAO[s]} (${its.length}) ──`)
    for (const i of its) out.push(linhaItem(i))
  }
  const ausentes = p.itens.filter(i => i.situacao === 'ausente_no_ponto')
  if (ausentes.length) {
    out.push('')
    out.push(`── ${ROTULO_SITUACAO.ausente_no_ponto} e célula vazia (${ausentes.length}) ──`)
    out.push('  ' + ausentes.map(i => `${i.celula} ${i.nomePlanilha || 'ADM ' + i.adm}`).join('; '))
  }
  return out.join('\n')
}
