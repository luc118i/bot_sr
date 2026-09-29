import path from 'path'
import fs from 'fs'
import { extrairSpreadsheetId } from './sheets/googleSheets'

// Config LOCAL da máquina (credenciais e qual planilha). As regras de negócio
// (horários, tolerância, exceções, apelidos, feriados) ficam nas abas CONFIG_*
// da própria planilha, editáveis sem mexer no app.
export interface AgentConfig {
  google_service_account_json_b64: string
  spreadsheet_id: string
}

// No Electron, envSetup.ts aponta pra pasta userData; na CLI, ./config.json
// (ou --config).
export function getConfigPath(): string {
  return process.env['AGENT_CONFIG_PATH'] ?? path.resolve(process.cwd(), 'config.json')
}

let cachedConfig: AgentConfig | null = null

export function clearCachedConfig(): void {
  cachedConfig = null
}

export function getConfig(): AgentConfig {
  if (cachedConfig) return cachedConfig
  const p = getConfigPath()
  if (!fs.existsSync(p)) {
    throw new Error(
      `Arquivo de configuração não encontrado em:\n${p}\n\n` +
      `Abra as Configurações do agente (ou copie o config.example.json para esse caminho).`,
    )
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as AgentConfig
    parsed.spreadsheet_id = extrairSpreadsheetId(parsed.spreadsheet_id ?? '')
    cachedConfig = parsed
    return parsed
  } catch (err: any) {
    throw new Error(`Erro ao ler config.json: ${err.message}`)
  }
}

export function saveConfig(cfg: AgentConfig): void {
  const p = getConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ ...cfg, spreadsheet_id: extrairSpreadsheetId(cfg.spreadsheet_id ?? '') }, null, 2), 'utf-8')
  clearCachedConfig()
}
