import { normalize } from './normalize'
import type { PontoIcone, PontoRegistro, PontoStatus } from './pontoParser'
import type { LinhaPontoApi } from '../ponto/secullum'

// Resposta da API do ponto → mesmo PontoRegistro que o leitor de HTML produz,
// pra o resto do bot (match, regras, plano) não saber de onde veio.
// A tela desenha exatamente isto: sem nenhum valor em `batidas` = "Nenhum
// ponto registrado"; valor que não é hora = justificativa (ex.: "FÉRIAS").

const HORA_RE = /^\d{1,2}:\d{2}$/
const ICONE_POR_SITUACAO: Record<number, PontoIcone> = { 0: 'verde', 1: 'amarelo', 2: 'vermelho' }

export function registrosDaApi(lista: LinhaPontoApi[]): { registros: PontoRegistro[]; avisos: string[] } {
  const avisos: string[] = []
  const registros: PontoRegistro[] = []

  for (const l of lista) {
    const nome = String(l.funcionarioNome ?? '').trim()
    if (!nome) {
      avisos.push('Linha do ponto sem nome de colaborador ignorada.')
      continue
    }
    const valores = (l.batidas ?? []).map(b => String(b?.valor ?? '').trim())
    let status: PontoStatus
    let entrada1: string | null = null

    if (valores.every(v => !v)) {
      status = 'sem_registro'
    } else if (valores.some(v => normalize(v) === 'FERIAS')) {
      status = 'ferias'
    } else if (HORA_RE.test(valores[0] ?? '')) {
      status = 'batido'
      const [h, m] = valores[0]!.split(':')
      entrada1 = `${h!.padStart(2, '0')}:${m}`
    } else {
      // Entrada 1 vazia com outra batida, ou justificativa que o bot não
      // traduz sozinho (atestado, folga...) — vai pra revisão.
      status = 'desconhecido'
    }

    registros.push({
      nome,
      icone: l.registroPendente ? 'outro' : ICONE_POR_SITUACAO[l.situacao ?? -1] ?? 'outro',
      status,
      entrada1,
      textos: [nome, ...valores, String(l.saldo ?? '')],
    })
  }

  const vistos = new Map<string, number>()
  for (const r of registros) vistos.set(normalize(r.nome), (vistos.get(normalize(r.nome)) ?? 0) + 1)
  for (const [nome, n] of vistos) if (n > 1) avisos.push(`"${nome}" aparece ${n} vezes no ponto — vai para revisão.`)

  return { registros, avisos }
}

/** O ponto também sabe se o dia é feriado — usado pra conferir com as colunas ocultas. */
export function pontoDizFeriado(lista: LinhaPontoApi[]): boolean {
  return lista.length > 0 && lista.every(l => l.feriado === true)
}
