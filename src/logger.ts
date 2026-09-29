import path from 'path'
import fs from 'fs'

// No Electron, envSetup.ts aponta DATA_DIR pra userData; na CLI, pasta atual.
export function getDataDir(): string {
  return process.env['DATA_DIR'] ?? process.cwd()
}

export function getLogsDir(): string {
  return path.join(getDataDir(), 'logs')
}

export function getRelatoriosDir(): string {
  return path.join(getDataDir(), 'relatorios')
}

export function log(level: 'INFO' | 'WARN' | 'ERROR', ...args: any[]): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
  if (process.env['LOG_TO_CONSOLE'] !== '0') console.log(line)
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true })
    fs.appendFileSync(path.join(getLogsDir(), 'frequencia.log'), line + '\n', 'utf-8')
  } catch { /* não bloqueia se falhar */ }
}

export const logger = {
  info:  (...a: any[]) => log('INFO',  ...a),
  warn:  (...a: any[]) => log('WARN',  ...a),
  error: (...a: any[]) => log('ERROR', ...a),
}
