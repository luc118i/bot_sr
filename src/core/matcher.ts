import { normalize } from './normalize'
import type { Apelido } from './configPlanilha'
import type { LinhaColaborador } from './layoutMes'

// Nome do ponto → linha da aba do mês. O ADM é a chave estável (o nome na aba
// do mês vem por XLOOKUP a partir dele); o ponto só traz nome, então o caminho
// é: apelido → nome igual na aba → BASE DE DADOS → nome PARECIDO (≥ 70%).
//
// "Parecido" compara PALAVRA por palavra, não letra por letra: letra por letra,
// "JOAO SILVA" × "JOAO SOUZA" já dá 70% e o bot gravaria na linha de outra
// pessoa. Por palavras:
//   - ignora partículas (de, da, do, das, dos, e);
//   - uma palavra bate se for igual ou quase (erro de digitação em sobrenome: ≥ 80% das letras);
//   - nota = palavras que batem ÷ palavras do nome mais longo;
//   - o primeiro nome tem que ser IGUAL (MARIA × MARIO são duas pessoas);
//   - só vale se UM candidato passar de 70% (dois → revisão) e se a linha
//     ainda não foi casada exatamente com outra pessoa do ponto.
// Ex.: "FRANCISCO DAS CHAGAS PRADO DOS SANTOS" × "... PRADO DOS" (nome cortado
// na base) = 3 de 4 palavras = 75% → casa.

export interface BaseColaborador { adm: string; nome: string }

export type ResultadoMatch =
  | { tipo: 'ok'; linha: LinhaColaborador; via: 'nome' | 'apelido' | 'parecido'; semelhanca?: number }
  | { tipo: 'ambiguo'; candidatos: LinhaColaborador[] }
  | { tipo: 'sem_linha_no_mes'; adm: string; via: 'base' | 'apelido' }
  | { tipo: 'nao_encontrado'; sugestao: LinhaColaborador | null }

export const LIMIAR_PARECIDO = 0.7
const LIMIAR_PALAVRA = 0.8
const PARTICULAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E'])

function palavras(nome: string): string[] {
  return normalize(nome).replace(/[^A-Z ]/g, ' ').split(' ').filter(p => p && !PARTICULAS.has(p))
}

// Distância de edição em que trocar duas letras vizinhas de lugar conta 1 (PERERIA × PEREIRA).
function distancia(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + custo)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
    }
  }
  return d[a.length]![b.length]!
}

// Erro de digitação só em sobrenome com 5+ letras (SOUZA × SOUSA, PEREIRA × PERERIA).
// Primeiro nome tem que ser IGUAL: MARIA × MARIO, FRANCISCO × FRANCISCA são outras pessoas.
function mesmaPalavra(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 5) return false
  return 1 - distancia(a, b) / Math.max(a.length, b.length) >= LIMIAR_PALAVRA
}

/** 0 a 1: fração de palavras (sem partículas) que batem; 0 se o primeiro nome não for igual. */
export function semelhancaNomes(a: string, b: string): number {
  const pa = palavras(a), pb = palavras(b)
  if (!pa.length || !pb.length || pa[0] !== pb[0]) return 0
  const livres = [...pb]
  let iguais = 0
  for (const p of pa) {
    const k = livres.findIndex(q => mesmaPalavra(p, q))
    if (k !== -1) { iguais++; livres.splice(k, 1) }
  }
  return iguais / Math.max(pa.length, pb.length)
}

/** O único item com nota ≥ limiar; null se nenhum ou mais de um. */
function unicoParecido<T>(nome: string, itens: T[], nomeDe: (t: T) => string): { item: T; nota: number } | null {
  const bons = itens.map(item => ({ item, nota: semelhancaNomes(nome, nomeDe(item)) })).filter(x => x.nota >= LIMIAR_PARECIDO)
  return bons.length === 1 ? bons[0]! : null
}

export class Matcher {
  private porNome = new Map<string, LinhaColaborador[]>()
  private porAdm = new Map<string, LinhaColaborador[]>()
  private apelidos = new Map<string, string>()
  private basePorNome = new Map<string, string[]>()

  constructor(private linhas: LinhaColaborador[], apelidos: Apelido[], base: BaseColaborador[] = []) {
    for (const l of linhas) {
      push(this.porNome, normalize(l.nome), l)
      push(this.porAdm, l.adm, l)
    }
    for (const a of apelidos) this.apelidos.set(a.nomePonto, a.adm)
    for (const b of base) push(this.basePorNome, normalize(b.nome), b.adm)
  }

  /** Caminhos exatos: apelido, nome igual na aba, BASE DE DADOS. */
  resolver(nomePonto: string): ResultadoMatch {
    const n = normalize(nomePonto)

    // Apelido: nome igual, ou parecido (o apelido pode ter sido cadastrado com o
    // nome cortado da planilha em vez do nome completo do ponto).
    const admApelido = this.apelidos.get(n) ?? unicoParecido(n, [...this.apelidos], ([nome]) => nome)?.item[1]
    if (admApelido) {
      const ls = this.porAdm.get(admApelido) ?? []
      if (ls.length === 1) return { tipo: 'ok', linha: ls[0]!, via: 'apelido' }
      if (ls.length > 1) return { tipo: 'ambiguo', candidatos: ls }
      return { tipo: 'sem_linha_no_mes', adm: admApelido, via: 'apelido' }
    }

    const ls = this.porNome.get(n) ?? []
    if (ls.length === 1) {
      // ADM duplicado na aba também é ambíguo — não dá pra saber qual linha.
      const mesmoAdm = this.porAdm.get(ls[0]!.adm) ?? []
      if (mesmoAdm.length > 1) return { tipo: 'ambiguo', candidatos: mesmoAdm }
      return { tipo: 'ok', linha: ls[0]!, via: 'nome' }
    }
    if (ls.length > 1) return { tipo: 'ambiguo', candidatos: ls }

    const admsBase = this.basePorNome.get(n) ?? []
    if (admsBase.length === 1) return { tipo: 'sem_linha_no_mes', adm: admsBase[0]!, via: 'base' }

    return { tipo: 'nao_encontrado', sugestao: this.sugerir(n) }
  }

  /** Último recurso, depois dos exatos de TODO o ponto: nome parecido, fora das linhas já ocupadas. */
  parecido(nomePonto: string, ocupadas: Set<number>): ResultadoMatch | null {
    const livres = this.linhas.filter(l => !ocupadas.has(l.linha) && l.nome)
    const achado = unicoParecido(nomePonto, livres, l => l.nome)
    if (!achado) return null
    const mesmoAdm = this.porAdm.get(achado.item.adm) ?? []
    if (mesmoAdm.length > 1) return { tipo: 'ambiguo', candidatos: mesmoAdm }
    return { tipo: 'ok', linha: achado.item, via: 'parecido', semelhanca: achado.nota }
  }

  // Sem match: o candidato mais parecido (mesmo abaixo do limiar) vira sugestão no relatório.
  private sugerir(n: string): LinhaColaborador | null {
    const notas = this.linhas.map(l => ({ l, nota: semelhancaNomes(n, l.nome) })).filter(x => x.nota >= 0.5).sort((a, b) => b.nota - a.nota)
    return notas.length && (notas.length === 1 || notas[0]!.nota > notas[1]!.nota) ? notas[0]!.l : null
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}
