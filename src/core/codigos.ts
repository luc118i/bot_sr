// Legenda da planilha de frequência (colunas AX/AY das abas de mês).
// O bot só ESCREVE '.', 'P' e 'FE' por conta própria; os demais só entram via
// código forçado numa exceção do dia (Horários e regras). 'F' nunca é decidido sozinho.
export const CODIGOS = {
  '.': 'Presença pontual',
  P: 'Presença com atraso',
  F: 'Falta',
  FE: 'Férias',
  FO: 'Folga',
  AT: 'Atestado médico',
  AC: 'Atestado de comparecimento',
  S: 'Suspensão',
  V: 'Viagem',
  GL: 'Ginástica laboral',
} as const

export type Codigo = keyof typeof CODIGOS

export function parseCodigo(raw: string | null | undefined): Codigo | null {
  const s = String(raw ?? '').trim().toUpperCase()
  if (!s) return null
  return (s in CODIGOS ? s : null) as Codigo | null
}
