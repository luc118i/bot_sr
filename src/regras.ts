import { logger } from './logger'
import { ABAS_CONFIG, CABECALHOS_CONFIG, parseConfigPlanilha, type GridsConfig } from './core/configPlanilha'
import { normalize, normalizeAdm } from './core/normalize'
import { formatHora, parseDataPlanilha, parseHora } from './core/tempo'
import type { SheetGateway } from './sheets/gateway'

// Ponte entre a tela "Horários e regras" e as abas CONFIG_* da planilha. A
// planilha continua sendo a fonte da verdade (vale pra qualquer máquina e
// qualquer responsável que rodar o bot); a tela só lê, valida e regrava.
// Formatos na tela: data ISO (input type=date), hora "HH:MM" (type=time).
// Na planilha: data "dd/mm/aaaa" e hora "HH:MM", como texto (legível pra quem
// abrir a aba) — o parser aceita isso e também serial/fração, caso alguém
// digite direto na planilha.

type Linha<K extends keyof typeof CABECALHOS_CONFIG> = Record<(typeof CABECALHOS_CONFIG)[K][number], string>

export interface RegrasEditaveis {
  geral: Linha<'geral'>
  horarios: Linha<'horarios'>[]
  excecoes: Linha<'excecoes'>[]
  apelidos: Linha<'apelidos'>[]
  feriados: Linha<'feriados'>[]
}

export interface Colaborador { adm: string; nome: string; setor: string; ativo: boolean }

const CAMPOS_DATA = new Set(['data', 'vigencia_inicio', 'vigencia_fim'])
const CAMPOS_HORA = new Set(['entrada_padrao', 'horario_corte', 'entrada', 'saida', 'entrada_prevista'])

function paraTela(campo: string, v: string): string {
  if (!v) return ''
  if (CAMPOS_DATA.has(campo)) return parseDataPlanilha(v) ?? v
  if (CAMPOS_HORA.has(campo)) { const m = parseHora(v); return m === null ? v : formatHora(m) }
  if (campo === 'adm') return normalizeAdm(v)
  return v
}

function paraPlanilha(campo: string, v: string): string {
  const s = String(v ?? '').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (CAMPOS_DATA.has(campo) && iso) return `${iso[3]}/${iso[2]}/${iso[1]}`
  if (campo === 'codigo') return s.toUpperCase()
  return s
}

function lerTabela<K extends keyof typeof CABECALHOS_CONFIG>(k: K, grid: string[][] | null): Linha<K>[] {
  const cab = CABECALHOS_CONFIG[k]
  if (!grid || !grid.length) return []
  const header = (grid[0] ?? []).map(h => normalize(h).replace(/ /g, '_').toLowerCase())
  return grid.slice(1)
    .filter(r => r.some(c => String(c ?? '').trim()))
    .map(r => Object.fromEntries(cab.map(c => {
      const j = header.indexOf(c)
      return [c, paraTela(c, j === -1 ? '' : String(r[j] ?? '').trim())]
    })) as Linha<K>)
}

function paraGrid<K extends keyof typeof CABECALHOS_CONFIG>(k: K, linhas: Linha<K>[]): string[][] {
  const cab = CABECALHOS_CONFIG[k]
  const dados = linhas
    .map(l => cab.map(c => paraPlanilha(c, (l as Record<string, string>)[c] ?? '')))
    .filter(r => r.some(Boolean))
  return [[...cab], ...dados]
}

export async function carregarRegras(gw: SheetGateway): Promise<{ regras: RegrasEditaveis; colaboradores: Colaborador[]; abasFaltando: string[] }> {
  const abas = await gw.listarAbas()
  const [geral, horarios, excecoes, apelidos, feriados] = await Promise.all(Object.values(ABAS_CONFIG).map(a => gw.lerGrid(a)))
  const vazioGeral = Object.fromEntries(CABECALHOS_CONFIG.geral.map(c => [c, ''])) as Linha<'geral'>
  return {
    regras: {
      geral: lerTabela('geral', geral ?? null)[0] ?? vazioGeral,
      horarios: lerTabela('horarios', horarios ?? null),
      excecoes: lerTabela('excecoes', excecoes ?? null),
      apelidos: lerTabela('apelidos', apelidos ?? null),
      feriados: lerTabela('feriados', feriados ?? null),
    },
    colaboradores: await lerColaboradores(gw, abas),
    abasFaltando: Object.values(ABAS_CONFIG).filter(a => !abas.includes(a)),
  }
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
  const grids: GridsConfig = {
    geral: paraGrid('geral', [r.geral]),
    horarios: paraGrid('horarios', r.horarios),
    excecoes: paraGrid('excecoes', r.excecoes),
    apelidos: paraGrid('apelidos', r.apelidos),
    feriados: paraGrid('feriados', r.feriados),
  }
  try {
    const cfg = parseConfigPlanilha(grids)
    // Linha ignorada pelo parser = linha inválida na tela: bloqueia o salvamento.
    erros.push(...cfg.avisos)

    const porAdm = new Map<string, typeof cfg.horarios>()
    for (const h of cfg.horarios) porAdm.set(h.adm, [...(porAdm.get(h.adm) ?? []), h])
    for (const [adm, hs] of porAdm) {
      for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
        const a = hs[i]!, b = hs[j]!
        const sobrepoe = (a.vigenciaInicio ?? '') <= (b.vigenciaFim ?? '9999') && (b.vigenciaInicio ?? '') <= (a.vigenciaFim ?? '9999')
        if (sobrepoe) erros.push(`ADM ${adm}: dois horários individuais valendo ao mesmo tempo (linhas ${a.linha} e ${b.linha}) — ajuste as vigências.`)
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

export async function salvarRegras(gw: SheetGateway, r: RegrasEditaveis): Promise<ResultadoValidacao> {
  const v = validarRegras(r, await lerColaboradores(gw))
  if (v.erros.length) return v
  await gw.substituirTabela(ABAS_CONFIG.geral, paraGrid('geral', [r.geral]))
  await gw.substituirTabela(ABAS_CONFIG.horarios, paraGrid('horarios', r.horarios))
  await gw.substituirTabela(ABAS_CONFIG.excecoes, paraGrid('excecoes', r.excecoes))
  await gw.substituirTabela(ABAS_CONFIG.apelidos, paraGrid('apelidos', r.apelidos))
  await gw.substituirTabela(ABAS_CONFIG.feriados, paraGrid('feriados', r.feriados))
  logger.info(`[regras] salvas: ${r.horarios.length} horários, ${r.excecoes.length} exceções, ${r.apelidos.length} apelidos, ${r.feriados.length} feriados`)
  return v
}
