import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('save-config', cfg),
  pickJsonFile: () => ipcRenderer.invoke('pick-json-file'),
  testConnection: (cfg: unknown) => ipcRenderer.invoke('test-connection', cfg),
  criarAbasConfig: () => ipcRenderer.invoke('criar-abas-config'),
  pickHtmlFile: () => ipcRenderer.invoke('pick-html-file'),
  simular: (params: unknown) => ipcRenderer.invoke('simular', params),
  escrever: () => ipcRenderer.invoke('escrever'),
  desfazer: () => ipcRenderer.invoke('desfazer'),
  desfazerDeRelatorio: () => ipcRenderer.invoke('desfazer-de-relatorio'),
  abrirRelatorios: () => ipcRenderer.invoke('abrir-relatorios'),
  abrirRegras: () => ipcRenderer.invoke('abrir-regras'),
  regrasCarregar: () => ipcRenderer.invoke('regras-carregar'),
  regrasSalvar: (regras: unknown) => ipcRenderer.invoke('regras-salvar', regras),
})
