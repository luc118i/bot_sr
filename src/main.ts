import './envSetup'
import { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { getConfigPath, saveConfig, type AgentConfig } from './config'
import { getLogsDir, getRelatoriosDir, logger } from './logger'
import type { Plano } from './core/planner'
import { hojeISO } from './core/tempo'
import { GoogleSheetsGateway } from './sheets/googleSheets'
import { abrirGateway, criarAbasConfig, executarEscrita, salvarRelatorio, simular } from './service'

let tray: Tray | null = null
let configWin: BrowserWindow | null = null
let appWin: BrowserWindow | null = null

// Último plano simulado na janela principal. "Escrever" só grava ESTE plano —
// o operador aprova exatamente o que viu no relatório, nunca uma nova leitura.
let ultimoPlano: Plano | null = null
const VALIDADE_PLANO_MS = 60 * 60 * 1000

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
  appWin.on('closed', () => { appWin = null; ultimoPlano = null })
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
      return { ok: true, ...r }
    } catch (err: any) {
      logger.error('[escrever]', err.message)
      return { ok: false, message: err.message ?? 'Erro desconhecido' }
    }
  })

  ipcMain.handle('abrir-relatorios', () => shell.openPath(ensureDir(getRelatoriosDir())))
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
