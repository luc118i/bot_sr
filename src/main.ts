import './envSetup'
import { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain, safeStorage } from 'electron'
import path from 'path'
import fs from 'fs'
import { configExiste, configurarCofre, credenciaisPonto, getConfig, getConfigPath, planilhaEmbutida, saveConfig, tipoConexao, type AgentConfig } from './config'
import { hojeISO } from './core/tempo'
import { SecullumClient } from './ponto/secullum'
import { getLogsDir, getRelatoriosDir, logger } from './logger'
import type { Plano } from './core/planner'
import { extrairSpreadsheetId } from './sheets/googleSheets'
import {
  abrirGateway, desfazerEscrita, executarEscritaLote, gatewayDaConfig, gravarFerias, justificar, lerConferencias, lerUltimoResultado, listarHistorico, planejarFerias, preencherAutomatico,
  registrarConferencias, registrarFeriados, reverterJustificativas, salvarRelatorio, salvarUltimoResultado, semanaDe,
  type EscritaDoDia, type Lote, type ResultadoDesfazer, type ResultadoEscrita,
} from './service'
import { consultarPontualidade, registrarPontualidade } from './pontualidade'
import { csvPontualidade, type FiltrosPontualidade } from './core/pontualidade'
import { dadosDaPlanilha, lerRegrasLocais, regrasDaTela, salvarRegras, type RegrasEditaveis } from './regras'
import type { SheetGateway } from './sheets/gateway'

let tray: Tray | null = null
let appWin: BrowserWindow | null = null

// Última simulação (1 ou vários dias) na janela principal. "Escrever" só grava
// ESTES planos — o operador aprova exatamente o que viu, nunca uma nova leitura.
let ultimoLote: Lote | null = null
const VALIDADE_PLANO_MS = 60 * 60 * 1000

// Dias gravados na última escrita desta janela — alvo do "Desfazer esta
// escrita". Escritas mais antigas (ou de antes de reabrir o app) são desfeitas
// pelo relatório .json de cada dia, salvo em relatorios/.
let ultimaEscrita: EscritaDoDia[] | null = null

// Última prévia de férias. "Gravar férias" grava ESTES planos (o que o
// operador viu), desde que seja o mesmo colaborador e período e tenha < 1 h.
let ultimasFerias: { chave: string; geradoEm: number; planos: Plano[] } | null = null


// Planos do último resultado mostrado na tela (gravado ou simulado). A
// justificativa só aceita células que estavam pendentes NESTES planos.
let planosNaTela = new Map<string, Plano>()
let loteNaTela: Lote | null = null
let modoNaTela: 'gravado' | 'simulacao' = 'simulacao'
let gravadasNaTela = 0
function mostrarNaTela(lote: Lote, modo: 'gravado' | 'simulacao', gravadas = 0, quando = new Date().toISOString()): void {
  loteNaTela = lote
  modoNaTela = modo
  gravadasNaTela = gravadas
  planosNaTela = new Map(lote.planos.map(p => [p.data, p]))
  salvarUltimoResultado({ quando, modo, lote, gravadas })
  guardarPontualidade(lote.planos)
}
// Histórico do relatório de pontualidade — falhar aqui nunca atrapalha o preenchimento.
function guardarPontualidade(planos: Plano[]): void {
  try { registrarPontualidade(planos) } catch (err: any) { logger.warn(`[pontualidade] não deu pra guardar o histórico: ${err.message}`) }
}
// Justificar/desfazer mudam os planos já na tela: regrava o último resultado e,
// se o dia já estava registrado como conferido, atualiza as pendências dele.
function planosMudaram(planos: Plano[]): void {
  if (!loteNaTela) return
  const ultimo = lerUltimoResultado()
  salvarUltimoResultado({ quando: ultimo?.quando ?? new Date().toISOString(), modo: modoNaTela, lote: loteNaTela, gravadas: gravadasNaTela })
  const conferidos = lerConferencias()
  registrarConferencias(planos.filter(p => conferidos[p.data]))
  guardarPontualidade(planos)
}
// Dias que a gravação de fato concluiu (se parou no meio, só os anteriores à falha).
function registrarGravacao(lote: Lote, escrita: { dias: EscritaDoDia[]; erro: string | null }): number {
  const planos = lote.planos
  const quando = new Date().toISOString()
  registrarFeriados(lote.pulados, quando)
  const gravados = new Set(escrita.dias.map(d => d.data))
  const falhou = escrita.erro ? planos.find(p => p.escritas.length && !gravados.has(p.data))?.data : undefined
  const ok = falhou ? planos.filter(p => p.data < falhou) : planos
  registrarConferencias(ok, quando)
  return escrita.dias.reduce((n, d) => n + d.escritas.length, 0)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

function rendererPath(file: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', file)
    : path.join(app.getAppPath(), 'src', 'renderer', file)
}

function preloadPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'preload.js')
    : path.join(app.getAppPath(), 'dist', 'preload.js')
}

function buildTrayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray.png')
    : path.join(app.getAppPath(), 'build', 'tray.png')
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath)
  return nativeImage.createEmpty()
}

function buildContextMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: 'Frequência Agent', enabled: false },
    { type: 'separator' },
    { label: 'Preencher frequência...', click: () => openAppWindow() },
    { type: 'separator' },
    { label: 'Horários e regras', click: () => openRegrasWindow() },
    { label: 'Configurações', click: () => openConfigWindow() },
    { label: 'Ver relatórios', click: () => shell.openPath(ensureDir(getRelatoriosDir())) },
    { label: 'Ver logs', click: () => shell.openPath(ensureDir(getLogsDir())) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ])
}

function ensureDir(d: string): string {
  fs.mkdirSync(d, { recursive: true })
  return d
}

// Uma janela só, maximizada: Início, Horários e regras, Relatórios e Configurações são
// telas que se revezam dentro dela (o estado do Início fica aqui no processo
// principal e volta quando a tela reabre).
type Tela = 'app.html' | 'regras.html' | 'config.html' | 'relatorios.html'

function criarJanela(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    show: false,
    backgroundColor: '#F4F4F2',
    title: 'SR_dados',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  w.once('ready-to-show', () => { w.maximize(); w.show() })
  // Tela com alterações não salvas pede pra ficar (beforeunload): pergunta antes de trocar.
  w.webContents.on('will-prevent-unload', ev => {
    const r = dialog.showMessageBoxSync(w, {
      type: 'question', buttons: ['Sair sem salvar', 'Continuar editando'], defaultId: 1, cancelId: 1,
      title: 'Alterações não salvas', message: 'Há alterações não salvas nesta tela.', detail: 'Se sair agora, elas serão perdidas.',
    })
    if (r === 0) ev.preventDefault()
  })
  w.on('closed', () => { appWin = null; ultimoLote = null; ultimaEscrita = null; ultimasFerias = null; planosNaTela = new Map(); loteNaTela = null })
  return w
}

function mostrarTela(tela: Tela): void {
  if (!appWin || appWin.isDestroyed()) appWin = criarJanela()
  else {
    if (appWin.isMinimized()) appWin.restore()
    appWin.show()
    appWin.focus()
  }
  if (!appWin.webContents.getURL().endsWith(`/${tela}`)) appWin.loadFile(rendererPath(tela))
}

const openAppWindow = () => mostrarTela('app.html')
const openRegrasWindow = () => mostrarTela('regras.html')
const openConfigWindow = () => mostrarTela('config.html')
const openRelatoriosWindow = () => mostrarTela('relatorios.html')

// Planilha se estiver configurada; null se ainda não (tela de regras funciona sem).
function gatewayOpcional(): SheetGateway | null {
  try { return abrirGateway() } catch { return null }
}

