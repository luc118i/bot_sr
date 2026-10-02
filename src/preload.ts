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
  escrever: () => ipcRenderer.invoke('escrever'),
  justificar: (params: unknown) => ipcRenderer.invoke('justificar', params),
  ferias: (params: unknown) => ipcRenderer.invoke('ferias', params),
  desfazer: () => ipcRenderer.invoke('desfazer'),
  desfazerDeRelatorio: () => ipcRenderer.invoke('desfazer-de-relatorio'),
  abrirRelatorios: () => ipcRenderer.invoke('abrir-relatorios'),
  abrirPastaRelatorios: () => ipcRenderer.invoke('abrir-pasta-relatorios'),
  pontualidade: (filtros: unknown) => ipcRenderer.invoke('pontualidade', filtros),
  exportarPontualidade: (filtros: unknown) => ipcRenderer.invoke('pontualidade-exportar', filtros),
  mostrarArquivo: (arquivo: string) => ipcRenderer.invoke('mostrar-arquivo', arquivo),
  abrirRegras: () => ipcRenderer.invoke('abrir-regras'),
  abrirConfig: () => ipcRenderer.invoke('abrir-config'),
  abrirInicio: () => ipcRenderer.invoke('abrir-inicio'),
  statusBot: () => ipcRenderer.invoke('status-bot'),
  estadoInicial: () => ipcRenderer.invoke('estado-inicial'),
  conferencias: () => ipcRenderer.invoke('conferencias'),
  historico: () => ipcRenderer.invoke('historico'),
  regrasCarregar: () => ipcRenderer.invoke('regras-carregar'),
  regrasPlanilha: () => ipcRenderer.invoke('regras-planilha'),
  regrasSalvar: (regras: unknown) => ipcRenderer.invoke('regras-salvar', regras),
})
