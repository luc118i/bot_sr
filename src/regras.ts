import fs from 'fs'
import path from 'path'
import { getDataDir, logger } from './logger'
import { CABECALHOS_CONFIG, parseConfigPlanilha, type ConfigPlanilha, type GridsConfig, type OverridesGeral } from './core/configPlanilha'
import { detectarLayout, nomeAbaDoMes } from './core/layoutMes'
import { normalize, normalizeAdm } from './core/normalize'
import { hojeISO, MESES, parseDataISO } from './core/tempo'
import type { SheetGateway } from './sheets/gateway'

// Regras do bot (padrão, horários individuais, exceções do dia, apelidos)
// ficam num arquivo LOCAL — regras.json, na mesma pasta dos logs e
// relatórios. A planilha de frequência nunca recebe configuração: dela o bot
// só LÊ a BASE DE DADOS (lista de colaboradores pra tela) e as abas dos meses.
// Formato no arquivo = formato da tela: data "AAAA-MM-DD", hora "HH:MM".

type Linha<K extends keyof typeof CABECALHOS_CONFIG> = Record<(typeof CABECALHOS_CONFIG)[K][number], string>

export interface RegrasEditaveis {
  geral: Linha<'geral'>
  horarios: Linha<'horarios'>[]
  excecoes: Linha<'excecoes'>[]
  apelidos: Linha<'apelidos'>[]
  // Setores de quem usa esta máquina — só filtra a lista de colaboradores na
  // tela (vazio = todos). Não muda nenhuma regra de preenchimento.
  setores?: string[]
}

export interface Colaborador { adm: string; nome: string; setor: string; ativo: boolean }

// ── Arquivo local ───────────────────────────────────────────────────────────

export function caminhoRegras(): string {
  return process.env['REGRAS_PATH'] ?? path.join(getDataDir(), 'regras.json')
}

export function regrasVazias(): RegrasEditaveis {
  return {
    geral: Object.fromEntries(CABECALHOS_CONFIG.geral.map(c => [c, ''])) as Linha<'geral'>,
    horarios: [],
    excecoes: [],
    apelidos: [],
    setores: [],
  }
}

export function lerRegrasLocais(): RegrasEditaveis | null {
  const p = caminhoRegras()
  if (!fs.existsSync(p)) return null
  try {
    const r = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<RegrasEditaveis>
    const vazio = regrasVazias()
    return {
      geral: { ...vazio.geral, ...(r.geral ?? {}) },
      horarios: r.horarios ?? [],
      excecoes: r.excecoes ?? [],
      apelidos: r.apelidos ?? [],
      setores: Array.isArray(r.setores) ? r.setores.filter(s => typeof s === 'string' && s.trim()) : [],
    }
  } catch (err: any) {
    throw new Error(`Não deu pra ler ${p}: ${err.message}`)
  }
}

// Guarda a versão anterior em regras.anterior.json — desfaz um salvamento errado.
function gravarRegrasLocais(r: RegrasEditaveis): void {
  const p = caminhoRegras()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (fs.existsSync(p)) fs.copyFileSync(p, p.replace(/\.json$/, '.anterior.json'))
  fs.writeFileSync(p, JSON.stringify(r, null, 2), 'utf-8')
}

// Regras → tabelas → config tipada (o mesmo parser valida a tela e a simulação).
function gridsDe(r: RegrasEditaveis): GridsConfig {
  const grid = <K extends keyof typeof CABECALHOS_CONFIG>(k: K, linhas: Linha<K>[]) => [
    [...CABECALHOS_CONFIG[k]],
    ...linhas.map(l => CABECALHOS_CONFIG[k].map(c => String((l as Record<string, string>)[c] ?? '').trim())),
  ]
  return {
    geral: grid('geral', [r.geral]),
    horarios: grid('horarios', r.horarios),
    excecoes: grid('excecoes', r.excecoes),
    apelidos: grid('apelidos', r.apelidos),
  }
}

/** Config usada na simulação/preenchimento. */
export function carregarConfigLocal(overrides?: OverridesGeral): ConfigPlanilha {
  const r = lerRegrasLocais()
  if (!r && !(overrides?.entradaPadrao && overrides.toleranciaMin !== undefined)) {
    throw new Error('Regras ainda não configuradas — abra "Horários e regras" e preencha entrada padrão, tolerância e horário de corte.')
  }
  return parseConfigPlanilha(gridsDe(r ?? regrasVazias()), overrides)
}

// ── Tela "Horários e regras" ────────────────────────────────────────────────

