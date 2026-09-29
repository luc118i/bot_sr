import { normalize, normalizeAdm } from './normalize'
import { parseCodigo, type Codigo } from './codigos'
import { parseDataPlanilha, parseHora } from './tempo'

// Feriados NÃO ficam aqui: a planilha já os marca escondendo a coluna do dia
// (ver diasNaoUteis em layoutMes.ts).
//
// Abas de configuração dentro da própria planilha — editáveis sem mexer em
// código. Linha 1 = cabeçalho (achado pelo nome, a ordem das colunas é livre),
// linha 2+ = dados. Ver criarAbasConfig() pra estrutura inicial.

export const ABAS_CONFIG = {
  geral: 'CONFIG_GERAL',
  horarios: 'CONFIG_HORARIOS',
  excecoes: 'CONFIG_EXCECOES',
  apelidos: 'CONFIG_APELIDOS',
} as const

export const CABECALHOS_CONFIG: Record<keyof typeof ABAS_CONFIG, string[]> = {
  geral: ['tolerancia_min', 'entrada_padrao', 'horario_corte'],
  horarios: ['adm', 'entrada', 'saida', 'tolerancia_min', 'vigencia_inicio', 'vigencia_fim', 'obs'],
  excecoes: ['data', 'adm', 'entrada_prevista', 'codigo', 'obs'],
  apelidos: ['nome_no_ponto', 'adm', 'obs'],
}

export interface ConfigGeral {
  toleranciaMin: number
  entradaPadraoMin: number
  horarioCorteMin: number | null // antes disso, o bot não classifica o dia de hoje
}

export interface HorarioIndividual {
  adm: string
  entradaMin: number
  toleranciaMin: number | null
  vigenciaInicio: string | null
  vigenciaFim: string | null
  linha: number
}

export interface Excecao {
  data: string
  adm: string
  entradaPrevistaMin: number | null
  codigoForcado: Codigo | null
  linha: number
}

export interface Apelido { nomePonto: string; adm: string }

export interface ConfigPlanilha {
  geral: ConfigGeral
  horarios: HorarioIndividual[]
  excecoes: Excecao[]
  apelidos: Apelido[]
  avisos: string[]
}

type Grid = string[][]

function lerTabela(grid: Grid | null): { rows: Record<string, string>[]; linhas: number[] } {
  if (!grid || grid.length === 0) return { rows: [], linhas: [] }
  const header = (grid[0] ?? []).map(h => normalize(h).replace(/ /g, '_'))
  const rows: Record<string, string>[] = []
  const linhas: number[] = []
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? []
    if (r.every(c => !String(c ?? '').trim())) continue
    const obj: Record<string, string> = {}
    header.forEach((h, j) => { if (h) obj[h.toLowerCase()] = String(r[j] ?? '').trim() })
    rows.push(obj)
    linhas.push(i + 1)
  }
  return { rows, linhas }
}

export interface GridsConfig {
  geral: Grid | null
  horarios: Grid | null
  excecoes: Grid | null
  apelidos: Grid | null
}

export interface OverridesGeral {
  toleranciaMin?: number
  entradaPadrao?: string
}

