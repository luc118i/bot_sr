// Planilha de frequência em memória + o cenário padrão dos testes. Nomes
// fictícios — o repositório é público.
import fs from 'fs'
import path from 'path'
import type { SheetGateway } from '../../sheets/gateway'
import type { RegrasEditaveis } from '../../regras'
import type { LinhaPontoApi } from '../../ponto/secullum'

export const RAIZ_PROJETO = path.resolve(__dirname, '..', '..', '..')
export const FIXTURE = path.join(RAIZ_PROJETO, 'test', 'fixtures', 'ponto-sintetico.html')
export const htmlFixture = () => fs.readFileSync(FIXTURE, 'utf-8')

/** 28/09/2026 (segunda), 19h — depois do horário de corte do cenário. */
export const NOITE = new Date(2026, 8, 28, 19, 0)

const LETRAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

// Aba de mês no layout observado na cópia real: linha 6 = dias da semana,
// linha 7 = cabeçalho (ADM em C, colaborador em D, dia 1 em G), dados a partir
// da linha 8. `dias` permite montar cabeçalhos quebrados como os de Maio/Julho.
export function gridMes(ano: number, mes: number, linhas: [string, string, Record<number, string>?][], dias?: number[]): string[][] {
  const seq = dias ?? Array.from({ length: 31 }, (_, i) => i + 1)
  const g: string[][] = Array.from({ length: 7 + linhas.length }, () => [])
  g[6]![1] = 'Nº'; g[6]![2] = 'ADM'; g[6]![3] = 'COLABORADOR'; g[6]![4] = 'SETOR'; g[6]![5] = 'Função'
  seq.forEach((d, i) => {
    g[6]![6 + i] = String(d)
    g[5]![6 + i] = LETRAS[new Date(ano, mes - 1, d).getDay()]!
  })
  g[6]![6 + seq.length + 1] = 'FALTA'
  linhas.forEach(([adm, nome, cel], i) => {
    const r = g[7 + i]!
    r[2] = adm; r[3] = nome
    for (const [d, v] of Object.entries(cel ?? {})) r[6 + Number(d) - 1] = v
  })
  return g.map(r => Array.from(r, v => v ?? ''))
}

/** Coluna (1-based) do dia d em gridMes: dia 1 fica em G (7). */
export const colDoDia = (d: number) => 6 + d

