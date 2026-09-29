import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg: unknown) => ipcRenderer.invoke('save-config', cfg),
  pickJsonFile: () => ipcRenderer.invoke('pick-json-file'),
  testConnection: (cfg: unknown) => ipcRenderer.invoke('test-connection', cfg),
  testarPonto: (cfg: unknown) => ipcRenderer.invoke('testar-ponto', cfg),
  preencher: (params: unknown) => ipcRenderer.invoke('preencher', params),
  // Andamento do "Preencher" — um evento por fase de cada dia.
  onProgresso: (cb: (ev: unknown) => void) => {
    ipcRenderer.removeAllListeners('progresso')
    ipcRenderer.on('progresso', (_e, ev) => cb(ev))
  },
  pickHtmlFiles: () => ipcRenderer.invoke('pick-html-files'),
  simular: (params: unknown) => ipcRenderer.invoke('simular', params),
  escrever: () => ipcRenderer.invoke('escrever'),
  desfazer: () => ipcRenderer.invoke('desfazer'),
  desfazerDeRelatorio: () => ipcRenderer.invoke('desfazer-de-relatorio'),
  abrirRelatorios: () => ipcRenderer.invoke('abrir-relatorios'),
  abrirRegras: () => ipcRenderer.invoke('abrir-regras'),
  abrirConfig: () => ipcRenderer.invoke('abrir-config'),
  regrasCarregar: () => ipcRenderer.invoke('regras-carregar'),
  regrasSalvar: (regras: unknown) => ipcRenderer.invoke('regras-salvar', regras),
})
