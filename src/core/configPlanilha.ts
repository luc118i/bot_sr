import { normalize, normalizeAdm } from './normalize'
import { parseCodigo, type Codigo } from './codigos'
import { parseDataPlanilha, parseHora } from './tempo'

// Regras do bot (padrão, horários individuais, exceções, apelidos). Ficam num
// arquivo LOCAL da máquina (regras.json, editado pela tela "Horários e regras")
// — nunca na planilha de frequência. Aqui elas chegam como tabelas (linha 0 =
// cabeçalho achado pelo nome, linhas 1+ = itens) e viram a config tipada.
// Feriados NÃO ficam aqui: a planilha já os marca escondendo a coluna do dia
// (ver diasNaoUteis em layoutMes.ts).

// Nome de cada seção como aparece na tela — usado nas mensagens.
export const SECOES_CONFIG = {
  geral: 'Padrão',
  horarios: 'Horários individuais',
  excecoes: 'Exceções',
  apelidos: 'Apelidos',
} as const

export const CABECALHOS_CONFIG: Record<keyof typeof SECOES_CONFIG, string[]> = {
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
  item: number // posição na lista da tela (1, 2, 3...) — pras mensagens
}

export interface Excecao {
  data: string
  adm: string
  entradaPrevistaMin: number | null
  codigoForcado: Codigo | null
  item: number
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

function lerTabela(grid: Grid | null): { rows: Record<string, string>[]; itens: number[] } {
  if (!grid || grid.length === 0) return { rows: [], itens: [] }
  const header = (grid[0] ?? []).map(h => normalize(h).replace(/ /g, '_'))
  const rows: Record<string, string>[] = []
  const itens: number[] = []
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] ?? []
    if (r.every(c => !String(c ?? '').trim())) continue
    const obj: Record<string, string> = {}
    header.forEach((h, j) => { if (h) obj[h.toLowerCase()] = String(r[j] ?? '').trim() })
    rows.push(obj)
    itens.push(i)
  }
  return { rows, itens }
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

  // ── Padrão ──
  const geralRow = lerTabela(g.geral).rows[0] ?? {}
  const tol = overrides.toleranciaMin ?? (geralRow['tolerancia_min'] ? Number(geralRow['tolerancia_min']) : NaN)
  const entrada = parseHora(overrides.entradaPadrao ?? geralRow['entrada_padrao'])
  if (!Number.isFinite(tol) || tol < 0) {
    throw new Error(`${SECOES_CONFIG.geral}: tolerância ausente ou inválida (ex.: 5).`)
  }
  if (entrada === null) {
    throw new Error(`${SECOES_CONFIG.geral}: entrada padrão ausente ou inválida (ex.: 08:00).`)
  }
  const corteRaw = geralRow['horario_corte'] ?? ''
  const corte = corteRaw ? parseHora(corteRaw) : null
  if (corteRaw && corte === null) avisos.push(`${SECOES_CONFIG.geral}: horário de corte inválido ("${corteRaw}") — ignorado.`)

  // ── Horários individuais ──
  const horarios: HorarioIndividual[] = []
  const th = lerTabela(g.horarios)
  th.rows.forEach((r, i) => {
    const item = th.itens[i]!
    const adm = normalizeAdm(r['adm'])
    const ent = parseHora(r['entrada'])
    if (!adm || ent === null) {
      avisos.push(`${SECOES_CONFIG.horarios}, item ${item}: colaborador ou entrada inválidos — item ignorado.`)
      return
    }
    const tolInd = r['tolerancia_min'] ? Number(r['tolerancia_min']) : null
    horarios.push({
      adm,
      entradaMin: ent,
      toleranciaMin: tolInd !== null && Number.isFinite(tolInd) ? tolInd : null,
      vigenciaInicio: r['vigencia_inicio'] ? parseDataPlanilha(r['vigencia_inicio']) : null,
      vigenciaFim: r['vigencia_fim'] ? parseDataPlanilha(r['vigencia_fim']) : null,
      item,
    })
  })

  // ── Exceções ──
  const excecoes: Excecao[] = []
  const te = lerTabela(g.excecoes)
  te.rows.forEach((r, i) => {
    const item = te.itens[i]!
    const data = parseDataPlanilha(r['data'] ?? '')
    const adm = normalizeAdm(r['adm'])
    const entradaPrev = r['entrada_prevista'] ? parseHora(r['entrada_prevista']) : null
    const codigo = r['codigo'] ? parseCodigo(r['codigo']) : null
    if (!data || !adm) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: data ou colaborador inválidos — item ignorado.`)
      return
    }
    if (r['codigo'] && !codigo) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: código "${r['codigo']}" não existe na legenda — item ignorado.`)
      return
    }
    if (r['entrada_prevista'] && entradaPrev === null) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: entrada prevista "${r['entrada_prevista']}" inválida — item ignorado.`)
      return
    }
    excecoes.push({ data, adm, entradaPrevistaMin: entradaPrev, codigoForcado: codigo, item })
  })

  // ── Apelidos ──
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
    return { entradaMin: exc.entradaPrevistaMin!, toleranciaMin: tol, origem: `exceção do dia (item ${exc.item})` }
  }
  if (individual) {
    return { entradaMin: individual.entradaMin, toleranciaMin: tol, origem: `horário individual (item ${individual.item})` }
  }
  return { entradaMin: cfg.geral.entradaPadraoMin, toleranciaMin: tol, origem: 'padrão' }
}

export function codigoForcado(cfg: ConfigPlanilha, adm: string, data: string): Excecao | null {
  return cfg.excecoes.find(e => e.adm === adm && e.data === data && e.codigoForcado !== null) ?? null
}