function registerIPC(): void {
  // Já com os segredos decifrados — a tela de Configurações mostra/edita. A
  // planilha que veio no instalador (link + token) NUNCA vai pra tela.
  ipcMain.handle('get-config', () => {
    if (!configExiste()) return null
    let cfg: AgentConfig
    try { cfg = getConfig() } catch { return null }
    if (!planilhaEmbutida()) return cfg
    const { apps_script_url: _u, apps_script_token: _t, ...semPlanilha } = cfg
    return { ...semPlanilha, planilhaEmbutida: true }
  })

  ipcMain.handle('testar-ponto', async (_e, cfg: AgentConfig) => {
    try {
      return { ok: true, message: await new SecullumClient(credenciaisPonto(cfg)).testar(hojeISO()) }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  // O fluxo de um clique: o dia escolhido no calendário, ou a semana dele
  // (segunda a sábado, só até hoje). O andamento vai pra tela a cada fase de
  // cada dia (evento 'progresso'). Com apenasConferir, só monta a prévia —
  // "Gravar agora" aplica essa prévia pelo mesmo caminho do 'escrever'.
  ipcMain.handle('preencher', async (e, params: { data: string; modo: 'dia' | 'semana'; apenasConferir?: boolean; forcar?: boolean }) => {
    ultimoLote = null
    try {
      const hoje = hojeISO()
      if (!params.data || params.data > hoje) throw new Error('Escolha no calendário uma data de hoje ou anterior.')
      const datas = params.modo === 'semana' ? semanaDe(params.data).filter(d => d <= hoje) : [params.data]
      const cfg = getConfig()
      const r = await preencherAutomatico(abrirGateway(), new SecullumClient(credenciaisPonto(cfg)), {
        datas,
        apenasConferir: !!params.apenasConferir,
        forcar: !!params.forcar,
        onProgresso: ev => { if (!e.sender.isDestroyed()) e.sender.send('progresso', ev) },
      })
      if (r.escrita) {
        mostrarNaTela(r.lote, 'gravado', registrarGravacao(r.lote, r.escrita))
        for (const d of r.escrita.dias) salvarRelatorio(d.plano, 'escrita', { escritas: d.escritas, puladas: d.puladas })
        ultimaEscrita = r.escrita.dias.some(d => d.escritas.length) ? r.escrita.dias : null
      } else {
        for (const plano of r.lote.planos) salvarRelatorio(plano, 'simulacao')
        mostrarNaTela(r.lote, 'simulacao')
        ultimoLote = r.lote
      }
      return {
        ok: true,
        lote: r.lote,
        escrita: r.escrita && {
          erro: r.escrita.erro,
          dias: r.escrita.dias.map(d => ({ data: d.data, aba: d.aba, escritas: d.escritas, puladas: d.puladas })),
        },
      }
    } catch (err: any) {
      logger.error('[preencher]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('save-config', (_e, cfg: AgentConfig) => saveConfig(cfg))

  ipcMain.handle('pick-json-file', async () => {
    const result = await dialog.showOpenDialog(appWin!, {
      title: 'Selecionar Service Account JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8')
    let email = ''
    try { email = JSON.parse(raw).client_email ?? '' } catch { /* validado no teste de conexão */ }
    return { b64: Buffer.from(raw).toString('base64'), name: path.basename(result.filePaths[0]), email }
  })

  ipcMain.handle('test-connection', async (_e, cfg: AgentConfig) => {
    try {
      // A tela não conhece a planilha embutida — o teste usa a do instalador.
      const gw = gatewayDaConfig({ ...cfg, spreadsheet_id: extrairSpreadsheetId(cfg.spreadsheet_id ?? ''), ...(planilhaEmbutida() ? { conexao: 'apps_script' as const, ...planilhaEmbutida() } : {}) })
      const titulo = await gw.titulo()
      const abas = await gw.listarAbas()
      return { ok: true, message: `Conectado a "${titulo}" (${abas.length} abas).` }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })


  // (Conferir a partir de HTML salvo do ponto saiu do app — continua na CLI: node dist/cli.js simular --html.)

  ipcMain.handle('escrever', async () => {
    const lote = ultimoLote
    if (!lote) return { ok: false, message: 'Rode a simulação antes de escrever.' }
    if (Date.now() - new Date(lote.geradoEm).getTime() > VALIDADE_PLANO_MS) {
      return { ok: false, message: 'A simulação tem mais de 1 hora — simule de novo antes de escrever.' }
    }
    // Config inválida (ex.: salva entre a simulação e agora) não pode virar uma
    // promessa rejeitada — a tela ficaria presa em "Trabalhando…". Nada foi
    // gravado ainda, então a simulação continua valendo pra tentar de novo.
    let gw: SheetGateway
    try { gw = abrirGateway() } catch (err: any) {
      logger.error('[escrever]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
    ultimoLote = null // uma simulação só é aplicada uma vez
    const { dias, erro } = await executarEscritaLote(gw, lote.planos)
    try {
      for (const d of dias) salvarRelatorio(d.plano, 'escrita', { escritas: d.escritas, puladas: d.puladas })
      mostrarNaTela(lote, 'gravado', registrarGravacao(lote, { dias, erro }))
    } catch (err: any) {
      logger.error('[escrever] relatório/memória:', err.message) // a planilha já foi gravada; o Desfazer abaixo continua valendo
    }
    // Mesmo com erro no meio, os dias já gravados ficam disponíveis pro Desfazer.
    ultimaEscrita = dias.some(d => d.escritas.length) ? dias : null
    return {
      ok: !erro,
      message: erro,
      dias: dias.map(d => ({ data: d.data, aba: d.aba, escritas: d.escritas, puladas: d.puladas })),
    }
  })

  // Justificar pendências (ex.: sem ponto → AT). Grava na hora, só em célula
  // ainda vazia, e vira a "última escrita" — o Desfazer do aviso apaga de volta.
  ipcMain.handle('justificar', async (_e, params: { data: string; itens: { celula: string; codigo: string }[] }) => {
    const plano = planosNaTela.get(params.data)
    if (!plano) return { ok: false, message: 'Esse dia não está mais na tela — confira o dia de novo antes de justificar.' }
    try {
      const r = await justificar(abrirGateway(), plano, params.itens)
      salvarRelatorio(plano, 'justificativa', r)
      planosMudaram([plano])
      if (r.escritas.length) ultimaEscrita = [{ data: plano.data, aba: plano.aba, plano, ...r }]
      return { ok: true, ...r }
    } catch (err: any) {
      logger.error('[justificar]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  // Férias: prévia (gravar=false) ou gravação do que a prévia mostrou.
  ipcMain.handle('ferias', async (_e, params: { adm: string; inicio: string; fim: string; gravar?: boolean }) => {
    const chave = `${params.adm}|${params.inicio}|${params.fim}`
    try {
      const gw = abrirGateway()
      if (!params.gravar) {
        const planos = await planejarFerias(gw, params.adm, { inicio: params.inicio, fim: params.fim })
        ultimasFerias = { chave, geradoEm: Date.now(), planos }
        return { ok: true, planos }
      }
      const previa = ultimasFerias
      if (!previa || previa.chave !== chave || Date.now() - previa.geradoEm > VALIDADE_PLANO_MS) {
        return { ok: false, message: 'Veja a prévia das férias de novo antes de gravar.' }
      }
      ultimasFerias = null // uma prévia só é gravada uma vez
      const { dias, erro } = await gravarFerias(gw, previa.planos)
      try {
        for (const d of dias) salvarRelatorio(d.plano, 'ferias', { escritas: d.escritas, puladas: d.puladas })
      } catch (err: any) {
        logger.error('[ferias] relatório:', err.message) // a planilha já foi gravada; o Desfazer continua valendo
      }
      if (dias.some(d => d.escritas.length)) ultimaEscrita = dias
      return { ok: !erro, message: erro, dias: dias.map(d => ({ data: d.data, aba: d.aba, escritas: d.escritas, puladas: d.puladas })) }
    } catch (err: any) {
      logger.error('[ferias]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('desfazer', async () => {
    const alvo = ultimaEscrita
    if (!alvo) return { ok: false, message: 'Nenhuma escrita desta sessão para desfazer.' }
    const dias: ({ data: string; aba: string } & ResultadoDesfazer)[] = []
    try {
      const gw = abrirGateway()
      for (const d of alvo) {
        const r = await desfazerEscrita(gw, d.aba, d.escritas)
        salvarRelatorio(d.plano, 'desfeita', r)
        dias.push({ data: d.data, aba: d.aba, ...r })
        const naTela = planosNaTela.get(d.data)
        if (naTela && reverterJustificativas(naTela, r.apagadas)) planosMudaram([naTela])
      }
      ultimaEscrita = null
      return { ok: true, dias }
    } catch (err: any) {
      logger.error('[desfazer]', err.message)
      // Tira da lista o que já foi desfeito, pra tentar de novo só o resto.
      ultimaEscrita = alvo.filter(d => !dias.some(x => x.data === d.data))
      return { ok: false, message: err.message ?? 'Erro desconhecido', dias }
    }
  })

  // Desfaz escritas antigas a partir dos .json que cada escrita salvou (um
  // por dia — pra desfazer uma semana, selecione os arquivos dos dias).
  ipcMain.handle('desfazer-de-relatorio', async () => {
    const result = await dialog.showOpenDialog(appWin!, {
      title: 'Escolha o(s) relatório(s) de escrita a desfazer',
      defaultPath: ensureDir(getRelatoriosDir()),
      filters: [{ name: 'Relatório de escrita', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelado: true }
    const dias: ({ data: string; aba: string } & ResultadoDesfazer)[] = []
    try {
      const alvos = result.filePaths.map(arq => {
        const { plano, extra } = JSON.parse(fs.readFileSync(arq, 'utf-8')) as { plano: Plano; extra?: ResultadoEscrita }
        if (!/_(escrita|justificativa|ferias)_/.test(path.basename(arq)) || !extra?.escritas) {
          throw new Error(`"${path.basename(arq)}" não é o relatório de uma escrita (nome "..._escrita_....json").`)
        }
        return { plano, escritas: extra.escritas }
      })
      const detalhe = alvos.map(a => `${a.plano.data} (${a.plano.aba}): ${a.escritas.map(e => `${e.celula}="${e.codigo}"`).join(', ') || 'nenhuma célula'}`).join('\n')
      const { response } = await dialog.showMessageBox(appWin!, {
        type: 'warning',
        buttons: ['Desfazer', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: 'Desfazer escrita',
        message: `Desfazer ${alvos.length === 1 ? 'a escrita de ' + alvos[0]!.plano.data : alvos.length + ' escritas'}?`,
        detail: `${detalhe}\n\nSó serão apagadas as células que ainda tiverem exatamente o código gravado pelo bot.`,
      })
      if (response !== 0) return { ok: false, cancelado: true }
      const gw = abrirGateway()
      for (const a of alvos) {
        const r = await desfazerEscrita(gw, a.plano.aba, a.escritas)
        salvarRelatorio(a.plano, 'desfeita', r)
        dias.push({ data: a.plano.data, aba: a.plano.aba, ...r })
      }
      return { ok: true, dias }
    } catch (err: any) {
      logger.error('[desfazer]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido', dias }
    }
  })

  ipcMain.handle('abrir-pasta-relatorios', () => shell.openPath(ensureDir(getRelatoriosDir())))
  ipcMain.handle('abrir-relatorios', () => openRelatoriosWindow())

  // Relatório de pontualidade: lê o histórico local (pontualidade.json) — sem
  // ir à rede, então cada mudança de filtro responde na hora.
  ipcMain.handle('pontualidade', (_e, filtros: FiltrosPontualidade) => {
    try {
      return { ok: true, ...consultarPontualidade(filtros ?? {}) }
    } catch (err: any) {
      logger.error('[pontualidade]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  // Exporta o que está filtrado na tela (o filtro é refeito aqui — a tela só manda os critérios).
  ipcMain.handle('pontualidade-exportar', async (_e, filtros: FiltrosPontualidade) => {
    try {
      const r = consultarPontualidade(filtros ?? {})
      if (!r.registros.length) return { ok: false, message: 'Nada para exportar com esses filtros.' }
      const sufixo = [filtros?.inicio, filtros?.fim].filter(Boolean).join('_a_') || 'tudo'
      const res = await dialog.showSaveDialog(appWin!, {
        title: 'Exportar relatório de pontualidade',
        defaultPath: path.join(app.getPath('documents'), `pontualidade_${sufixo}.csv`),
        filters: [{ name: 'Planilha (CSV)', extensions: ['csv'] }],
      })
      if (res.canceled || !res.filePath) return { ok: false, cancelado: true }
      fs.writeFileSync(res.filePath, csvPontualidade(r.registros), 'utf-8')
      return { ok: true, arquivo: res.filePath, linhas: r.registros.length }
    } catch (err: any) {
      logger.error('[pontualidade] exportar:', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })
  ipcMain.handle('mostrar-arquivo', (_e, arquivo: string) => shell.showItemInFolder(arquivo))

  // Status do cabeçalho: o que já está configurado (sem ir à rede — é instantâneo).
  ipcMain.handle('status-bot', () => {
    let cfg: AgentConfig | null = null
    try { cfg = getConfig() } catch { /* sem config ainda */ }
    const planilha = !!cfg && (tipoConexao(cfg) === 'apps_script'
      ? !!(cfg.apps_script_url && cfg.apps_script_token)
      : !!(cfg.spreadsheet_id && cfg.google_service_account_json_b64))
    const ponto = !!(cfg?.ponto_banco && cfg?.ponto_numero && cfg?.ponto_senha)
    let regras = false
    try { regras = !!lerRegrasLocais()?.geral.entrada_padrao } catch { /* arquivo ilegível */ }
    return { planilha, ponto, regras }
  })

  ipcMain.handle('historico', () => listarHistorico(8))

  // Ao abrir a tela: o último resultado (volta pra tela, e as pendências dele
  // podem ser justificadas) e os dias já conferidos.
  ipcMain.handle('estado-inicial', () => {
    let ultimo = loteNaTela ? lerUltimoResultado() : null
    if (!loteNaTela) {
      ultimo = lerUltimoResultado()
      if (ultimo) {
        loteNaTela = ultimo.lote
        modoNaTela = ultimo.modo
        gravadasNaTela = ultimo.gravadas
        planosNaTela = new Map(ultimo.lote.planos.map(p => [p.data, p]))
      }
    }
    return { ultimo, conferencias: lerConferencias() }
  })
  ipcMain.handle('conferencias', () => lerConferencias())

  ipcMain.handle('abrir-regras', () => openRegrasWindow())
  ipcMain.handle('abrir-config', () => openConfigWindow())
  ipcMain.handle('abrir-inicio', () => openAppWindow())

  // Regras vêm do arquivo local (instantâneo, junto com a última lista da
  // planilha guardada em disco); a lista fresca vem depois, por 'regras-planilha'.
  ipcMain.handle('regras-carregar', () => {
    try {
      return { ok: true, ...regrasDaTela() }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('regras-planilha', async () => {
    const gw = gatewayOpcional()
    if (!gw) return { ok: false, message: 'Planilha não conectada — configure a conexão para ver colaboradores e feriados.' }
    try {
      return { ok: true, ...(await dadosDaPlanilha(gw)) }
    } catch (err: any) {
      return { ok: false, message: `Não deu pra ler a planilha (lista de colaboradores e feriados): ${err.message}` }
    }
  })

  // Valida antes de gravar no arquivo local: com qualquer erro, nada é salvo.
  ipcMain.handle('regras-salvar', async (_e, regras: RegrasEditaveis) => {
    try {
      const v = await salvarRegras(regras, gatewayOpcional())
      return { ok: v.erros.length === 0, ...v }
    } catch (err: any) {
      logger.error('[regras]', err.message)
      return { ok: false, erros: [err.message ?? 'Erro desconhecido'], avisos: [] }
    }
  })
}

app.whenReady().then(() => {
  // Senha do ponto e token do Apps Script cifrados no disco (DPAPI no Windows).
  if (safeStorage.isEncryptionAvailable()) {
    configurarCofre({
      cifrar: t => safeStorage.encryptString(t).toString('base64'),
      decifrar: b => safeStorage.decryptString(Buffer.from(b, 'base64')),
    })
  } else {
    logger.warn('[main] Cofre do sistema indisponível — segredos ficam em texto puro no config.json.')
  }
  registerIPC()
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('Frequência Agent')
  tray.setContextMenu(buildContextMenu())
  tray.on('double-click', () => openAppWindow())

  if (!fs.existsSync(getConfigPath())) openConfigWindow()
  else openAppWindow()
})

// Segundo clique no atalho: traz a janela pra frente, na tela em que estava.
app.on('second-instance', () => {
  if (appWin && !appWin.isDestroyed()) { if (appWin.isMinimized()) appWin.restore(); appWin.show(); appWin.focus() } else openAppWindow()
})
app.on('window-all-closed', () => { /* mantém vivo — só sai pelo tray */ })
