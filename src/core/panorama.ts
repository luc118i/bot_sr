import type { Plano } from './planner'
import { codigoFinal } from './pontualidade'

// "Como está a equipe hoje?" — o painel da tela inicial. A fonte é o mesmo
// plano que a chamada monta (ponto + planilha + exceções de Horários e regras),
// gerado como prévia: nada é gravado. Assim a folga digitada na planilha, o FE
// do "Lançar férias", o atestado cadastrado como exceção e o "FÉRIAS" do ponto
// aparecem aqui exatamente como a chamada vai tratá-los.

export type SituacaoDia = 'presente' | 'sem_ponto' | 'folga' | 'ferias' | 'atestado' | 'falta' | 'outros' | 'pendente'

const POR_CODIGO: Record<string, SituacaoDia> = {
  '.': 'presente', P: 'presente', GL: 'presente',
  FO: 'folga', FE: 'ferias', AT: 'atestado', AC: 'atestado', F: 'falta', S: 'outros', V: 'outros',
}

export interface PessoaDoDia { nome: string; adm: string | null; situacao: SituacaoDia; codigo: string; entrada: string | null }

export interface PanoramaDia {
  data: string
  aba: string
  total: number                               // sua equipe hoje (quem está no seu ponto + exceções com código)
  contagem: Record<SituacaoDia, number>
  pessoas: PessoaDoDia[]
}

export function panoramaDoPlano(p: Plano): PanoramaDia {
  const pessoas: PessoaDoDia[] = []
  for (const i of p.itens) {
    if (i.situacao === 'ausente_no_ponto') continue // outro setor
    const codigo = codigoFinal(i)
    const situacao: SituacaoDia = POR_CODIGO[codigo]
      ?? (i.situacao === 'revisar' && i.ponto?.status === 'sem_registro' ? 'sem_ponto' : 'pendente')
    pessoas.push({ nome: i.nomePlanilha || i.nomePonto || '?', adm: i.adm, situacao, codigo, entrada: i.ponto?.entrada1 ?? null })
  }
  pessoas.sort((a, b) => a.nome.localeCompare(b.nome))
  const contagem = Object.fromEntries((['presente', 'sem_ponto', 'folga', 'ferias', 'atestado', 'falta', 'outros', 'pendente'] as SituacaoDia[])
    .map(s => [s, pessoas.filter(x => x.situacao === s).length])) as Record<SituacaoDia, number>
  return { data: p.data, aba: p.aba, total: pessoas.length, contagem, pessoas }
}

/** "LUCAS LUIZ DA SILVA" → "Lucas" (pra saudação). */
export function primeiroNome(nome: string | null | undefined): string | null {
  const p = String(nome ?? '').trim().split(/\s+/)[0]
  if (!p || !/[a-zà-ú]/i.test(p)) return null
  return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR')
}