// Feriados que o bot enxerga numa aba de mês: dias NÃO domingo com a coluna
// oculta. Só leitura na tela — pra cadastrar um feriado, esconda a coluna.
export interface FeriadosDoMes { aba: string; dias: number[]; erro: string | null }

// A tela abre em dois tempos, pra não esperar o Google:
//   1. regrasDaTela(): arquivo local + a última lista da planilha guardada em
//      disco (planilha-cache.json) — instantâneo;
//   2. dadosDaPlanilha(): colaboradores e feriados frescos, com as leituras em
//      paralelo; atualiza o cache e a tela troca as listas quando chegar.
export interface DadosDaPlanilha { colaboradores: Colaborador[]; feriados: FeriadosDoMes[]; quando: string }

const arqCache = () => path.join(getDataDir(), 'planilha-cache.json')

export function cacheDaPlanilha(): DadosDaPlanilha | null {
  try {
    const c = JSON.parse(fs.readFileSync(arqCache(), 'utf-8')) as DadosDaPlanilha
    return Array.isArray(c.colaboradores) && Array.isArray(c.feriados) ? c : null
  } catch { return null }
}

export function regrasDaTela(): { regras: RegrasEditaveis; arquivo: string; cache: DadosDaPlanilha | null } {
  return { regras: lerRegrasLocais() ?? regrasVazias(), arquivo: caminhoRegras(), cache: cacheDaPlanilha() }
}

export async function dadosDaPlanilha(gw: SheetGateway, hoje: string = hojeISO()): Promise<DadosDaPlanilha> {
  const abas = await gw.listarAbas()
  const [colaboradores, feriados] = await Promise.all([lerColaboradores(gw, abas), lerFeriados(gw, abas, hoje)])
  const dados = { colaboradores, feriados, quando: new Date().toISOString() }
  try {
    fs.mkdirSync(path.dirname(arqCache()), { recursive: true })
    fs.writeFileSync(arqCache(), JSON.stringify(dados), 'utf-8')
  } catch (err: any) { logger.warn(`[regras] não deu pra guardar o cache da planilha: ${err.message}`) }
  return dados
}

// Tudo de uma vez (CLI e testes). Se a planilha não responder, vem sem as listas.
export async function carregarRegras(gw: SheetGateway | null, hoje: string = hojeISO()): Promise<{
  regras: RegrasEditaveis
  arquivo: string
  colaboradores: Colaborador[]
  feriados: FeriadosDoMes[]
  avisos: string[]
}> {
  const { regras, arquivo } = regrasDaTela()
  const avisos: string[] = []
  let colaboradores: Colaborador[] = []
  let feriados: FeriadosDoMes[] = []
  if (gw) {
    try {
      ({ colaboradores, feriados } = await dadosDaPlanilha(gw, hoje))
    } catch (err: any) {
      avisos.push(`Não deu pra ler a planilha (lista de colaboradores e feriados indisponíveis): ${err.message}`)
    }
  }
  return { regras, arquivo, colaboradores, feriados, avisos }
}

// Mês atual e o seguinte — o suficiente pra conferir a semana que vem. As
// leituras (grade e colunas ocultas de cada mês) vão juntas.
async function lerFeriados(gw: SheetGateway, abas: string[], hoje: string): Promise<FeriadosDoMes[]> {
  const { ano, mes } = parseDataISO(hoje)
  const alvos = [{ ano, mes }, mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 }]
  return Promise.all(alvos.map(async (a): Promise<FeriadosDoMes> => {
    let aba = MESES[a.mes - 1]!
    try {
      aba = nomeAbaDoMes(abas, a.mes)
      const [grid, ocultas] = await Promise.all([gw.lerGrid(aba), gw.colunasOcultas(aba)])
      const layout = detectarLayout(aba, grid ?? [], a.ano, a.mes, ocultas)
      const dias = [...layout.diasNaoUteis].filter(([, motivo]) => motivo === 'coluna oculta').map(([d]) => d).sort((x, y) => x - y)
      return { aba, dias, erro: null }
    } catch (err: any) {
      return { aba, dias: [], erro: err.message }
    }
  }))
}

