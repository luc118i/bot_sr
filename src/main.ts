import './envSetup'
import { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain, safeStorage } from 'electron'
import path from 'path'
import fs from 'fs'
import { configurarCofre, credenciaisPonto, getConfig, getConfigPath, saveConfig, tipoConexao, type AgentConfig } from './config'
import { hojeISO } from './core/tempo'
import { SecullumClient } from './ponto/secullum'
import { getLogsDir, getRelatoriosDir, logger } from './logger'
import type { Plano } from './core/planner'
import { extrairSpreadsheetId } from './sheets/googleSheets'
import {
  abrirGateway, desfazerEscrita, executarEscritaLote, gatewayDaConfig, justificar, listarHistorico, preencherAutomatico, salvarRelatorio, semanaDe, simularLote,
  type EscritaDoDia, type Lote, type ResultadoDesfazer, type ResultadoEscrita,
} from './service'
import { carregarRegras, lerRegrasLocais, salvarRegras, type RegrasEditaveis } from './regras'
import type { SheetGateway } from './sheets/gateway'

let tray: Tray | null = null
let configWin: BrowserWindow | null = null
let appWin: BrowserWindow | null = null
let regrasWin: BrowserWindow | null = null

// Última simulação (1 ou vários dias) na janela principal. "Escrever" só grava
// ESTES planos — o operador aprova exatamente o que viu, nunca uma nova leitura.
let ultimoLote: Lote | null = null
const VALIDADE_PLANO_MS = 60 * 60 * 1000

// Dias gravados na última escrita desta janela — alvo do "Desfazer esta
// escrita". Escritas mais antigas (ou de antes de reabrir o app) são desfeitas
// pelo relatório .json de cada dia, salvo em relatorios/.
let ultimaEscrita: EscritaDoDia[] | null = null

