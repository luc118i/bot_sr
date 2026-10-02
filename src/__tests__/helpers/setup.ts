// Carregado antes de cada arquivo de teste (node --require). Isola o processo:
// nada de log, relatório, regras.json ou config.json cai na pasta do projeto ou
// na pasta de dados do app de verdade — tudo vai pra uma pasta temporária.
// TEST_TZ roda a suíte inteira em outro fuso (npm run test:tz).
import fs from 'fs'
import os from 'os'
import path from 'path'

if (process.env['TEST_TZ']) process.env['TZ'] = process.env['TEST_TZ']

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'freq-teste-'))
process.env['DATA_DIR'] = raiz
process.env['REGRAS_PATH'] = path.join(raiz, 'regras.json')
process.env['AGENT_CONFIG_PATH'] = path.join(raiz, 'config.json')
process.env['LOG_TO_CONSOLE'] = '0'
// Nunca a planilha embutida de um build anterior (dist/embutido.json) — teste que precisa dela cria a sua.
process.env['EMBUTIDO_PATH'] = path.join(raiz, 'embutido.json')

process.on('exit', () => {
  try { fs.rmSync(raiz, { recursive: true, force: true }) } catch { /* Windows às vezes segura o arquivo */ }
})
