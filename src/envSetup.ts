import { app } from 'electron'
import path from 'path'

// Primeiro import de main.ts: aponta config, logs e relatórios pra pasta de
// dados do app antes de qualquer outro módulo ler essas variáveis (config.ts e
// logger.ts são compartilhados com a CLI, que usa a pasta atual).
const userData = app.getPath('userData')

process.env['DATA_DIR'] = userData
process.env['AGENT_CONFIG_PATH'] = path.join(userData, 'config.json')
