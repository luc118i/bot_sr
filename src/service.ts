import fs from 'fs'
import path from 'path'
import { getConfig, tipoConexao, type AgentConfig } from './config'
import { AppsScriptGateway } from './sheets/appsScriptGateway'
import { getDataDir, getRelatoriosDir, logger } from './logger'
import { CODIGOS, parseCodigo, type Codigo } from './core/codigos'
import type { OverridesGeral } from './core/configPlanilha'
import { detectarLayout, nomeAbaDoMes } from './core/layoutMes'
import { AntesDoCorteError, DiaNaoUtilError, SITUACOES_PENDENTES, contarPendencias, montarPlano, recontarResumo, type Plano } from './core/planner'
import { pontoDizFeriado, registrosDaApi } from './core/pontoApi'
import { parsePontoHtml, type PontoRegistro } from './core/pontoParser'
import { relatorioTexto, type ModoRelatorio } from './core/relatorio'
import { diaDaSemana, hojeISO, parseDataISO, toISO } from './core/tempo'
import { PontoAuthError, type FontePonto } from './ponto/secullum'
import { carregarConfigLocal, lerColaboradores } from './regras'
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

// ── Andamento (barra de progresso da tela) ──────────────────────────────────
// Cada dia passa por fases; a tela mostra uma linha por dia com a fase atual.
//   ponto → planilha → conferido → gravar → pronto   (ou pulado / erro)
export type FaseDia = 'ponto' | 'planilha' | 'conferido' | 'gravar' | 'pronto' | 'pulado' | 'erro'
export type EventoProgresso =
  | { tipo: 'inicio'; datas: string[]; gravando: boolean }
  | { tipo: 'etapa'; texto: string }
  | { tipo: 'dia'; data: string; fase: FaseDia; detalhe?: string }
  | { tipo: 'fim' }
export type OnProgresso = (e: EventoProgresso) => void

export interface OpcoesPreencher {
  datas?: string[]           // dias a processar (padrão: os últimos 7 até hoje)
  apenasConferir?: boolean   // true = simulação, não grava
  forcar?: boolean
  overrides?: OverridesGeral
  now?: Date
  onProgresso?: OnProgresso
}

export interface ResultadoPreencher {
  lote: Lote
  escrita: { dias: EscritaDoDia[]; erro: string | null } | null
}

// O fluxo de um clique: busca no ponto os dias pedidos, confere cada um com a
// planilha e grava direto o que for seguro (as mesmas proteções da prévia: só
// célula vazia, nunca "F", tudo desfazível). Domingos nem são consultados.
export async function preencherAutomatico(gw: SheetGateway, ponto: FontePonto, op: OpcoesPreencher = {}): Promise<ResultadoPreencher> {
  const now = op.now ?? new Date()
  const prog: OnProgresso = op.onProgresso ?? (() => {})
  const lote: Lote = { geradoEm: now.toISOString(), planos: [], pulados: [], erros: [] }
  const hoje = hojeISO(now)
  const datas = [...new Set(op.datas ?? ultimosDias(hoje, 7))].sort()
  logger.info(`[preencher] ${datas.join(', ')} (${op.apenasConferir ? 'simulação' : 'gravando'}) em ${gw.descricao}`)
  prog({ tipo: 'inicio', datas, gravando: !op.apenasConferir })

  const pular = (data: string, motivo: string) => {
    lote.pulados.push({ data, arquivo: 'ponto', motivo })
    prog({ tipo: 'dia', data, fase: 'pulado', detalhe: motivo })
  }
  const falhar = (data: string, motivo: string) => {
    lote.erros.push({ data, arquivo: 'ponto', motivo })
    prog({ tipo: 'dia', data, fase: 'erro', detalhe: motivo })
  }

  // 1. Ponto, dia por dia.
  const dias: DiaDePonto[] = []
  for (const data of datas) {
    if (data > hoje) { falhar(data, 'Data no futuro.'); continue }
    if (diaDaSemana(parseDataISO(data)) === 0) { pular(data, 'Domingo — não se preenche.'); continue }
    prog({ tipo: 'dia', data, fase: 'ponto', detalhe: 'Lendo o ponto...' })
    try {
      const lista = await ponto.pontoDiario(data)
      const { registros, avisos } = registrosDaApi(lista)
      if (!registros.length) { falhar(data, 'O ponto não trouxe nenhum colaborador neste dia.'); continue }
      dias.push({ data, arquivo: 'ponto', registros, avisos, feriadoNoPonto: pontoDizFeriado(lista) })
      prog({ tipo: 'dia', data, fase: 'planilha', detalhe: `${registros.length} colaborador(es) no ponto — aguardando a planilha...` })
    } catch (err: any) {
      // Credencial errada vale pra todos os dias — para tudo com a mensagem clara.
      if (err instanceof PontoAuthError) { prog({ tipo: 'fim' }); throw err }
      falhar(data, err.message)
    }
  }

  // 2. Planilha: confere cada dia.
  await planejarDias(gw, dias, { forcar: op.forcar, overrides: op.overrides, now }, lote, prog)

  // 3. Grava (ou só mostra, na simulação).
  let escrita: ResultadoPreencher['escrita'] = null
  if (op.apenasConferir) {
    for (const p of lote.planos) {
      prog({ tipo: 'dia', data: p.data, fase: 'pronto', detalhe: `Simulação: ${resumoDia(p)}` })
    }
  } else {
    escrita = await executarEscritaLote(gw, lote.planos, prog)
  }
  prog({ tipo: 'fim' })
  return { lote, escrita }
}

