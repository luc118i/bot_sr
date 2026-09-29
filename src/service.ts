import fs from 'fs'
import path from 'path'
import { getConfig } from './config'
import { getRelatoriosDir, logger } from './logger'
import { ABAS_CONFIG, CABECALHOS_CONFIG, parseConfigPlanilha, type OverridesGeral } from './core/configPlanilha'
import { detectarLayout, nomeAbaDoMes } from './core/layoutMes'
import { montarPlano, type Plano } from './core/planner'
import { parsePontoHtml } from './core/pontoParser'
import { relatorioTexto, type ModoRelatorio } from './core/relatorio'
import { parseDataISO } from './core/tempo'
import { lerColaboradores } from './regras'
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
    throw new Error(`Aba ${ABAS_CONFIG.geral} não existe — abra "Horários e regras" e preencha entrada padrão, tolerância e horário de corte.`)
  }
  const cfg = parseConfigPlanilha(
    { geral: geral ?? null, horarios: horarios ?? null, excecoes: excecoes ?? null, apelidos: apelidos ?? null, feriados: feriados ?? null },
    op.overrides,
  )

  const aba = nomeAbaDoMes(abas, d.mes)
  const grid = (await gw.lerGrid(aba))!
  const layout = detectarLayout(aba, grid, d.ano, d.mes)
  // BASE DE DADOS só diferencia "tem na base mas sem linha no mês" de "não existe".
  const base = await lerColaboradores(gw, abas)

  const { data: dataPonto, registros, avisos: avisosParse } = parsePontoHtml(op.html)
  if (registros.length === 0) {
    throw new Error(`Nenhum colaborador lido do HTML do ponto. ${avisosParse.join(' ')}`)
  }
  // O HTML diz de que dia é — rodar o ponto de um dia na coluna de outro seria
  // um erro silencioso e difícil de perceber na planilha.
  if (!dataPonto) {
    throw new Error(`Não deu pra saber de que dia é o HTML do ponto. ${avisosParse.join(' ')}`)
  }
  if (dataPonto !== op.data) {
    throw new Error(`O HTML do ponto é do dia ${dataPonto}, mas o dia escolhido é ${op.data}.`)
  }

  const plano = montarPlano({ data: op.data, registros, layout, grid, cfg, base, now: op.now, forcar: op.forcar })
  plano.avisos.unshift(...avisosParse)
  logger.info(`[simular] ${op.data}: ${registros.length} do ponto, resumo ${JSON.stringify(plano.resumo)}`)
  return plano
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

export interface ResultadoDesfazer {
  apagadas: string[]
  mantidas: { celula: string; valorEncontrado: string; escritoPeloBot: string }[]
}

// Desfaz UMA escrita do bot: apaga só as células que ainda contêm exatamente o
// código que o bot gravou. Se alguém mudou a célula depois (ex.: trocou "P"
// por "AT"), ela fica como está — o desfazer nunca apaga trabalho de outra
// pessoa. Por isso é mais fino que o Histórico de versões do Google, que
// voltaria a planilha inteira.
export async function desfazerEscrita(gw: SheetGateway, aba: string, escritas: ResultadoEscrita['escritas']): Promise<ResultadoDesfazer> {
  const atuais = await gw.lerCelulas(aba, escritas.map(e => e.celula))
  const apagadas: string[] = []
  const mantidas: ResultadoDesfazer['mantidas'] = []
  escritas.forEach((e, i) => {
    const atual = atuais[i] ?? ''
    if (atual.trim().toUpperCase() === e.codigo.toUpperCase()) apagadas.push(e.celula)
    else mantidas.push({ celula: e.celula, valorEncontrado: atual, escritoPeloBot: e.codigo })
  })
  await gw.limpar(aba, apagadas)
  logger.info(`[desfazer] aba ${aba}: ${apagadas.length} apagadas, ${mantidas.length} mantidas (alteradas depois da escrita)`)
  return { apagadas, mantidas }
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

export function salvarRelatorio(plano: Plano, modo: ModoRelatorio, extra?: ResultadoEscrita | ResultadoDesfazer): string {
  const dir = getRelatoriosDir()
  fs.mkdirSync(dir, { recursive: true })
  const ts = plano.geradoEm.replace(/[:.]/g, '-')
  const base = path.join(dir, `${plano.data}_${modo}_${ts}`)
  fs.writeFileSync(`${base}.txt`, relatorioTexto(plano, modo) + resumoExtra(extra), 'utf-8')
  fs.writeFileSync(`${base}.json`, JSON.stringify({ plano, extra }, null, 2), 'utf-8')
  return `${base}.txt`
}

// Na escrita/desfazer, o que interessa é a lista EXATA de células mexidas.
function resumoExtra(extra?: ResultadoEscrita | ResultadoDesfazer): string {
  if (!extra) return ''
  const out = ['', '']
  if ('escritas' in extra) {
    out.push(`── Gravadas (${extra.escritas.length}) ──`, '  ' + (extra.escritas.map(e => `${e.celula}="${e.codigo}"`).join(', ') || '(nenhuma)'))
    if (extra.puladas.length) {
      out.push(`── Puladas, já preenchidas (${extra.puladas.length}) ──`, '  ' + extra.puladas.map(p => `${p.celula}="${p.valorEncontrado}"`).join(', '))
    }
  } else {
    out.push(`── Apagadas (${extra.apagadas.length}) ──`, '  ' + (extra.apagadas.join(', ') || '(nenhuma)'))
    if (extra.mantidas.length) {
      out.push(`── Mantidas, alteradas depois da escrita (${extra.mantidas.length}) ──`,
        '  ' + extra.mantidas.map(m => `${m.celula}: bot "${m.escritoPeloBot}" → agora "${m.valorEncontrado}"`).join(', '))
    }
  }
  return out.join('\n')
}
