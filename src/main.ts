import './envSetup'
import { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { getConfigPath, saveConfig, type AgentConfig } from './config'
import { getLogsDir, getRelatoriosDir, logger } from './logger'
import type { Plano } from './core/planner'
import { hojeISO } from './core/tempo'
import { GoogleSheetsGateway } from './sheets/googleSheets'
import { abrirGateway, criarAbasConfig, desfazerEscrita, executarEscrita, salvarRelatorio, simular, type ResultadoEscrita } from './service'
import { carregarRegras, salvarRegras, type RegrasEditaveis } from './regras'

let tray: Tray | null = null
let configWin: BrowserWindow | null = null
let appWin: BrowserWindow | null = null
let regrasWin: BrowserWindow | null = null

// Último plano simulado na janela principal. "Escrever" só grava ESTE plano —
// o operador aprova exatamente o que viu no relatório, nunca uma nova leitura.
let ultimoPlano: Plano | null = null
const VALIDADE_PLANO_MS = 60 * 60 * 1000

// Última escrita feita nesta janela — alvo do botão "Desfazer esta escrita".
// Escritas mais antigas (ou de antes de reabrir o app) são desfeitas pelo
// relatório .json salvo em relatorios/.
let ultimaEscrita: { plano: Plano; escritas: ResultadoEscrita['escritas'] } | null = null

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
    width: 560,
    height: 620,
    resizable: false,
    title: 'Frequência Agent — Configuração',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  configWin.loadFile(rendererPath('config.html'))
  configWin.on('closed', () => { configWin = null })
}

function openAppWindow(): void {
  if (appWin && !appWin.isDestroyed()) { appWin.focus(); return }
  appWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Frequência Agent — Preencher frequência',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  appWin.loadFile(rendererPath('app.html'))
  appWin.on('closed', () => { appWin = null; ultimoPlano = null; ultimaEscrita = null })
}

function openRegrasWindow(): void {
  if (regrasWin && !regrasWin.isDestroyed()) { regrasWin.focus(); return }
  regrasWin = new BrowserWindow({
    width: 1000,
    height: 780,
    title: 'Frequência Agent — Horários e regras',
    autoHideMenuBar: true,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false },
  })
  regrasWin.loadFile(rendererPath('regras.html'))
  regrasWin.on('closed', () => { regrasWin = null })
}

function registerIPC(): void {
  ipcMain.handle('get-config', () => {
    const p = getConfigPath()
    if (!fs.existsSync(p)) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
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
      const gw = new GoogleSheetsGateway(cfg.spreadsheet_id, cfg.google_service_account_json_b64)
      const titulo = await gw.titulo()
      const abas = await gw.listarAbas()
      const faltando = ['CONFIG_GERAL'].filter(a => !abas.includes(a))
      return {
        ok: true,
        message: `Conectado a "${titulo}" (${abas.length} abas).` +
          (faltando.length ? ' Falta criar as abas de configuração.' : ''),
      }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('criar-abas-config', async () => {
    try {
      const criadas = await criarAbasConfig(abrirGateway())
      return { ok: true, criadas }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('pick-html-file', async () => {
    const result = await dialog.showOpenDialog(appWin!, {
      title: 'Selecionar HTML salvo da tela de ponto',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return { path: result.filePaths[0], name: path.basename(result.filePaths[0]) }
  })

  ipcMain.handle('simular', async (_e, params: { data: string; htmlPath: string; forcar?: boolean }) => {
    ultimoPlano = null
    try {
      const html = fs.readFileSync(params.htmlPath, 'utf-8')
      const plano = await simular(abrirGateway(), { data: params.data || hojeISO(), html, forcar: !!params.forcar })
      ultimoPlano = plano
      const relatorio = salvarRelatorio(plano, 'simulacao')
      return { ok: true, plano, relatorio }
    } catch (err: any) {
      logger.error('[simular]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('escrever', async () => {
    const plano = ultimoPlano
    if (!plano) return { ok: false, message: 'Rode a simulação antes de escrever.' }
    if (Date.now() - new Date(plano.geradoEm).getTime() > VALIDADE_PLANO_MS) {
      return { ok: false, message: 'A simulação tem mais de 1 hora — simule de novo antes de escrever.' }
    }
    try {
      const r = await executarEscrita(abrirGateway(), plano)
      salvarRelatorio(plano, 'escrita', r)
      ultimoPlano = null // um plano só é aplicado uma vez
      ultimaEscrita = r.escritas.length ? { plano, escritas: r.escritas } : null
      return { ok: true, ...r }
    } catch (err: any) {
      logger.error('[escrever]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('desfazer', async () => {
    const alvo = ultimaEscrita
    if (!alvo) return { ok: false, message: 'Nenhuma escrita desta sessão para desfazer.' }
    try {
      const r = await desfazerEscrita(abrirGateway(), alvo.plano.aba, alvo.escritas)
      salvarRelatorio(alvo.plano, 'desfeita', r)
      ultimaEscrita = null
      return { ok: true, data: alvo.plano.data, aba: alvo.plano.aba, ...r }
    } catch (err: any) {
      logger.error('[desfazer]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  // Desfaz uma escrita antiga a partir do .json que a própria escrita salvou.
  ipcMain.handle('desfazer-de-relatorio', async () => {
    const result = await dialog.showOpenDialog(appWin!, {
      title: 'Escolha o relatório da escrita a desfazer',
      defaultPath: ensureDir(getRelatoriosDir()),
      filters: [{ name: 'Relatório de escrita', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelado: true }
    try {
      const arq = result.filePaths[0]
      const { plano, extra } = JSON.parse(fs.readFileSync(arq, 'utf-8')) as { plano: Plano; extra?: ResultadoEscrita }
      if (!/_escrita_/.test(path.basename(arq)) || !extra?.escritas) {
        return { ok: false, message: 'Esse arquivo não é o relatório de uma escrita (nome "..._escrita_....json").' }
      }
      const lista = extra.escritas.map(e => `${e.celula}="${e.codigo}"`).join(', ')
      const { response } = await dialog.showMessageBox(appWin!, {
        type: 'warning',
        buttons: ['Desfazer', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        title: 'Desfazer escrita',
        message: `Desfazer a escrita de ${plano.data} (aba "${plano.aba}")?`,
        detail: `${extra.escritas.length} célula(s): ${lista}\n\nSó serão apagadas as que ainda tiverem exatamente o código gravado pelo bot.`,
      })
      if (response !== 0) return { ok: false, cancelado: true }
      const r = await desfazerEscrita(abrirGateway(), plano.aba, extra.escritas)
      salvarRelatorio(plano, 'desfeita', r)
      return { ok: true, data: plano.data, aba: plano.aba, ...r }
    } catch (err: any) {
      logger.error('[desfazer]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('abrir-relatorios', () => shell.openPath(ensureDir(getRelatoriosDir())))

  ipcMain.handle('abrir-regras', () => openRegrasWindow())

  ipcMain.handle('regras-carregar', async () => {
    try {
      return { ok: true, ...(await carregarRegras(abrirGateway())) }
    } catch (err: any) {
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  // Valida antes de gravar: com qualquer erro, nada vai pra planilha.
  ipcMain.handle('regras-salvar', async (_e, regras: RegrasEditaveis) => {
    try {
      const v = await salvarRegras(abrirGateway(), regras)
      return { ok: v.erros.length === 0, ...v }
    } catch (err: any) {
      logger.error('[regras]', err.message)
      return { ok: false, erros: [err.message ?? 'Erro desconhecido'], avisos: [] }
    }
  })
}

app.whenReady().then(() => {
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
