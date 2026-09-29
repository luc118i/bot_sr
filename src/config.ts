import path from 'path'
import fs from 'fs'
import { extrairSpreadsheetId } from './sheets/googleSheets'
import type { CredenciaisPonto, TipoLoginPonto } from './ponto/secullum'

// Config LOCAL da máquina (credenciais e qual planilha). As regras de negócio
// (horários, tolerância, exceções, apelidos) ficam em regras.json, também
// local, editado pela tela "Horários e regras".
export interface AgentConfig {
  // Como o bot fala com a planilha: Apps Script publicado dentro da própria
  // planilha (link /exec + token) ou Service Account (JSON + ID da planilha).
  conexao?: 'apps_script' | 'service_account'
  apps_script_url?: string
  apps_script_token?: string
  google_service_account_json_b64: string
  spreadsheet_id: string
  // Login da Central do Funcionário (Secullum) — o mesmo da tela de login.
  ponto_banco?: string
  ponto_tipo?: TipoLoginPonto
  ponto_numero?: string
  ponto_senha?: string
}

// Configs antigas (antes da escolha) usavam só a Service Account.
export function tipoConexao(cfg: AgentConfig): 'apps_script' | 'service_account' {
  return cfg.conexao ?? (cfg.apps_script_url ? 'apps_script' : 'service_account')
}

export function credenciaisPonto(cfg: AgentConfig): CredenciaisPonto {
  if (!cfg.ponto_banco || !cfg.ponto_numero || !cfg.ponto_senha) {
    throw new Error('Login do ponto não configurado — abra Configurações → Ponto (Secullum).')
  }
  return { banco: cfg.ponto_banco, tipo: cfg.ponto_tipo ?? 'folha', numero: cfg.ponto_numero, senha: cfg.ponto_senha }
}

// ── Segredos ────────────────────────────────────────────────────────────────
// Senha do ponto e token do Apps Script não ficam em texto puro no disco: no
// app, main.ts liga o cofre do sistema (Electron safeStorage → DPAPI no
// Windows, amarrado ao usuário da máquina) e eles são gravados como
// "<campo>_enc". Sem cofre (CLI), ficam em texto puro como antes.
const SEGREDOS = ['ponto_senha', 'apps_script_token'] as const

interface Cofre { cifrar(texto: string): string; decifrar(b64: string): string }
let cofre: Cofre | null = null

export function configurarCofre(c: Cofre): void {
  cofre = c
  clearCachedConfig()
}

function abrirSegredos(bruto: Record<string, any>): AgentConfig {
  const cfg = { ...bruto }
  for (const campo of SEGREDOS) {
    const enc = cfg[`${campo}_enc`]
    delete cfg[`${campo}_enc`]
    if (!enc) continue
    if (!cofre) throw new Error(`O config.json tem "${campo}" criptografado — só o app consegue ler (a CLI não).`)
    cfg[campo] = cofre.decifrar(enc)
  }
  return cfg as AgentConfig
}

function fecharSegredos(cfg: AgentConfig): Record<string, any> {
  const out: Record<string, any> = { ...cfg }
  if (!cofre) return out
  for (const campo of SEGREDOS) {
    const valor = out[campo]
    delete out[campo]
    if (valor) out[`${campo}_enc`] = cofre.cifrar(valor)
  }
  return out
}

// ── Leitura/gravação ────────────────────────────────────────────────────────

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
  let bruto: Record<string, any>
  try {
    bruto = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (err: any) {
    throw new Error(`Erro ao ler config.json: ${err.message}`)
  }
  const parsed = abrirSegredos(bruto)
  parsed.spreadsheet_id = extrairSpreadsheetId(parsed.spreadsheet_id ?? '')
  cachedConfig = parsed
  return parsed
}

export function saveConfig(cfg: AgentConfig): void {
  const p = getConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const limpo = { ...cfg, spreadsheet_id: extrairSpreadsheetId(cfg.spreadsheet_id ?? '') }
  fs.writeFileSync(p, JSON.stringify(fecharSegredos(limpo), null, 2), 'utf-8')
  clearCachedConfig()
}
