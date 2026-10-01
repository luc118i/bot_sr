// Datas são sempre ISO local "YYYY-MM-DD" dentro do bot — nunca Date com fuso,
// pra não virar o dia errado perto da meia-noite.

export const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

// Mesma convenção da linha 6 das abas de mês (D S T Q Q S S).
export const LETRA_DIA_SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

export interface DataISO { ano: number; mes: number; dia: number }

export function parseDataISO(s: string): DataISO {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) throw new Error(`Data inválida "${s}" — use o formato AAAA-MM-DD.`)
  const d = { ano: +m[1]!, mes: +m[2]!, dia: +m[3]! }
  if (d.mes < 1 || d.mes > 12 || d.dia < 1 || d.dia > diasNoMes(d.ano, d.mes)) {
    throw new Error(`Data inexistente "${s}".`)
  }
  return d
}

function dataValida(d: DataISO): string | null {
  return d.mes >= 1 && d.mes <= 12 && d.dia >= 1 && d.dia <= diasNoMes(d.ano, d.mes) ? toISO(d) : null
}

export function toISO(d: DataISO): string {
  return `${d.ano}-${String(d.mes).padStart(2, '0')}-${String(d.dia).padStart(2, '0')}`
}

export function hojeISO(now: Date = new Date()): string {
  return toISO({ ano: now.getFullYear(), mes: now.getMonth() + 1, dia: now.getDate() })
}

export function diasNoMes(ano: number, mes: number): number {
  return new Date(ano, mes, 0).getDate()
}

export function diaDaSemana(d: DataISO): number {
  return new Date(d.ano, d.mes - 1, d.dia).getDay()
}

// Aceita o que o Google Sheets devolve formatado em pt-BR ("28/09/2026"), ISO,
// e o número serial do Excel (xlsx). Devolve ISO ou null — também null pra
// data que não existe ("31/02/2026"), em vez de uma ISO inválida que nunca casa.
export function parseDataPlanilha(v: string): string | null {
  const s = v.trim()
  if (!s) return null
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m) return dataValida({ ano: +m[3]!, mes: +m[2]!, dia: +m[1]! })
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return dataValida({ ano: +m[1]!, mes: +m[2]!, dia: +m[3]! })
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const ms = Math.round((Math.floor(+s) - 25569) * 86400 * 1000)
    const d = new Date(ms)
    return toISO({ ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() })
  }
  return null
}

// "8:00", "08:00", "08:00:00" → minutos desde 00:00. Também aceita a fração de
// dia do Excel ("0.3333"). Devolve null se não for horário.
export function parseHora(v: string | null | undefined): number | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s)
  if (m) {
    const h = +m[1]!, min = +m[2]!
    if (h > 23 || min > 59) return null
    return h * 60 + min
  }
  if (/^0?\.\d+$/.test(s)) return Math.round(parseFloat(s) * 24 * 60)
  return null
}

export function formatHora(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

// 1 → A, 27 → AA (coluna 1-based)
export function colunaA1(col: number): string {
  let s = ''
  let n = col
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}
