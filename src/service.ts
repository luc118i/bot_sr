import fs from 'fs'
import path from 'path'
import { getConfig, tipoConexao, type AgentConfig } from './config'
import { AppsScriptGateway } from './sheets/appsScriptGateway'
import { getRelatoriosDir, logger } from './logger'
import { ABAS_CONFIG, CABECALHOS_CONFIG, parseConfigPlanilha, type OverridesGeral } from './core/configPlanilha'
import { detectarLayout, nomeAbaDoMes } from './core/layoutMes'
import { AntesDoCorteError, DiaNaoUtilError, montarPlano, type Plano } from './core/planner'
import { pontoDizFeriado, registrosDaApi } from './core/pontoApi'
import { parsePontoHtml, type PontoRegistro } from './core/pontoParser'
import { relatorioTexto, type ModoRelatorio } from './core/relatorio'
import { diaDaSemana, hojeISO, parseDataISO, toISO } from './core/tempo'
import { PontoAuthError, type FontePonto } from './ponto/secullum'
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

export interface OpcoesLote {
  htmls: { arquivo: string; html: string }[] // um HTML por dia; a data vem de dentro do HTML
  forcar?: boolean
  overrides?: OverridesGeral
  now?: Date
}

// Conferência de vários dias (ex.: a semana). Cada dia vira um plano próprio;
// um dia com problema não impede os outros — ele só aparece em `erros`.
export interface Lote {
  geradoEm: string
  planos: Plano[]
  pulados: { data: string; arquivo: string; motivo: string }[] // domingos e colunas ocultas (feriados)
  erros: { data: string | null; arquivo: string; motivo: string }[]
}

export function abrirGateway(xlsx?: string): SheetGateway {
  if (xlsx) return new XlsxGateway(xlsx)
  return gatewayDaConfig(getConfig())
}

export function gatewayDaConfig(cfg: AgentConfig): SheetGateway {
  if (tipoConexao(cfg) === 'apps_script') {
    return new AppsScriptGateway(cfg.apps_script_url ?? '', cfg.apps_script_token ?? '')
  }
  if (!cfg.spreadsheet_id) throw new Error('ID/link da planilha não configurado.')
  return new GoogleSheetsGateway(cfg.spreadsheet_id, cfg.google_service_account_json_b64)
}

// A planilha é de um ano só (uma aba por mês, sem ano no nome da aba).
function conferirAno(titulo: string, ano: number): string | null {
  const anoTitulo = /\b(20\d{2})\b/.exec(titulo)?.[1]
  return anoTitulo && +anoTitulo !== ano ? `A planilha "${titulo}" é de ${anoTitulo}, mas a data pedida é de ${ano}.` : null
}

async function carregarConfig(gw: SheetGateway, overrides?: OverridesGeral) {
  const [geral, horarios, excecoes, apelidos] = await Promise.all(Object.values(ABAS_CONFIG).map(a => gw.lerGrid(a)))
  if (!geral && !(overrides?.entradaPadrao && overrides.toleranciaMin !== undefined)) {
    throw new Error(`Aba ${ABAS_CONFIG.geral} não existe — abra "Horários e regras" e preencha entrada padrão, tolerância e horário de corte.`)
  }
  return parseConfigPlanilha(
    { geral: geral ?? null, horarios: horarios ?? null, excecoes: excecoes ?? null, apelidos: apelidos ?? null },
    overrides,
  )
}

// Aba do mês + layout (com as colunas ocultas = dias não úteis).
export async function carregarMes(gw: SheetGateway, abas: string[], ano: number, mes: number) {
  const aba = nomeAbaDoMes(abas, mes)
  const grid = (await gw.lerGrid(aba))!
  const layout = detectarLayout(aba, grid, ano, mes, await gw.colunasOcultas(aba))
  return { grid, layout }
}

// Um dia de ponto já lido — venha do HTML ou da API.
interface DiaDePonto {
  data: string
  arquivo: string            // de onde veio (nome do HTML ou "ponto")
  registros: PontoRegistro[]
  avisos: string[]
  feriadoNoPonto?: boolean   // só a API informa
}

