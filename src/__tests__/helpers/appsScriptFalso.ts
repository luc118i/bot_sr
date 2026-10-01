// apps-script/Codigo.gs de verdade, rodando numa sandbox (vm) com
// SpreadsheetApp/PropertiesService/LockService simulados. Usado pelos testes de
// integração e pelo E2E do app como se fosse o Google.
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import { cenario, posA1, RAIZ_PROJETO } from './planilha'

const CODIGO = fs.readFileSync(path.join(RAIZ_PROJETO, 'apps-script', 'Codigo.gs'), 'utf-8')

export interface Planilha { nome: string; abas: Record<string, { grid: any[][]; ocultas: Set<number> }> }

export function sandbox(pl: Planilha, props: Record<string, string> = { TOKEN: 'tok' }) {
  const lock = { esperas: 0, liberacoes: 0, falhar: false }
  const aba = (nome: string) => {
    const a = pl.abas[nome]
    if (!a) return null
    const cel = (ref: string) => {
      const [r, c] = posA1(ref)
      return {
        getValue: () => a.grid[r]?.[c] ?? '',
        setValue: (v: any) => { while (a.grid.length <= r) a.grid.push([]); a.grid[r]![c] = v },
      }
    }
    return {
      getName: () => nome,
      getDataRange: () => ({ getValues: () => a.grid.map(l => Array.from(l, v => v ?? '')) }),
      getRange: cel,
      getRangeList: (refs: string[]) => ({
        getRanges: () => refs.map(cel),
        clearContent: () => refs.forEach(r => cel(r).setValue('')),
      }),
      getMaxColumns: () => Math.max(60, ...a.grid.map(l => l.length)),
      isColumnHiddenByUser: (c: number) => a.ocultas.has(c),
    }
  }
  const ss = {
    getName: () => pl.nome,
    getSheets: () => Object.keys(pl.abas).map(aba),
    getSheetByName: aba,
    getSpreadsheetTimeZone: () => 'America/Sao_Paulo',
  }
  const ctx: any = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    LockService: { getScriptLock: () => ({ waitLock: () => { lock.esperas++; if (lock.falhar) throw new Error('Lock timeout') }, releaseLock: () => { lock.liberacoes++ } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t: string) => ({ setMimeType: () => ({ texto: t }) }) },
    Utilities: {
      formatDate: (d: Date, _tz: string, f: string) => f === 'HH:mm'
        ? `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
        : d.toISOString().slice(0, 10),
    },
    Logger: { log: () => {} },
  }
  vm.createContext(ctx)
  vm.runInContext(CODIGO, ctx)
  const post = (req: unknown) => JSON.parse(ctx.doPost({ postData: { contents: typeof req === 'string' ? req : JSON.stringify(req) } }).texto)
  return { ctx, post, lock }
}

export function planilhaDoCenario(): Planilha {
  const gw = cenario()
  return {
    nome: '[SR] - Frequência logística 2026',
    abas: Object.fromEntries(Object.entries(gw.abas).map(([n, g]) => [n, { grid: g, ocultas: gw.ocultas[n] ?? new Set() }])),
  }
}