export function parseConfigPlanilha(g: GridsConfig, overrides: OverridesGeral = {}): ConfigPlanilha {
  const avisos: string[] = []

  // ── CONFIG_GERAL ──
  const geralRow = lerTabela(g.geral).rows[0] ?? {}
  const tol = overrides.toleranciaMin ?? (geralRow['tolerancia_min'] ? Number(geralRow['tolerancia_min']) : NaN)
  const entrada = parseHora(overrides.entradaPadrao ?? geralRow['entrada_padrao'])
  if (!Number.isFinite(tol) || tol < 0) {
    throw new Error(`${ABAS_CONFIG.geral}: "tolerancia_min" ausente ou inválida (ex.: 5).`)
  }
  if (entrada === null) {
    throw new Error(`${ABAS_CONFIG.geral}: "entrada_padrao" ausente ou inválida (ex.: 08:00).`)
  }
  const corteRaw = geralRow['horario_corte'] ?? ''
  const corte = corteRaw ? parseHora(corteRaw) : null
  if (corteRaw && corte === null) avisos.push(`${ABAS_CONFIG.geral}: "horario_corte" inválido ("${corteRaw}") — ignorado.`)

  // ── CONFIG_HORARIOS ──
  const horarios: HorarioIndividual[] = []
  const th = lerTabela(g.horarios)
  th.rows.forEach((r, i) => {
    const linha = th.linhas[i]!
    const adm = normalizeAdm(r['adm'])
    const ent = parseHora(r['entrada'])
    if (!adm || ent === null) {
      avisos.push(`${ABAS_CONFIG.horarios} linha ${linha}: ADM ou entrada inválidos — linha ignorada.`)
      return
    }
    const tolInd = r['tolerancia_min'] ? Number(r['tolerancia_min']) : null
    horarios.push({
      adm,
      entradaMin: ent,
      toleranciaMin: tolInd !== null && Number.isFinite(tolInd) ? tolInd : null,
      vigenciaInicio: r['vigencia_inicio'] ? parseDataPlanilha(r['vigencia_inicio']) : null,
      vigenciaFim: r['vigencia_fim'] ? parseDataPlanilha(r['vigencia_fim']) : null,
      linha,
    })
  })

  // ── CONFIG_EXCECOES ──
  const excecoes: Excecao[] = []
  const te = lerTabela(g.excecoes)
  te.rows.forEach((r, i) => {
    const linha = te.linhas[i]!
    const data = parseDataPlanilha(r['data'] ?? '')
    const adm = normalizeAdm(r['adm'])
    const entradaPrev = r['entrada_prevista'] ? parseHora(r['entrada_prevista']) : null
    const codigo = r['codigo'] ? parseCodigo(r['codigo']) : null
    if (!data || !adm) {
      avisos.push(`${ABAS_CONFIG.excecoes} linha ${linha}: data ou ADM inválidos — linha ignorada.`)
      return
    }
    if (r['codigo'] && !codigo) {
      avisos.push(`${ABAS_CONFIG.excecoes} linha ${linha}: código "${r['codigo']}" não existe na legenda — linha ignorada.`)
      return
    }
    if (r['entrada_prevista'] && entradaPrev === null) {
      avisos.push(`${ABAS_CONFIG.excecoes} linha ${linha}: entrada_prevista "${r['entrada_prevista']}" inválida — linha ignorada.`)
      return
    }
    excecoes.push({ data, adm, entradaPrevistaMin: entradaPrev, codigoForcado: codigo, linha })
  })

  // ── CONFIG_APELIDOS ──
  const apelidos: Apelido[] = []
  for (const r of lerTabela(g.apelidos).rows) {
    const nomePonto = normalize(r['nome_no_ponto'])
    const adm = normalizeAdm(r['adm'])
    if (nomePonto && adm) apelidos.push({ nomePonto, adm })
  }

  return {
    geral: { toleranciaMin: tol, entradaPadraoMin: entrada, horarioCorteMin: corte },
    horarios,
    excecoes,
    apelidos,
    avisos,
  }
}

export interface HorarioPrevisto {
  entradaMin: number
  toleranciaMin: number
  origem: string // vai pro relatório: de onde veio o horário usado
}

// Ordem definida no plano: exceção do dia → horário individual vigente → padrão.
export function resolverHorario(cfg: ConfigPlanilha, adm: string, data: string): HorarioPrevisto {
  const vigentes = cfg.horarios
    .filter(h => h.adm === adm
      && (!h.vigenciaInicio || h.vigenciaInicio <= data)
      && (!h.vigenciaFim || data <= h.vigenciaFim))
    .sort((a, b) => (b.vigenciaInicio ?? '').localeCompare(a.vigenciaInicio ?? ''))
  const individual = vigentes[0]

  const exc = cfg.excecoes.find(e => e.adm === adm && e.data === data && e.entradaPrevistaMin !== null)
  const tol = individual?.toleranciaMin ?? cfg.geral.toleranciaMin

  if (exc) {
    return { entradaMin: exc.entradaPrevistaMin!, toleranciaMin: tol, origem: `${ABAS_CONFIG.excecoes} linha ${exc.linha}` }
  }
  if (individual) {
    return { entradaMin: individual.entradaMin, toleranciaMin: tol, origem: `${ABAS_CONFIG.horarios} linha ${individual.linha}` }
  }
  return { entradaMin: cfg.geral.entradaPadraoMin, toleranciaMin: tol, origem: 'padrão' }
}

export function codigoForcado(cfg: ConfigPlanilha, adm: string, data: string): Excecao | null {
  return cfg.excecoes.find(e => e.adm === adm && e.data === data && e.codigoForcado !== null) ?? null
}