type OpcoesPlanejar = Pick<OpcoesLote, 'forcar' | 'overrides'> & { now: Date }

export async function simularLote(gw: SheetGateway, op: OpcoesLote): Promise<Lote> {
  const now = op.now ?? new Date()
  const lote: Lote = { geradoEm: now.toISOString(), planos: [], pulados: [], erros: [] }

  // Lê cada HTML e descobre de que dia ele é.
  const dias: DiaDePonto[] = []
  for (const { arquivo, html } of op.htmls) {
    const parse = parsePontoHtml(html)
    if (!parse.registros.length) {
      lote.erros.push({ data: null, arquivo, motivo: `Nenhum colaborador lido. ${parse.avisos.join(' ')}` })
    } else if (!parse.data) {
      lote.erros.push({ data: null, arquivo, motivo: `Não deu pra saber de que dia é o HTML. ${parse.avisos.join(' ')}` })
    } else if (dias.some(d => d.data === parse.data)) {
      const outro = dias.find(d => d.data === parse.data)!.arquivo
      lote.erros.push({ data: parse.data, arquivo, motivo: `Dia ${parse.data} repetido (também em "${outro}") — só o primeiro foi usado.` })
    } else {
      dias.push({ data: parse.data, arquivo, registros: parse.registros, avisos: parse.avisos })
    }
  }
  return planejarDias(gw, dias, { ...op, now }, lote)
}

export interface OpcoesPreencher {
  dias?: number              // quantos dias pra trás, contando hoje (padrão 7)
  apenasConferir?: boolean   // true = só a prévia, não grava
  forcar?: boolean
  overrides?: OverridesGeral
  now?: Date
}

export interface ResultadoPreencher {
  lote: Lote
  escrita: { dias: EscritaDoDia[]; erro: string | null } | null
}

// O fluxo de um clique: busca no ponto os últimos N dias, planeja cada um e
// grava direto o que for seguro (as mesmas proteções da prévia: só célula
// vazia, nunca "F", tudo desfazível). Domingos nem são consultados no ponto.
export async function preencherAutomatico(gw: SheetGateway, ponto: FontePonto, op: OpcoesPreencher = {}): Promise<ResultadoPreencher> {
  const now = op.now ?? new Date()
  const lote: Lote = { geradoEm: now.toISOString(), planos: [], pulados: [], erros: [] }
  const datas = ultimosDias(hojeISO(now), op.dias ?? 7)
  logger.info(`[preencher] ${datas[0]} a ${datas.at(-1)} (${op.apenasConferir ? 'só conferir' : 'gravando'}) em ${gw.descricao}`)

  const dias: DiaDePonto[] = []
  for (const data of datas) {
    if (diaDaSemana(parseDataISO(data)) === 0) {
      lote.pulados.push({ data, arquivo: 'ponto', motivo: `${data} é domingo — não se preenche.` })
      continue
    }
    try {
      const lista = await ponto.pontoDiario(data)
      const { registros, avisos } = registrosDaApi(lista)
      if (!registros.length) {
        lote.erros.push({ data, arquivo: 'ponto', motivo: 'O ponto não trouxe nenhum colaborador neste dia.' })
        continue
      }
      dias.push({ data, arquivo: 'ponto', registros, avisos, feriadoNoPonto: pontoDizFeriado(lista) })
    } catch (err: any) {
      // Credencial errada vale pra todos os dias — para tudo com a mensagem clara.
      if (err instanceof PontoAuthError) throw err
      lote.erros.push({ data, arquivo: 'ponto', motivo: err.message })
    }
  }

  await planejarDias(gw, dias, { forcar: op.forcar, overrides: op.overrides, now }, lote)
  if (op.apenasConferir) return { lote, escrita: null }
  return { lote, escrita: await executarEscritaLote(gw, lote.planos) }
}

function ultimosDias(hoje: string, n: number): string[] {
  const { ano, mes, dia } = parseDataISO(hoje)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(ano, mes - 1, dia - (n - 1 - i))
    return toISO({ ano: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() })
  })
}

