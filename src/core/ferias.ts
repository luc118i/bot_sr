import type { LayoutMes } from './layoutMes'
import { normalizeAdm } from './normalize'
import type { ItemPlano, Plano, Situacao } from './planner'
import { colunaA1, diasNoMes, parseDataISO, toISO } from './tempo'

// Férias: o operador escolhe um colaborador e um período (por padrão o mês
// inteiro) e o bot grava "FE" em todos os dias úteis desse período de uma vez
// — inclusive dias que ainda vão chegar, porque férias são combinadas antes.
// Mesmas proteções do preenchimento diário:
//   - célula já preenchida NUNCA é sobrescrita (FE igual = confere; outro
//     código = fica como está e aparece no resumo);
//   - domingo e coluna oculta (feriado) não são preenchidos;
//   - tudo desfazível (o resultado vira um Plano comum, com relatório e Desfazer).
// O preenchimento diário depois encontra a célula com FE e não mexe: se o
// ponto mostrar FÉRIAS, confere; se a pessoa voltou antes e bateu ponto, o dia
// aparece como "diverge" pra revisão.

export const MAX_DIAS_FERIAS = 62

export interface PeriodoFerias { inicio: string; fim: string }

/** Valida o período e divide por mês (cada mês é uma aba). */
export function mesesDoPeriodo(p: PeriodoFerias): { ano: number; mes: number; diaIni: number; diaFim: number }[] {
  const ini = parseDataISO(p.inicio), fim = parseDataISO(p.fim)
  if (p.fim < p.inicio) throw new Error(`O período de férias termina (${p.fim}) antes de começar (${p.inicio}).`)
  const dias = Math.round((new Date(fim.ano, fim.mes - 1, fim.dia).getTime() - new Date(ini.ano, ini.mes - 1, ini.dia).getTime()) / 86400000) + 1
  if (dias > MAX_DIAS_FERIAS) throw new Error(`Período de ${dias} dias — o máximo de uma vez é ${MAX_DIAS_FERIAS}. Confira as datas.`)
  const out: { ano: number; mes: number; diaIni: number; diaFim: number }[] = []
  for (let a = ini.ano, m = ini.mes; a < fim.ano || (a === fim.ano && m <= fim.mes); m === 12 ? (a++, m = 1) : m++) {
    const primeiro = a === ini.ano && m === ini.mes
    const ultimo = a === fim.ano && m === fim.mes
    out.push({ ano: a, mes: m, diaIni: primeiro ? ini.dia : 1, diaFim: ultimo ? fim.dia : diasNoMes(a, m) })
  }
  return out
}

export interface EntradaFerias {
  adm: string
  ano: number
  mes: number
  diaIni: number
  diaFim: number
  layout: LayoutMes
  grid: string[][]
  now?: Date
}

/** Plano de férias de UM mês: um item por dia útil do período, na linha do colaborador. */
export function planejarFeriasDoMes(e: EntradaFerias): Plano {
  const { layout, grid } = e
  const adm = normalizeAdm(e.adm)
  if (!adm) throw new Error('Escolha o colaborador (ADM) que vai sair de férias.')
  const linhas = layout.linhas.filter(l => l.adm === adm)
  if (!linhas.length) throw new Error(`ADM ${adm} não tem linha na aba ${layout.aba}.`)
  if (linhas.length > 1) throw new Error(`ADM ${adm} aparece em mais de uma linha da aba ${layout.aba} (${linhas.map(l => l.linha).join(', ')}) — corrija antes de lançar férias.`)
  const l = linhas[0]!

  const itens: ItemPlano[] = []
  const escritas: Plano['escritas'] = []
  const pulados: string[] = []
  for (let dia = e.diaIni; dia <= e.diaFim; dia++) {
    const data = toISO({ ano: e.ano, mes: e.mes, dia })
    const naoUtil = layout.diasNaoUteis.get(dia)
    if (naoUtil) { pulados.push(`${String(dia).padStart(2, '0')} (${naoUtil === 'domingo' ? 'domingo' : 'feriado'})`); continue }
    const col = layout.colunaDoDia.get(dia)
    if (!col) throw new Error(`[${layout.aba}] Sem coluna para o dia ${dia}.`)
    const valorAtual = String(grid[l.linha - 1]?.[col - 1] ?? '')
    const atual = valorAtual.trim()
    let situacao: Situacao = 'escrever'
    let motivo = `Férias de ${data}`
    if (!atual && valorAtual.length > 0) { situacao = 'ja_lancado'; motivo = 'Célula contém só espaços — não mexo; apague-a se quiser o FE' }
    else if (atual.toUpperCase() === 'FE') { situacao = 'confere'; motivo = 'Já está com FE' }
    else if (atual) { situacao = 'ja_lancado'; motivo = `Já tem "${atual}" — não mexo` }
    itens.push({
      situacao, nomePonto: null, adm, nomePlanilha: l.nome, linha: l.linha, celula: `${colunaA1(col)}${l.linha}`,
      valorAtual, codigo: 'FE', motivo: `${String(dia).padStart(2, '0')}/${String(e.mes).padStart(2, '0')}: ${motivo}`, ponto: null, horario: null,
    })
    if (situacao === 'escrever') escritas.push({ celula: `${colunaA1(col)}${l.linha}`, linha: l.linha, coluna: col, codigo: 'FE' })
  }

  const avisos = [...layout.avisos]
  if (pulados.length) avisos.push(`Não preenchidos (domingo/feriado): ${pulados.join(', ')}`)
  const resumo = Object.fromEntries(
    (['escrever', 'confere', 'divergente', 'ja_lancado', 'revisar', 'ambiguo', 'sem_linha_no_mes', 'nao_encontrado', 'ausente_no_ponto', 'justificado'] as Situacao[])
      .map(s => [s, itens.filter(i => i.situacao === s).length]),
  ) as Record<Situacao, number>
  return {
    data: toISO({ ano: e.ano, mes: e.mes, dia: e.diaIni }),
    aba: layout.aba,
    geradoEm: (e.now ?? new Date()).toISOString(),
    escritas,
    itens,
    avisos,
    resumo,
  }
}