export function posA1(c: string): [number, number] {
  const m = /^([A-Z]+)(\d+)$/.exec(c)
  if (!m) throw new Error(`Célula inválida "${c}"`)
  return [+m[2]! - 1, [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1]
}

export class MemoryGateway implements SheetGateway {
  descricao = 'memória'
  escritas: { aba: string; celula: string; valor: string }[] = []
  limpezas: { aba: string; celulas: string[] }[] = []
  leituras = 0
  ocultas: Record<string, Set<number>> = {}
  constructor(public abas: Record<string, string[][]>, private tit = '[SR] - Frequência logística 2026') {}
  async titulo() { return this.tit }
  async listarAbas() { return Object.keys(this.abas) }
  async lerGrid(aba: string) { this.leituras++; return this.abas[aba] ? this.abas[aba]!.map(r => [...r]) : null }
  async lerCelulas(aba: string, celulas: string[]) {
    return celulas.map(c => { const [r, k] = posA1(c); return this.abas[aba]?.[r]?.[k] ?? '' })
  }
  async escrever(aba: string, valores: { celula: string; valor: string }[]) {
    for (const v of valores) {
      this.escritas.push({ aba, ...v })
      const [r, k] = posA1(v.celula)
      const grid = this.abas[aba]!
      while (grid.length <= r) grid.push([])
      grid[r]![k] = v.valor
    }
  }
  async limpar(aba: string, celulas: string[]) {
    this.limpezas.push({ aba, celulas: [...celulas] })
    for (const c of celulas) { const [r, k] = posA1(c); if (this.abas[aba]?.[r]) this.abas[aba]![r]![k] = '' }
  }
  async colunasOcultas(aba: string) { return this.ocultas[aba] ?? new Set<number>() }
}

/** Só as células com conteúdo — "nunca escrita" e "apagada" são a mesma coisa. */
export function preenchidas(gw: MemoryGateway): string[] {
  const out: string[] = []
  for (const [aba, grid] of Object.entries(gw.abas)) {
    grid.forEach((linha, r) => linha.forEach((v, c) => { if (v) out.push(`${aba}!${r + 1},${c + 1}=${v}`) }))
  }
  return out
}

// ── regras locais ───────────────────────────────────────────────────────────

export const caminhoRegrasTeste = () => process.env['REGRAS_PATH']!

export function regrasCenario(): RegrasEditaveis {
  return {
    geral: { tolerancia_min: '5', entrada_padrao: '08:00', horario_corte: '18:00' },
    horarios: [
      { adm: '76', entrada: '07:00', saida: '', tolerancia_min: '', vigencia_inicio: '', vigencia_fim: '2026-09-15', obs: '' },
      { adm: '76', entrada: '07:30', saida: '', tolerancia_min: '10', vigencia_inicio: '2026-09-16', vigencia_fim: '', obs: '' },
    ],
    excecoes: [
      { data: '2026-09-28', adm: '771', entrada_prevista: '10:00', codigo: '', obs: 'avisou' },
      { data: '2026-09-28', adm: '143', entrada_prevista: '', codigo: 'AT', obs: '' },
    ],
    apelidos: [],
  }
}

export function definirRegras(r: RegrasEditaveis) {
  fs.mkdirSync(path.dirname(caminhoRegrasTeste()), { recursive: true })
  fs.writeFileSync(caminhoRegrasTeste(), JSON.stringify(r, null, 2))
}

// ── cenário padrão ──────────────────────────────────────────────────────────

export function cenario() {
  const setembro = gridMes(2026, 9, [
    ['374', 'JOAO EXEMPLO DA SILVA'],                  // linha 8:  07:58 → .
    ['2376', 'PEDRO TESTE DE ARAUJO'],                 // linha 9:  08:05 → . (tolerância inclusiva)
    ['76', 'MARCOS FICTICIO PEREIRA'],                 // linha 10: 08:06, individual 07:30+10 → P
    ['2554', 'PAULO MODELO DA SILVA'],                 // linha 11: sem registro → revisar
    ['1040', 'ANDRE JOSE DE EXEMPLO', { 28: 'FE' }],   // linha 12: férias, já lançado → confere
    ['1417', 'RAIMUNDO DAS NEVES PRADO DOS'],          // linha 13: nome truncado → sugestão
    ['771', 'LUIZ EXCECAO OLIVEIRA', { 28: 'FO' }],    // linha 14: 09:30 c/ exceção 10:00 → '.', célula FO → diverge
    ['147', 'SERGIO ATESTADO QUEIROZ', { 28: 'AT' }],  // linha 15: fora do ponto, lançado à mão
    ['143', 'RENATO FORCADO BUENO'],                   // linha 16: fora do ponto, código forçado AT
    ['1069', 'NELSON AUSENTE CAMPOS'],                 // linha 17: fora do ponto, vazio
  ])
  const outubro = gridMes(2026, 10, [['374', 'JOAO EXEMPLO DA SILVA']])
  const base = [['Nº', 'ADM', 'Colaborador'], ['1', '9999', 'FELIPE SEMLINHA DE FARIA']]
  const gw = new MemoryGateway({ 'BASE DE DADOS': base, Setembro: setembro, Outubro: outubro })
  definirRegras(regrasCenario())
  // Como na planilha real: domingos e o feriado de 7/09 (e 12/10) com a coluna oculta.
  gw.ocultas['Setembro'] = new Set([6, 7, 13, 20, 27].map(colDoDia))
  gw.ocultas['Outubro'] = new Set([4, 11, 12, 18, 25].map(colDoDia))
  return gw
}

/** O fixture é de 28/09; troca a data do id pra simular outros dias. */
export function htmlDoDia(data: string): string {
  return htmlFixture().replace(/dia-resumido-2026-09-28/g, `dia-resumido-${data}`)
}

/** Resposta no formato da API /Batidas/AAAA-MM-DD (os mesmos nomes do fixture). */
export function listaApi(feriado = false): LinhaPontoApi[] {
  const hora = (...h: string[]) => [...h, '', '', '', '', '', ''].slice(0, 6).map(valor => ({ valor }))
  return [
    { funcionarioNome: 'JOAO EXEMPLO DA SILVA', data: '', feriado, batidas: hora('07:58', '12:02'), saldo: '-04:00', situacao: 1 },
    { funcionarioNome: 'PEDRO TESTE DE ARAUJO ', data: '', feriado, batidas: hora('8:05'), saldo: '-08:00', situacao: 2 },
    { funcionarioNome: 'MARCOS FICTICIO PEREIRA', data: '', feriado, batidas: hora('08:06'), saldo: '-08:00', situacao: 2 },
    { funcionarioNome: 'PAULO MODELO DA SILVA', data: '', feriado, batidas: [], saldo: '-08:00', situacao: 2 },
    { funcionarioNome: 'ANDRÉ JOSÉ DE EXEMPLO', data: '', feriado, batidas: Array(6).fill({ valor: 'FÉRIAS' }), saldo: '', situacao: 0 },
    { funcionarioNome: 'OTAVIO SEMENTRADA', data: '', feriado, batidas: hora('', '12:00'), saldo: '-08:00', situacao: 2 },
  ]
}