// Planos do último resultado mostrado na tela (gravado ou simulado). A
// justificativa só aceita células que estavam pendentes NESTES planos.
let planosNaTela = new Map<string, Plano>()
function mostrarNaTela(lote: Lote): void {
  planosNaTela = new Map(lote.planos.map(p => [p.data, p]))
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

function openConfigWindow(): void {
  if (configWin && !configWin.isDestroyed()) { configWin.focus(); return }
  configWin = new BrowserWindow({
    width: 640,
    height: 780,
    minWidth: 520,
    minHeight: 600,
    backgroundColor: '#F4F4F2',
    resizable: true,
    title: 'SR_dados — Configurações',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  configWin.loadFile(rendererPath('config.html'))
  configWin.on('closed', () => { configWin = null })
}

function openAppWindow(): void {
  if (appWin && !appWin.isDestroyed()) { appWin.focus(); return }
  appWin = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#F4F4F2',
    title: 'SR_dados',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  appWin.loadFile(rendererPath('app.html'))
  appWin.on('closed', () => { appWin = null; ultimoLote = null; ultimaEscrita = null; planosNaTela = new Map() })
}

function openRegrasWindow(): void {
  if (regrasWin && !regrasWin.isDestroyed()) { regrasWin.focus(); return }
  regrasWin = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#F4F4F2',
    title: 'SR_dados — Horários e regras',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  regrasWin.loadFile(rendererPath('regras.html'))
  regrasWin.on('closed', () => { regrasWin = null })
}

// Planilha se estiver configurada; null se ainda não (tela de regras funciona sem).
function gatewayOpcional(): SheetGateway | null {
  try { return abrirGateway() } catch { return null }
}

function registerIPC(): void {
  // Já com os segredos decifrados — a tela de Configurações mostra/edita.
  ipcMain.handle('get-config', () => {
    if (!fs.existsSync(getConfigPath())) return null
    try { return getConfig() } catch { return null }
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
      mostrarNaTela(r.lote)
      if (r.escrita) {
        for (const d of r.escrita.dias) salvarRelatorio(d.plano, 'escrita', { escritas: d.escritas, puladas: d.puladas })
        ultimaEscrita = r.escrita.dias.some(d => d.escritas.length) ? r.escrita.dias : null
      } else {
        for (const plano of r.lote.planos) salvarRelatorio(plano, 'simulacao')
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
    const result = await dialog.showOpenDialog(configWin!, {
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
      const gw = gatewayDaConfig({ ...cfg, spreadsheet_id: extrairSpreadsheetId(cfg.spreadsheet_id ?? '') })
      const titulo = await gw.titulo()
      const abas = await gw.listarAbas()
      return { ok: true, message: `Conectado a "${titulo}" (${abas.length} abas).` }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })


  // Vários arquivos de uma vez (um por dia) — a data de cada um vem do HTML.
  ipcMain.handle('pick-html-files', async () => {
    const result = await dialog.showOpenDialog(appWin!, {
      title: 'Selecionar o HTML de cada dia (pode escolher vários)',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths.map(p => ({ path: p, name: path.basename(p) }))
  })

  ipcMain.handle('simular', async (_e, params: { htmlPaths: string[]; forcar?: boolean }) => {
    ultimoLote = null
    try {
      const htmls = params.htmlPaths.map(p => ({ arquivo: path.basename(p), html: fs.readFileSync(p, 'utf-8') }))
      const lote = await simularLote(abrirGateway(), { htmls, forcar: !!params.forcar })
      ultimoLote = lote
      mostrarNaTela(lote)
      for (const plano of lote.planos) salvarRelatorio(plano, 'simulacao')
      return { ok: true, lote }
    } catch (err: any) {
      logger.error('[simular]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('escrever', async () => {
    const lote = ultimoLote
    if (!lote) return { ok: false, message: 'Rode a simulação antes de escrever.' }
    if (Date.now() - new Date(lote.geradoEm).getTime() > VALIDADE_PLANO_MS) {
      return { ok: false, message: 'A simulação tem mais de 1 hora — simule de novo antes de escrever.' }
    }
    ultimoLote = null // uma simulação só é aplicada uma vez
    const { dias, erro } = await executarEscritaLote(abrirGateway(), lote.planos)
    for (const d of dias) salvarRelatorio(d.plano, 'escrita', { escritas: d.escritas, puladas: d.puladas })
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
      if (r.escritas.length) ultimaEscrita = [{ data: plano.data, aba: plano.aba, plano, ...r }]
      return { ok: true, ...r }
    } catch (err: any) {
      logger.error('[justificar]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('desfazer', async () => {
    const alvo = ultimaEscrita
    if (!alvo) return { ok: false, message: 'Nenhuma escrita desta sessão para desfazer.' }
    const gw = abrirGateway()
    const dias: ({ data: string; aba: string } & ResultadoDesfazer)[] = []
    try {
      for (const d of alvo) {
        const r = await desfazerEscrita(gw, d.aba, d.escritas)
        salvarRelatorio(d.plano, 'desfeita', r)
        dias.push({ data: d.data, aba: d.aba, ...r })
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
        if (!/_(escrita|justificativa)_/.test(path.basename(arq)) || !extra?.escritas) {
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

  ipcMain.handle('abrir-relatorios', () => shell.openPath(ensureDir(getRelatoriosDir())))

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

  ipcMain.handle('abrir-regras', () => openRegrasWindow())
  ipcMain.handle('abrir-config', () => openConfigWindow())

  // Regras vêm do arquivo local; a planilha (se configurada) só alimenta a
  // lista de colaboradores e os feriados — sem ela a tela abre do mesmo jeito.
  ipcMain.handle('regras-carregar', async () => {
    try {
      return { ok: true, ...(await carregarRegras(gatewayOpcional())) }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
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

app.on('second-instance', () => openAppWindow())
app.on('window-all-closed', () => { /* mantém vivo — só sai pelo tray */ })
