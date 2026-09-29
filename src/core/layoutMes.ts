import { normalize, normalizeAdm } from './normalize'
import { colunaA1, diaDaSemana, diasNoMes, LETRA_DIA_SEMANA, MESES } from './tempo'

// Layout de uma aba de mês. NADA aqui é fixo por posição: a cópia analisada
// mostrou que as colunas mudam entre abas (em Maio os totais começam em AL, em
// Setembro em AM) e que o cabeçalho de dias é digitado à mão e às vezes está
// errado:
//   - Maio: pula o dia 3 (1, 2, 4, 5...) — só 30 colunas pra um mês de 31 dias;
//   - Julho: dias repetidos e pulados (…6, 7, 7, 8… 11, 13, 14, 14…);
//   - Setembro: tem coluna "31" num mês de 30 dias.
// Então: acha o cabeçalho pelos textos "ADM"/"COLABORADOR", lê a sequência de
// dias e SÓ ACEITA se ela for exatamente 1, 2, 3, … sem buraco nem repetição.
// Qualquer coisa diferente aborta o mês — escrever na coluna errada é o pior
// erro possível aqui, pior que não escrever nada.

export interface LinhaColaborador {
  linha: number // 1-based, como na planilha
  adm: string
  nome: string
}

export interface LayoutMes {
  aba: string
  linhaCabecalho: number
  colAdm: number
  colNome: number
  colunaDoDia: Map<number, number>
  linhas: LinhaColaborador[]
  avisos: string[]
}

export class LayoutInvalidoError extends Error {}

export function nomeAbaDoMes(abas: string[], mes: number): string {
  const alvo = normalize(MESES[mes - 1])
  const achadas = abas.filter(a => normalize(a) === alvo)
  if (achadas.length === 0) {
    throw new LayoutInvalidoError(`Aba do mês "${MESES[mes - 1]}" não encontrada. Abas existentes: ${abas.join(', ')}`)
  }
  if (achadas.length > 1) {
    throw new LayoutInvalidoError(`Mais de uma aba parece ser "${MESES[mes - 1]}": ${achadas.join(', ')}`)
  }
  return achadas[0]!
}

export function detectarLayout(aba: string, grid: string[][], ano: number, mes: number): LayoutMes {
  const avisos: string[] = []
  const cell = (r: number, c: number) => String(grid[r - 1]?.[c - 1] ?? '').trim()

  // 1. Linha de cabeçalho: a primeira (nas 20 primeiras) com "ADM" e "COLABORADOR".
  let linhaCabecalho = -1, colAdm = -1, colNome = -1
  for (let r = 1; r <= Math.min(20, grid.length) && linhaCabecalho === -1; r++) {
    const row = grid[r - 1] ?? []
    const a = row.findIndex(v => normalize(v) === 'ADM')
    const n = row.findIndex(v => normalize(v).startsWith('COLABORADOR'))
    if (a !== -1 && n !== -1) { linhaCabecalho = r; colAdm = a + 1; colNome = n + 1 }
  }
  if (linhaCabecalho === -1) {
    throw new LayoutInvalidoError(`[${aba}] Cabeçalho com "ADM" e "COLABORADOR" não encontrado nas 20 primeiras linhas.`)
  }

  // 2. Sequência de dias: começa na primeira célula "1" depois do nome e vai
  //    até a primeira célula que não é número.
  const header = grid[linhaCabecalho - 1] ?? []
  let c = colNome + 1
  while (c <= header.length && cell(linhaCabecalho, c) !== '1') c++
  if (c > header.length) {
    throw new LayoutInvalidoError(`[${aba}] Nenhuma coluna de dia "1" na linha ${linhaCabecalho}.`)
  }
  const primeiraCol = c
  const seq: number[] = []
  while (/^\d{1,2}$/.test(cell(linhaCabecalho, c))) { seq.push(+cell(linhaCabecalho, c)); c++ }

  const nDias = diasNoMes(ano, mes)
  const problemas: string[] = []
  seq.forEach((d, i) => {
    if (d !== i + 1) problemas.push(`coluna ${colunaA1(primeiraCol + i)} diz "${d}", esperado "${i + 1}"`)
  })
  if (problemas.length) {
    throw new LayoutInvalidoError(
      `[${aba}] Cabeçalho de dias (linha ${linhaCabecalho}) fora de sequência — corrija antes de rodar o bot: ` +
      problemas.slice(0, 5).join('; ') + (problemas.length > 5 ? `; e mais ${problemas.length - 5}` : ''),
    )
  }
  if (seq.length < nDias) {
    throw new LayoutInvalidoError(`[${aba}] Só ${seq.length} colunas de dia, mas ${MESES[mes - 1]}/${ano} tem ${nDias} dias.`)
  }

  const colunaDoDia = new Map<number, number>()
  for (let d = 1; d <= nDias; d++) colunaDoDia.set(d, primeiraCol + d - 1)

  // 3. Linhas de colaborador: toda linha abaixo do cabeçalho com ADM preenchido.
  const linhas: LinhaColaborador[] = []
  for (let r = linhaCabecalho + 1; r <= grid.length; r++) {
    const adm = normalizeAdm(cell(r, colAdm))
    if (!adm) continue
    linhas.push({ linha: r, adm, nome: cell(r, colNome) })
  }

  // 4. Conferências que não bloqueiam, mas o operador precisa saber.
  if (seq.length > nDias) {
    for (let d = nDias + 1; d <= seq.length; d++) {
      const col = primeiraCol + d - 1
      const preenchidas = linhas.filter(l => cell(l.linha, col)).length
      avisos.push(
        `[${aba}] Coluna ${colunaA1(col)} ("dia ${d}") não existe em ${MESES[mes - 1]}/${ano} — ignorada` +
        (preenchidas ? `, mas tem ${preenchidas} célula(s) preenchida(s): confira se não foram lançadas no dia errado.` : '.'),
      )
    }
  }

  // Linha dos dias da semana (logo acima do cabeçalho) — só confere.
  const divergentes: string[] = []
  for (let d = 1; d <= nDias; d++) {
    const letra = cell(linhaCabecalho - 1, colunaDoDia.get(d)!).toUpperCase()
    const esperado = LETRA_DIA_SEMANA[diaDaSemana({ ano, mes, dia: d })]!
    if (letra && letra !== esperado) divergentes.push(`dia ${d}: "${letra}" (esperado "${esperado}")`)
  }
  if (divergentes.length) {
    avisos.push(`[${aba}] Letras de dia da semana não batem com o calendário de ${ano}: ${divergentes.slice(0, 5).join(', ')}`)
  }

  const admsVistos = new Map<string, number[]>()
  for (const l of linhas) admsVistos.set(l.adm, [...(admsVistos.get(l.adm) ?? []), l.linha])
  for (const [adm, ls] of admsVistos) {
    if (ls.length > 1) avisos.push(`[${aba}] ADM ${adm} aparece em mais de uma linha (${ls.join(', ')}) — vai para revisão.`)
  }

  return { aba, linhaCabecalho, colAdm, colNome, colunaDoDia, linhas, avisos }
}
