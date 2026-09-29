import fs from 'fs'
import path from 'path'
import { getConfig } from './config'
import { getRelatoriosDir, logger } from './logger'
import { ABAS_CONFIG, CABECALHOS_CONFIG, parseConfigPlanilha, type OverridesGeral } from './core/configPlanilha'
import { detectarLayout, nomeAbaDoMes } from './core/layoutMes'
import type { BaseColaborador } from './core/matcher'
import { normalize, normalizeAdm } from './core/normalize'
import { montarPlano, type Plano } from './core/planner'
import { parsePontoHtml } from './core/pontoParser'
import { relatorioTexto } from './core/relatorio'
import { parseDataISO } from './core/tempo'
import type { SheetGateway } from './sheets/gateway'
import { GoogleSheetsGateway } from './sheets/googleSheets'
import { XlsxGateway } from './sheets/xlsxGateway'

export interface OpcoesSimulacao {
  data: string
  html: string          // conteúdo do HTML do ponto
  forcar?: boolean
  overrides?: OverridesGeral
  now?: Date
}

export function abrirGateway(xlsx?: string): SheetGateway {
  if (xlsx) return new XlsxGateway(xlsx)
  const cfg = getConfig()
  if (!cfg.spreadsheet_id) throw new Error('ID/link da planilha não configurado.')
  return new GoogleSheetsGateway(cfg.spreadsheet_id, cfg.google_service_account_json_b64)
}

export async function simular(gw: SheetGateway, op: OpcoesSimulacao): Promise<Plano> {
  const d = parseDataISO(op.data)
  logger.info(`[simular] ${op.data} em ${gw.descricao}`)

  // A planilha é de um ano só (uma aba por mês, sem ano no nome da aba).
  const titulo = await gw.titulo()
  const anoTitulo = /\b(20\d{2})\b/.exec(titulo)?.[1]
  if (anoTitulo && +anoTitulo !== d.ano) {
    throw new Error(`A planilha "${titulo}" é de ${anoTitulo}, mas a data pedida é de ${d.ano}.`)
  }

  const abas = await gw.listarAbas()
  const [geral, horarios, excecoes, apelidos, feriados] = await Promise.all(
    Object.values(ABAS_CONFIG).map(a => gw.lerGrid(a)),
  )
  if (!geral && !(op.overrides?.entradaPadrao && op.overrides.toleranciaMin !== undefined)) {
    throw new Error(`Aba ${ABAS_CONFIG.geral} não existe — use "Criar abas de configuração" e preencha tolerância e entrada padrão.`)
  }
  const cfg = parseConfigPlanilha(
    { geral: geral ?? null, horarios: horarios ?? null, excecoes: excecoes ?? null, apelidos: apelidos ?? null, feriados: feriados ?? null },
    op.overrides,
  )

  const aba = nomeAbaDoMes(abas, d.mes)
  const grid = (await gw.lerGrid(aba))!
  const layout = detectarLayout(aba, grid, d.ano, d.mes)
  const base = await lerBase(gw, abas)

  const { registros, avisos: avisosParse } = parsePontoHtml(op.html)
  if (registros.length === 0) {
    throw new Error(`Nenhum colaborador lido do HTML do ponto. ${avisosParse.join(' ')}`)
  }

  const plano = montarPlano({ data: op.data, registros, layout, grid, cfg, base, now: op.now, forcar: op.forcar })
  plano.avisos.unshift(...avisosParse)
  logger.info(`[simular] ${op.data}: ${registros.length} do ponto, resumo ${JSON.stringify(plano.resumo)}`)
  return plano
}

// Nome → ADM da BASE DE DADOS, só pra diferenciar "tem na base mas não tem
// linha no mês" de "não existe". Opcional: se a aba não estiver no formato
// esperado, segue sem ela.
async function lerBase(gw: SheetGateway, abas: string[]): Promise<BaseColaborador[]> {
  const aba = abas.find(a => normalize(a) === 'BASE DE DADOS')
  if (!aba) return []
  const grid = (await gw.lerGrid(aba)) ?? []
  const hdr = (grid[0] ?? []).map(normalize)
  const cAdm = hdr.indexOf('ADM'), cNome = hdr.indexOf('COLABORADOR')
  if (cAdm === -1 || cNome === -1) return []
  return grid.slice(1)
    .map(r => ({ adm: normalizeAdm(r[cAdm]), nome: String(r[cNome] ?? '') }))
    .filter(b => b.adm && b.nome)
}

export interface ResultadoEscrita {
  escritas: { celula: string; codigo: string }[]
  puladas: { celula: string; valorEncontrado: string }[]
}

// Aplica um plano JÁ REVISADO. Relê cada célula imediatamente antes de
// escrever: se alguém preencheu à mão entre a simulação e agora, pula.
export async function executarEscrita(gw: SheetGateway, plano: Plano): Promise<ResultadoEscrita> {
  const celulas = plano.escritas.map(e => e.celula)
  const atuais = await gw.lerCelulas(plano.aba, celulas)
  const escritas: ResultadoEscrita['escritas'] = []
  const puladas: ResultadoEscrita['puladas'] = []
  plano.escritas.forEach((e, i) => {
    const atual = atuais[i] ?? ''
    if (atual.length > 0) puladas.push({ celula: e.celula, valorEncontrado: atual })
    else escritas.push({ celula: e.celula, codigo: e.codigo })
  })
  await gw.escrever(plano.aba, escritas.map(e => ({ celula: e.celula, valor: e.codigo })))
  logger.info(`[escrever] ${plano.data} aba ${plano.aba}: ${escritas.length} escritas, ${puladas.length} puladas (preenchidas nesse meio tempo)`)
  return { escritas, puladas }
}

export async function criarAbasConfig(gw: SheetGateway): Promise<string[]> {
  const abas = await gw.listarAbas()
  const criadas: string[] = []
  for (const [k, nome] of Object.entries(ABAS_CONFIG) as [keyof typeof ABAS_CONFIG, string][]) {
    if (abas.includes(nome)) continue
    await gw.criarAba(nome, CABECALHOS_CONFIG[k])
    criadas.push(nome)
  }
  logger.info(`[config] abas criadas: ${criadas.join(', ') || 'nenhuma'}`)
  return criadas
}

export function salvarRelatorio(plano: Plano, modo: 'simulacao' | 'escrita', extra?: unknown): string {
  const dir = getRelatoriosDir()
  fs.mkdirSync(dir, { recursive: true })
  const ts = plano.geradoEm.replace(/[:.]/g, '-')
  const base = path.join(dir, `${plano.data}_${modo}_${ts}`)
  fs.writeFileSync(`${base}.txt`, relatorioTexto(plano, modo), 'utf-8')
  fs.writeFileSync(`${base}.json`, JSON.stringify({ plano, extra }, null, 2), 'utf-8')
  return `${base}.txt`
}