function resumoDia(p: Plano): string {
  const partes = [p.escritas.length ? `${p.escritas.length} a preencher` : 'nada a preencher']
  const pend = contarPendencias(p)
  if (pend) partes.push(`${pend} p/ revisão`)
  if (p.resumo.confere) partes.push(`${p.resumo.confere} já conferem`)
  return partes.join(', ')
}

function ultimosDias(hoje: string, n: number): string[] {
  const { ano, mes, dia } = parseDataISO(hoje)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(ano, mes - 1, dia - (n - 1 - i))
    return toISO({ ano: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() })
  })
}

/** Segunda a sábado da semana da data (domingo cai na semana que ele encerra). */
export function semanaDe(data: string): string[] {
  const d = parseDataISO(data)
  const dow = diaDaSemana(d)                // 0 = domingo
  const segunda = new Date(d.ano, d.mes - 1, d.dia - (dow === 0 ? 6 : dow - 1))
  return Array.from({ length: 6 }, (_, i) => {
    const x = new Date(segunda.getFullYear(), segunda.getMonth(), segunda.getDate() + i)
    return toISO({ ano: x.getFullYear(), mes: x.getMonth() + 1, dia: x.getDate() })
  })
}

// Um plano por dia. Configuração e BASE DE DADOS são lidas uma vez só; cada
// mês, uma vez. Um dia com problema não impede os outros.
async function planejarDias(gw: SheetGateway, entrada: DiaDePonto[], op: OpcoesPlanejar, lote: Lote, prog: OnProgresso = () => {}): Promise<Lote> {
  const dias = [...entrada].sort((a, b) => a.data.localeCompare(b.data))
  if (!dias.length) return lote
  logger.info(`[simular] ${dias.map(d => d.data).join(', ')} em ${gw.descricao}`)

  prog({ tipo: 'etapa', texto: 'Lendo a planilha (abas, BASE DE DADOS)...' })
  const titulo = await gw.titulo()
  const abas = await gw.listarAbas()
  // Regras vêm do arquivo local (Horários e regras), nunca da planilha.
  const cfg = carregarConfigLocal(op.overrides)
  // BASE DE DADOS só diferencia "tem na base mas sem linha no mês" de "não existe".
  const base = await lerColaboradores(gw, abas)
  const meses = new Map<string, Promise<Awaited<ReturnType<typeof carregarMes>>>>()

  for (const { data, arquivo, registros, avisos, feriadoNoPonto } of dias) {
    prog({ tipo: 'dia', data, fase: 'planilha', detalhe: 'Conferindo com a planilha...' })
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
      prog({ tipo: 'dia', data, fase: 'conferido', detalhe: `Aba ${plano.aba}, coluna do dia ${d.dia}: ${resumoDia(plano)}` })
      logger.info(`[simular] ${data}: ${registros.length} do ponto, resumo ${JSON.stringify(plano.resumo)}`)
    } catch (err: any) {
      const pulado = err instanceof DiaNaoUtilError || err instanceof AntesDoCorteError
      if (pulado) lote.pulados.push({ data, arquivo, motivo: err.message })
      else lote.erros.push({ data, arquivo, motivo: err.message })
      prog({ tipo: 'dia', data, fase: pulado ? 'pulado' : 'erro', detalhe: err.message })
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

// A conferência "a célula ainda está vazia?" só vale se veio um valor pra CADA
// célula pedida. Uma resposta truncada faria `atuais[i] ?? ''` parecer vazia —
// e o bot sobrescreveria trabalho de alguém. Na dúvida, não mexe em nada.
async function lerParaConferir(gw: SheetGateway, aba: string, celulas: string[]): Promise<string[]> {
  if (!celulas.length) return []
  const atuais = await gw.lerCelulas(aba, celulas)
  if (!Array.isArray(atuais) || atuais.length !== celulas.length || atuais.some(v => typeof v !== 'string')) {
    throw new Error(`A leitura de conferência da aba ${aba} veio incompleta (${Array.isArray(atuais) ? atuais.length : 0} de ${celulas.length} células) — nada foi alterado. Tente de novo.`)
  }
  return atuais
}

// Aplica um plano JÁ REVISADO. Relê cada célula imediatamente antes de
// escrever: se alguém preencheu à mão entre a simulação e agora, pula.
export async function executarEscrita(gw: SheetGateway, plano: Plano): Promise<ResultadoEscrita> {
  const celulas = plano.escritas.map(e => e.celula)
  const atuais = await lerParaConferir(gw, plano.aba, celulas)
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

// Justificativa: o operador decide o código de quem ficou pra revisão (sem
// ponto → AT, FO, F...). Só vale para itens 'revisar' do plano (célula vazia na
// hora da conferência) e segue a mesma regra da escrita: relê a célula e, se
// alguém preencheu nesse meio tempo, pula. É aqui — decisão humana — que 'F' entra.
export async function justificar(gw: SheetGateway, plano: Plano, pedidos: { celula: string; codigo: string }[]): Promise<ResultadoEscrita> {
  const vistas = new Set<string>()
  const validos = pedidos.map(p => {
    const codigo = parseCodigo(p.codigo)
    if (!codigo) throw new Error(`Código "${p.codigo}" não está na legenda da planilha.`)
    const item = p.celula ? plano.itens.find(i => i.celula === p.celula) : undefined
    if (!item || item.situacao !== 'revisar') throw new Error(`A célula ${p.celula} não está entre as pendências de ${plano.data}.`)
    if (vistas.has(p.celula)) throw new Error(`A célula ${p.celula} está repetida no pedido — escolha um código só.`)
    vistas.add(p.celula)
    return { celula: p.celula, codigo }
  })
  const atuais = await lerParaConferir(gw, plano.aba, validos.map(v => v.celula))
  const escritas: ResultadoEscrita['escritas'] = []
  const puladas: ResultadoEscrita['puladas'] = []
  validos.forEach((v, i) => {
    const atual = atuais[i] ?? ''
    if (atual.length > 0) puladas.push({ celula: v.celula, valorEncontrado: atual })
    else escritas.push(v)
  })
  await gw.escrever(plano.aba, escritas.map(e => ({ celula: e.celula, valor: e.codigo })))
  // O plano passa a refletir a planilha (é ele que fica salvo como "último resultado").
  for (const e of escritas) {
    const i = plano.itens.find(i => i.celula === e.celula)!
    i.antes = { situacao: i.situacao, motivo: i.motivo }
    Object.assign(i, { situacao: 'justificado', codigo: e.codigo, valorAtual: e.codigo, motivo: `Justificado por você: ${e.codigo} · ${CODIGOS[e.codigo as Codigo]}` })
  }
  recontarResumo(plano)
  logger.info(`[justificar] ${plano.data} aba ${plano.aba}: ${escritas.map(e => `${e.celula}="${e.codigo}"`).join(', ') || 'nada'}; ${puladas.length} puladas`)
  return { escritas, puladas }
}

// Depois de um Desfazer: o que tinha sido justificado e foi apagado volta a ser pendência.
export function reverterJustificativas(plano: Plano, apagadas: string[]): boolean {
  let mudou = false
  for (const i of plano.itens) {
    if (i.situacao !== 'justificado' || !i.antes || !apagadas.includes(i.celula ?? '')) continue
    Object.assign(i, { situacao: i.antes.situacao, motivo: i.antes.motivo, codigo: null, valorAtual: '' })
    delete i.antes
    mudou = true
  }
  if (mudou) recontarResumo(plano)
  return mudou
}

export interface EscritaDoDia extends ResultadoEscrita { data: string; aba: string; plano: Plano }

// Grava os dias em ordem. Se um falhar (rede, permissão), para ali e devolve os
// que JÁ foram gravados junto com o erro — sem isso o Desfazer não saberia
// quais células apagar dos dias anteriores.
export async function executarEscritaLote(gw: SheetGateway, planos: Plano[], prog: OnProgresso = () => {}): Promise<{ dias: EscritaDoDia[]; erro: string | null }> {
  const dias: EscritaDoDia[] = []
  for (let i = 0; i < planos.length; i++) {
    const plano = planos[i]!
    if (!plano.escritas.length) {
      prog({ tipo: 'dia', data: plano.data, fase: 'pronto', detalhe: resumoDia(plano) })
      continue
    }
    prog({ tipo: 'dia', data: plano.data, fase: 'gravar', detalhe: `Gravando ${plano.escritas.length} célula(s) na aba ${plano.aba}...` })
    try {
      const r = await executarEscrita(gw, plano)
      dias.push({ data: plano.data, aba: plano.aba, plano, ...r })
      const pend = contarPendencias(plano)
      const extra = [
        pend ? `${pend} p/ revisão` : '',
        r.puladas.length ? `${r.puladas.length} já preenchida(s) por alguém` : '',
      ].filter(Boolean).join(', ')
      prog({ tipo: 'dia', data: plano.data, fase: 'pronto', detalhe: `${r.escritas.length} preenchida(s)${extra ? ' · ' + extra : ''}` })
    } catch (err: any) {
      logger.error(`[escrever] ${plano.data}: ${err.message}`)
      prog({ tipo: 'dia', data: plano.data, fase: 'erro', detalhe: `Falhou ao gravar: ${err.message}` })
      for (const resto of planos.slice(i + 1)) {
        prog({ tipo: 'dia', data: resto.data, fase: 'erro', detalhe: 'Não gravado — a gravação parou no dia anterior.' })
      }
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
  const atuais = await lerParaConferir(gw, aba, escritas.map(e => e.celula))
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


// "Atividade recente" da tela inicial: as últimas escritas e desfeitas, lidas
// dos relatórios que o próprio bot salva (um .json por dia gravado/desfeito).
export interface ItemHistorico { tipo: 'escrita' | 'justificativa' | 'desfeita'; data: string; aba: string; celulas: number; quando: string }

export function listarHistorico(limite = 8): ItemHistorico[] {
  const dir = getRelatoriosDir()
  if (!fs.existsSync(dir)) return []
  const arquivos = fs.readdirSync(dir)
    .map(nome => ({ nome, m: /^(\d{4}-\d{2}-\d{2})_(escrita|justificativa|desfeita)_.*\.json$/.exec(nome) }))
    .filter(a => a.m)
    .map(a => ({ ...a, mtime: fs.statSync(path.join(dir, a.nome)).mtimeMs }))
    .sort((x, y) => y.mtime - x.mtime)
    .slice(0, limite)
  const out: ItemHistorico[] = []
  for (const a of arquivos) {
    try {
      const { plano, extra } = JSON.parse(fs.readFileSync(path.join(dir, a.nome), 'utf-8'))
      const tipo = a.m![2] as ItemHistorico['tipo']
      const celulas = tipo !== 'desfeita' ? (extra?.escritas?.length ?? 0) : (extra?.apagadas?.length ?? 0)
      out.push({ tipo, data: a.m![1]!, aba: plano?.aba ?? '', celulas, quando: new Date(a.mtime).toISOString() })
    } catch { /* relatório corrompido: ignora */ }
  }
  return out
}

export function salvarRelatorio(plano: Plano, modo: ModoRelatorio, extra?: ResultadoEscrita | ResultadoDesfazer): string {
  const dir = getRelatoriosDir()
  fs.mkdirSync(dir, { recursive: true })
  // Justificativas do mesmo plano podem ser várias — cada uma no seu arquivo.
  const ts = (modo === 'justificativa' ? new Date().toISOString() : plano.geradoEm).replace(/[:.]/g, '-')
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

// ── Memória entre aberturas do app ──────────────────────────────────────────
// Dois arquivos na pasta de dados (só nesta máquina, como os relatórios):
//   - ultimo-resultado.json: o último lote mostrado na tela (com o que foi
//     justificado depois) — ao reabrir, o resumo e as pendências voltam;
//   - conferencias.json: por dia, quando foi a última conferência GRAVADA e
//     como ficou — é o que responde "já fizemos a chamada de hoje?".
// Simulação atualiza só o último resultado: não conta como dia conferido.

export interface UltimoResultado {
  quando: string
  modo: 'gravado' | 'simulacao'
  lote: Lote
  gravadas: number
}

export interface Conferencia {
  quando: string
  aba: string
  lancados: number   // colaboradores do seu ponto com a célula do dia preenchida
  pendencias: number
  pendentes: string[] // nomes, pra mostrar sem precisar abrir o dia
  feriado?: string    // dia não útil (coluna oculta): não há o que conferir
}

const arqUltimo = () => path.join(getDataDir(), 'ultimo-resultado.json')
const arqConferencias = () => path.join(getDataDir(), 'conferencias.json')

function lerJson<T>(arq: string): T | null {
  try { return fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf-8')) as T : null } catch { return null }
}
function gravarJson(arq: string, v: unknown): void {
  fs.mkdirSync(path.dirname(arq), { recursive: true })
  fs.writeFileSync(arq, JSON.stringify(v), 'utf-8')
}

export function lerUltimoResultado(): UltimoResultado | null {
  return lerJson<UltimoResultado>(arqUltimo())
}

export function salvarUltimoResultado(r: UltimoResultado): void {
  gravarJson(arqUltimo(), r)
}

export function lerConferencias(): Record<string, Conferencia> {
  return lerJson<Record<string, Conferencia>>(arqConferencias()) ?? {}
}

const LANCADOS = new Set(['escrever', 'confere', 'ja_lancado', 'divergente', 'justificado'])

/** Registra (ou atualiza) os dias destes planos como conferidos. `quando`
 *  omitido = mantém a hora da conferência (ex.: depois de uma justificativa). */
export function registrarConferencias(planos: Plano[], quando?: string): void {
  const todas = lerConferencias()
  for (const p of planos) {
    const pendentes = p.itens.filter(i => SITUACOES_PENDENTES.includes(i.situacao)).map(i => i.nomePlanilha || i.nomePonto || '?')
    todas[p.data] = {
      quando: quando ?? todas[p.data]?.quando ?? new Date().toISOString(),
      aba: p.aba,
      lancados: p.itens.filter(i => LANCADOS.has(i.situacao)).length,
      pendencias: pendentes.length,
      pendentes,
    }
  }
  gravarConferencias(todas)
}

// Feriado (coluna oculta) também conta como resolvido — senão ficaria pra sempre "não conferido".
export function registrarFeriados(pulados: Lote['pulados'], quando: string): void {
  const todas = lerConferencias()
  for (const p of pulados) {
    if (/oculta/i.test(p.motivo)) todas[p.data] = { quando, aba: '', lancados: 0, pendencias: 0, pendentes: [], feriado: p.motivo }
  }
  gravarConferencias(todas)
}

function gravarConferencias(todas: Record<string, Conferencia>): void {
  // Guarda só os últimos ~3 meses.
  const corte = toISO((() => { const d = new Date(); d.setDate(d.getDate() - 100); return { ano: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() } })())
  for (const k of Object.keys(todas)) if (k < corte) delete todas[k]
  gravarJson(arqConferencias(), todas)
}
