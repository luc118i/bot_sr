// Geradores pros testes de propriedade (fuzz). Semente fixa por padrão — uma
// falha sempre se reproduz; FUZZ_SEED troca a semente e FUZZ_RUNS a quantidade.
import type { PontoIcone } from '../../core/pontoParser'

export const SEMENTE = Number(process.env['FUZZ_SEED'] ?? 20260928)
export const RODADAS = Number(process.env['FUZZ_RUNS'] ?? 200)

export type Rng = () => number

/** mulberry32: PRNG pequeno e determinístico. */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1))
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
export const chance = (r: Rng, p: number) => r() < p

/** Roda `fn` RODADAS vezes; a mensagem de erro diz a semente pra reproduzir. */
export function propriedade(nome: string, fn: (r: Rng, i: number) => void | Promise<void>, rodadas = RODADAS) {
  return async () => {
    for (let i = 0; i < rodadas; i++) {
      const seed = SEMENTE + i
      try {
        await fn(rng(seed), i)
      } catch (err: any) {
        err.message = `[${nome}] falhou na rodada ${i} (FUZZ_SEED=${seed} FUZZ_RUNS=1): ${err.message}`
        throw err
      }
    }
  }
}

const SOBRENOMES = ['SILVA', 'SOUZA', 'OLIVEIRA', 'PEREIRA', 'COSTA', 'ARAÚJO', 'GONÇALVES', 'ÁVILA', 'DE', 'DA', 'DOS']
const PRENOMES = ['JOÃO', 'MARIA', 'JOSÉ', 'ANA', 'ÂNDRÉA', 'PEDRO', 'LUCAS', 'ÍTALO', 'CÉSAR', 'MÔNICA']

export function nomeFicticio(r: Rng): string {
  return [pick(r, PRENOMES), ...Array.from({ length: int(r, 1, 4) }, () => pick(r, SOBRENOMES))].join(' ')
}

export function hora(r: Rng): string {
  return `${String(int(r, 5, 11)).padStart(int(r, 1, 2), '0')}:${String(int(r, 0, 59)).padStart(2, '0')}`
}

// ── HTML sintético da tela do ponto (mesma estrutura do fixture real) ──────

export interface LinhaHtml {
  nome: string
  icone?: PontoIcone | 'nenhum'
  celulas?: string[]              // 6 células (Entrada 1 … Saída 3)
  semRegistro?: boolean
  saldo?: string
  data?: string
}

const TESTID: Record<string, string> = { vermelho: 'exclamation-circle', amarelo: 'exclamation-triangle', verde: 'check-circle', outro: 'question-circle' }
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function htmlPonto(data: string, linhas: LinhaHtml[]): string {
  const corpo = linhas.map(l => {
    const icone = l.icone === 'nenhum' ? '' : `<div dir="auto" data-testid="${TESTID[l.icone ?? 'verde']}">&#xf06a;</div>`
    const meio = l.semRegistro
      ? '<div dir="auto">Nenhum ponto registrado</div>'
      : (l.celulas ?? ['', '', '', '', '', '']).map(c => `<div dir="auto">${esc(c)}</div>`).join('')
    return `<div id="dia-resumido-${l.data ?? data}"><div>${icone}<div><div dir="auto">${esc(l.nome)}</div>` +
      `<div style="flex: 6 1 0%;">${meio}</div></div><div dir="auto">${esc(l.saldo ?? '-08:00')}</div></div></div>`
  }).join('\n')
  return `<!DOCTYPE html><html><body>${corpo}</body></html>`
}
