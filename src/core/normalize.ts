// Normalização usada em TODO match de texto (nome do ponto × planilha, nome de
// aba, cabeçalho de coluna). O ponto devolve nomes com espaço sobrando no fim
// ("PEDRO TESTE DE ARAUJO ") e a planilha tem acento ("ÂNDRÉA") — os dois
// lados passam por aqui antes de comparar.
export function normalize(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// ADM vem como número na planilha ("2082") mas pode chegar como "2082.0" (xlsx)
// ou com espaços — sempre comparamos a forma canônica.
export function normalizeAdm(v: string | number | null | undefined): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const n = Number(s.replace(',', '.'))
  return Number.isFinite(n) && Number.isInteger(n) ? String(n) : s
}
