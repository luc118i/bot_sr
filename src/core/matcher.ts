import { normalize } from './normalize'
import type { Apelido } from './configPlanilha'
import type { LinhaColaborador } from './layoutMes'

// Nome do ponto → linha da aba do mês. O ADM é a chave estável (o nome na aba
// do mês vem por XLOOKUP a partir dele); o ponto só traz nome, então o caminho
// é: CONFIG_APELIDOS (se houver) → nome normalizado na aba do mês.
// Os dois erros já conhecidos:
//   - nome truncado na base ("RAIMUNDO DAS NEVES PRADO DOS") → vira SUGESTÃO
//     de apelido no relatório, nunca match automático;
//   - colaborador ativo na BASE DE DADOS mas sem linha na aba do mês → o
//     relatório diferencia isso de "não existe na base".

export interface BaseColaborador { adm: string; nome: string }

export type ResultadoMatch =
  | { tipo: 'ok'; linha: LinhaColaborador; via: 'nome' | 'apelido' }
  | { tipo: 'ambiguo'; candidatos: LinhaColaborador[] }
  | { tipo: 'sem_linha_no_mes'; adm: string; via: 'base' | 'apelido' }
  | { tipo: 'nao_encontrado'; sugestao: LinhaColaborador | null }

const MIN_PREFIXO = 15

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

  resolver(nomePonto: string): ResultadoMatch {
    const n = normalize(nomePonto)

    const admApelido = this.apelidos.get(n)
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

  // Um nome é prefixo do outro (truncado na base ou no ponto) e só existe um
  // candidato assim. Só aparece no relatório como sugestão pra CONFIG_APELIDOS.
  private sugerir(n: string): LinhaColaborador | null {
    const cands = this.linhas.filter(l => {
      const ln = normalize(l.nome)
      if (!ln) return false
      const menor = ln.length < n.length ? ln : n
      return menor.length >= MIN_PREFIXO && (n.startsWith(ln) || ln.startsWith(n))
    })
    return cands.length === 1 ? cands[0]! : null
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k)
  if (arr) arr.push(v)
  else m.set(k, [v])
}