// BASE DE DADOS: ADM, Colaborador, Locação (setor), Status de Atividade.
// Serve de lista de escolha na tela e pra conferir ADMs digitados.
export async function lerColaboradores(gw: SheetGateway, abas?: string[]): Promise<Colaborador[]> {
  const aba = (abas ?? await gw.listarAbas()).find(a => normalize(a) === 'BASE DE DADOS')
  if (!aba) return []
  const grid = (await gw.lerGrid(aba)) ?? []
  const hdr = (grid[0] ?? []).map(normalize)
  const col = (...nomes: string[]) => hdr.findIndex(h => nomes.some(n => h.startsWith(n)))
  const cAdm = col('ADM'), cNome = col('COLABORADOR'), cSetor = col('LOCACAO', 'SETOR'), cStatus = col('STATUS')
  if (cAdm === -1 || cNome === -1) return []
  return grid.slice(1)
    .map(r => ({
      adm: normalizeAdm(r[cAdm]),
      nome: String(r[cNome] ?? '').trim(),
      setor: cSetor === -1 ? '' : String(r[cSetor] ?? '').trim(),
      ativo: cStatus === -1 ? true : normalize(r[cStatus]) === 'ATIVO',
    }))
    .filter(c => c.adm && c.nome)
}

export interface ResultadoValidacao { erros: string[]; avisos: string[] }

export function validarRegras(r: RegrasEditaveis, colaboradores: Colaborador[]): ResultadoValidacao {
  const erros: string[] = []
  const avisos: string[] = []
  try {
    const cfg = parseConfigPlanilha(gridsDe(r))
    // Item ignorado pelo parser = item inválido na tela: bloqueia o salvamento.
    erros.push(...cfg.avisos)

    const porAdm = new Map<string, typeof cfg.horarios>()
    for (const h of cfg.horarios) porAdm.set(h.adm, [...(porAdm.get(h.adm) ?? []), h])
    for (const [adm, hs] of porAdm) {
      for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
        const a = hs[i]!, b = hs[j]!
        const sobrepoe = (a.vigenciaInicio ?? '') <= (b.vigenciaFim ?? '9999') && (b.vigenciaInicio ?? '') <= (a.vigenciaFim ?? '9999')
        if (sobrepoe) erros.push(`ADM ${adm}: dois horários individuais valendo ao mesmo tempo (itens ${a.item} e ${b.item}) — ajuste as vigências.`)
      }
    }

    // Exceções permanentes: no máximo uma entrada e um código por pessoa.
    const permanentes = cfg.excecoes.filter(e => e.sempre)
    for (const [campo, rotulo] of [['entradaPrevistaMin', 'duas entradas previstas permanentes'], ['codigoForcado', 'dois códigos permanentes']] as const) {
      const porAdmExc = new Map<string, number[]>()
      for (const e of permanentes) if (e[campo] !== null) porAdmExc.set(e.adm, [...(porAdmExc.get(e.adm) ?? []), e.item])
      for (const [adm, itens] of porAdmExc) {
        if (itens.length > 1) erros.push(`ADM ${adm}: ${rotulo} (itens ${itens.join(' e ')}) — deixe só um.`)
      }
    }
    for (const e of permanentes) {
      if (e.entradaPrevistaMin !== null && porAdm.has(e.adm)) {
        avisos.push(`ADM ${e.adm}: a exceção permanente (item ${e.item}) vale no lugar do horário individual — se for o mesmo combinado, basta um dos dois.`)
      }
    }
  } catch (err: any) {
    erros.push(err.message)
  }

  if (colaboradores.length) {
    const conhecidos = new Set(colaboradores.map(c => c.adm))
    const adms = [...r.horarios, ...r.excecoes, ...r.apelidos].map(l => normalizeAdm(l.adm)).filter(Boolean)
    for (const adm of new Set(adms)) {
      if (!conhecidos.has(adm)) avisos.push(`ADM ${adm} não existe na BASE DE DADOS.`)
    }
  }
  return { erros, avisos }
}

// Valida e grava no arquivo local. A planilha só é consultada (se der) pra
// avisar de ADM que não existe na BASE DE DADOS.
export async function salvarRegras(r: RegrasEditaveis, gw: SheetGateway | null): Promise<ResultadoValidacao> {
  // A lista que a tela acabou de mostrar (cache) basta pra conferir ADMs — sem nova ida ao Google.
  let colaboradores: Colaborador[] = cacheDaPlanilha()?.colaboradores ?? []
  if (!colaboradores.length && gw) {
    try { colaboradores = await lerColaboradores(gw) } catch { /* sem planilha: salva sem conferir ADMs */ }
  }
  const v = validarRegras(r, colaboradores)
  if (v.erros.length) return v
  gravarRegrasLocais(r)
  logger.info(`[regras] salvas em ${caminhoRegras()}: ${r.horarios.length} horários, ${r.excecoes.length} exceções, ${r.apelidos.length} apelidos`)
  return v
}
