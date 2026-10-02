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
  geral: ['tolerancia_min', 'entrada_padrao', 'horario_corte', 'adiantado_min'],
  horarios: ['adm', 'entrada', 'saida', 'tolerancia_min', 'vigencia_inicio', 'vigencia_fim', 'obs'],
  // recorrente: '' = só na data; 'sempre' = todo dia até ser removida da lista.
  excecoes: ['data', 'adm', 'entrada_prevista', 'codigo', 'obs', 'recorrente'],
  apelidos: ['nome_no_ponto', 'adm', 'obs'],
}

export interface ConfigGeral {
  toleranciaMin: number
  entradaPadraoMin: number
  horarioCorteMin: number | null // antes disso, o bot não classifica o dia de hoje
  // Só pro relatório de pontualidade: entrada antes de (previsto − isto) = adiantado.
  // Não muda nenhum código da planilha (adiantado continua sendo ".").
  adiantadoMin: number
}

export const ADIANTADO_MIN_PADRAO = 15

export interface HorarioIndividual {
  adm: string
  entradaMin: number
  toleranciaMin: number | null
  vigenciaInicio: string | null
  vigenciaFim: string | null
  item: number // posição na lista da tela (1, 2, 3...) — pras mensagens
}

export interface Excecao {
  data: string | null    // null quando é permanente
  sempre: boolean        // vale todo dia até ser removida (ex.: entrada às 9h combinada com o gestor)
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
  const adiRaw = geralRow['adiantado_min'] ?? ''
  let adiantado = adiRaw ? Number(adiRaw) : ADIANTADO_MIN_PADRAO
  if (!Number.isFinite(adiantado) || adiantado < 0) {
    avisos.push(`${SECOES_CONFIG.geral}: "adiantado a partir de" inválido ("${adiRaw}") — usando ${ADIANTADO_MIN_PADRAO} min.`)
    adiantado = ADIANTADO_MIN_PADRAO
  }

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
    // Campo preenchido mas ilegível NUNCA é tratado como vazio: tolerância
    // inválida cairia no padrão, e vigência inválida faria o horário valer pra sempre.
    const tolInd = r['tolerancia_min'] ? Number(r['tolerancia_min']) : null
    if (tolInd !== null && (!Number.isFinite(tolInd) || tolInd < 0)) {
      avisos.push(`${SECOES_CONFIG.horarios}, item ${item}: tolerância "${r['tolerancia_min']}" inválida — item ignorado.`)
      return
    }
    const vigenciaInicio = r['vigencia_inicio'] ? parseDataPlanilha(r['vigencia_inicio']) : null
    const vigenciaFim = r['vigencia_fim'] ? parseDataPlanilha(r['vigencia_fim']) : null
    if ((r['vigencia_inicio'] && !vigenciaInicio) || (r['vigencia_fim'] && !vigenciaFim)) {
      avisos.push(`${SECOES_CONFIG.horarios}, item ${item}: vigência inválida ("${r['vigencia_inicio'] ?? ''}" a "${r['vigencia_fim'] ?? ''}") — item ignorado.`)
      return
    }
    if (vigenciaInicio && vigenciaFim && vigenciaInicio > vigenciaFim) {
      avisos.push(`${SECOES_CONFIG.horarios}, item ${item}: vigência começa (${vigenciaInicio}) depois de terminar (${vigenciaFim}) — item ignorado.`)
      return
    }
    horarios.push({ adm, entradaMin: ent, toleranciaMin: tolInd, vigenciaInicio, vigenciaFim, item })
  })

  // ── Exceções ──
  const excecoes: Excecao[] = []
  const te = lerTabela(g.excecoes)
  te.rows.forEach((r, i) => {
    const item = te.itens[i]!
    const sempre = normalize(r['recorrente']) === 'SEMPRE'
    const data = sempre ? null : parseDataPlanilha(r['data'] ?? '')
    const adm = normalizeAdm(r['adm'])
    const entradaPrev = r['entrada_prevista'] ? parseHora(r['entrada_prevista']) : null
    let codigo = r['codigo'] ? parseCodigo(r['codigo']) : null
    if ((!sempre && !data) || !adm) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: data ou colaborador inválidos — item ignorado.`)
      return
    }
    // "." e "P" dependem do ponto de CADA dia: forçados para sempre, marcariam
    // pontual quem bateu 13:10. Na permanente vale só a entrada prevista.
    let codigoIgnorado = false
    if (sempre && (codigo === '.' || codigo === 'P')) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: exceção permanente não pode forçar "${codigo}" (pontual ou atraso vem do ponto de cada dia) — código ignorado; deixe Código vazio e use só a entrada prevista.`)
      codigo = null
      codigoIgnorado = true
    }
    if (sempre && !r['entrada_prevista'] && !codigo) {
      if (!codigoIgnorado) avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: exceção permanente sem entrada prevista nem código — não muda nada; item ignorado.`)
      return
    }
    if (r['codigo'] && !codigo && !codigoIgnorado) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: código "${r['codigo']}" não existe na legenda — item ignorado.`)
      return
    }
    if (r['entrada_prevista'] && entradaPrev === null) {
      avisos.push(`${SECOES_CONFIG.excecoes}, item ${item}: entrada prevista "${r['entrada_prevista']}" inválida — item ignorado.`)
      return
    }
    excecoes.push({ data, sempre, adm, entradaPrevistaMin: entradaPrev, codigoForcado: codigo, item })
  })

  // ── Apelidos ──
  const apelidos: Apelido[] = []
  for (const r of lerTabela(g.apelidos).rows) {
    const nomePonto = normalize(r['nome_no_ponto'])
    const adm = normalizeAdm(r['adm'])
    if (nomePonto && adm) apelidos.push({ nomePonto, adm })
  }

  return {
    geral: { toleranciaMin: tol, entradaPadraoMin: entrada, horarioCorteMin: corte, adiantadoMin: adiantado },
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

// Exceção que vale para o ADM nesta data: a da própria data ganha da permanente
// (ex.: quem sempre entra às 9h avisou que hoje chega às 10h).
function excecaoDe(cfg: ConfigPlanilha, adm: string, data: string, tem: (e: Excecao) => boolean): Excecao | null {
  const doAdm = cfg.excecoes.filter(e => e.adm === adm && tem(e))
  return doAdm.find(e => e.data === data) ?? doAdm.find(e => e.sempre) ?? null
}

export function descreverExcecao(e: Excecao): string {
  return `${e.sempre ? 'exceção permanente' : 'exceção do dia'} (item ${e.item})`
}

// Ordem: exceção da data → exceção permanente → horário individual vigente → padrão.
export function resolverHorario(cfg: ConfigPlanilha, adm: string, data: string): HorarioPrevisto {
  const vigentes = cfg.horarios
    .filter(h => h.adm === adm
      && (!h.vigenciaInicio || h.vigenciaInicio <= data)
      && (!h.vigenciaFim || data <= h.vigenciaFim))
    .sort((a, b) => (b.vigenciaInicio ?? '').localeCompare(a.vigenciaInicio ?? ''))
  const individual = vigentes[0]

  const exc = excecaoDe(cfg, adm, data, e => e.entradaPrevistaMin !== null)
  const tol = individual?.toleranciaMin ?? cfg.geral.toleranciaMin

  if (exc) {
    return { entradaMin: exc.entradaPrevistaMin!, toleranciaMin: tol, origem: descreverExcecao(exc) }
  }
  if (individual) {
    return { entradaMin: individual.entradaMin, toleranciaMin: tol, origem: `horário individual (item ${individual.item})` }
  }
  return { entradaMin: cfg.geral.entradaPadraoMin, toleranciaMin: tol, origem: 'padrão' }
}

export function codigoForcado(cfg: ConfigPlanilha, adm: string, data: string): Excecao | null {
  return excecaoDe(cfg, adm, data, e => e.codigoForcado !== null)
}