// Um plano por dia. Configuração e BASE DE DADOS são lidas uma vez só; cada
// mês, uma vez. Um dia com problema não impede os outros.
async function planejarDias(gw: SheetGateway, entrada: DiaDePonto[], op: OpcoesPlanejar, lote: Lote): Promise<Lote> {
  const dias = [...entrada].sort((a, b) => a.data.localeCompare(b.data))
  if (!dias.length) return lote
  logger.info(`[simular] ${dias.map(d => d.data).join(', ')} em ${gw.descricao}`)

  const titulo = await gw.titulo()
  const abas = await gw.listarAbas()
  const cfg = await carregarConfig(gw, op.overrides)
  // BASE DE DADOS só diferencia "tem na base mas sem linha no mês" de "não existe".
  const base = await lerColaboradores(gw, abas)
  const meses = new Map<string, Promise<Awaited<ReturnType<typeof carregarMes>>>>()

  for (const { data, arquivo, registros, avisos, feriadoNoPonto } of dias) {
    try {
      const d = parseDataISO(data)
      const erroAno = conferirAno(titulo, d.ano)
      if (erroAno) throw new Error(erroAno)
      const chave = `${d.ano}-${d.mes}`
      if (!meses.has(chave)) meses.set(chave, carregarMes(gw, abas, d.ano, d.mes))
      const { grid, layout } = await meses.get(chave)!
      const plano = montarPlano({ data, registros, layout, grid, cfg, base, now: op.now, forcar: op.forcar })
      plano.avisos.unshift(...avisos)
      if (feriadoNoPonto) {
        plano.avisos.unshift(`O ponto marca ${data} como feriado, mas a coluna do dia está visível na aba ${layout.aba} — se for feriado, esconda a coluna.`)
      }
      lote.planos.push(plano)
      logger.info(`[simular] ${data}: ${registros.length} do ponto, resumo ${JSON.stringify(plano.resumo)}`)
    } catch (err: any) {
      if (err instanceof DiaNaoUtilError || err instanceof AntesDoCorteError) lote.pulados.push({ data, arquivo, motivo: err.message })
      else lote.erros.push({ data, arquivo, motivo: err.message })
    }
  }
  return lote
}

// Um dia só (CLI e testes). Mesmas regras do lote, mas qualquer problema vira erro.
export async function simular(gw: SheetGateway, op: OpcoesSimulacao): Promise<Plano> {
  const erroAno = conferirAno(await gw.titulo(), parseDataISO(op.data).ano)
  if (erroAno) throw new Error(erroAno)
  // O HTML diz de que dia é — rodar o ponto de um dia na coluna de outro seria
  // um erro silencioso e difícil de perceber na planilha.
  const dataPonto = parsePontoHtml(op.html).data
  if (dataPonto && dataPonto !== op.data) {
    throw new Error(`O HTML do ponto é do dia ${dataPonto}, mas o dia escolhido é ${op.data}.`)
  }
  const lote = await simularLote(gw, { htmls: [{ arquivo: 'ponto', html: op.html }], forcar: op.forcar, overrides: op.overrides, now: op.now })
  const problema = lote.erros[0] ?? lote.pulados[0]
  if (problema) throw new Error(problema.motivo)
  return lote.planos[0]!
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

export interface EscritaDoDia extends ResultadoEscrita { data: string; aba: string; plano: Plano }

// Grava os dias em ordem. Se um falhar (rede, permissão), para ali e devolve os
// que JÁ foram gravados junto com o erro — sem isso o Desfazer não saberia
// quais células apagar dos dias anteriores.
export async function executarEscritaLote(gw: SheetGateway, planos: Plano[]): Promise<{ dias: EscritaDoDia[]; erro: string | null }> {
  const dias: EscritaDoDia[] = []
  for (const plano of planos) {
    if (!plano.escritas.length) continue
    try {
      dias.push({ data: plano.data, aba: plano.aba, plano, ...(await executarEscrita(gw, plano)) })
    } catch (err: any) {
      logger.error(`[escrever] ${plano.data}: ${err.message}`)
      return { dias, erro: `Falhou ao gravar ${plano.data}: ${err.message}. Dias anteriores já gravados: ${dias.map(d => d.data).join(', ') || 'nenhum'}.` }
    }
  }
  return { dias, erro: null }
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
