import ExcelJS from 'exceljs'
import path from 'path'
import type { SheetGateway } from './gateway'

// Cópia .xlsx da planilha (Arquivo → Fazer download → .xlsx). Só leitura:
// qualquer tentativa de escrita falha — a escrita real é sempre no Google.
export class XlsxGateway implements SheetGateway {
  private wb: ExcelJS.Workbook | null = null
  readonly descricao: string

  constructor(private arquivo: string) {
    this.descricao = `arquivo ${path.basename(arquivo)} (somente leitura)`
  }

  private async carregar() {
    if (!this.wb) {
      this.wb = new ExcelJS.Workbook()
      await this.wb.xlsx.readFile(this.arquivo)
    }
    return this.wb
  }

  async titulo() { return path.basename(this.arquivo, path.extname(this.arquivo)) }
  async listarAbas() { return (await this.carregar()).worksheets.map(w => w.name) }

  async lerGrid(aba: string): Promise<string[][] | null> {
    const ws = (await this.carregar()).getWorksheet(aba)
    if (!ws) return null
    const grid: string[][] = []
    ws.eachRow({ includeEmpty: true }, (row, r) => {
      const linha: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, c) => { linha[c - 1] = valorCru(cell.value) })
      grid[r - 1] = Array.from(linha, v => v ?? '')
    })
    return Array.from(grid, r => r ?? [])
  }

  async colunasOcultas(aba: string): Promise<Set<number>> {
    const ws = (await this.carregar()).getWorksheet(aba)
    const ocultas = new Set<number>()
    if (!ws) return ocultas
    for (let c = 1; c <= ws.columnCount; c++) if (ws.getColumn(c).hidden) ocultas.add(c)
    return ocultas
  }

  async lerCelulas(aba: string, celulas: string[]): Promise<string[]> {
    const ws = (await this.carregar()).getWorksheet(aba)
    if (!ws) throw new Error(`Aba "${aba}" não existe no arquivo.`)
    return celulas.map(c => valorCru(ws.getCell(c).value))
  }

  async escrever(): Promise<void> {
    throw new Error('Modo arquivo .xlsx é somente leitura — a escrita só acontece na planilha do Google.')
  }

  async limpar(): Promise<void> {
    throw new Error('Modo arquivo .xlsx é somente leitura.')
  }

  async criarAba(): Promise<void> {
    throw new Error('Modo arquivo .xlsx é somente leitura.')
  }

  async substituirTabela(): Promise<void> {
    throw new Error('Modo arquivo .xlsx é somente leitura.')
  }
}

// Mesmo formato do UNFORMATTED_VALUE do Google: datas como serial, horas como
// fração do dia, fórmulas pelo resultado calculado.
function valorCru(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) {
    const serial = v.getTime() / 86400000 + 25569
    return String(serial)
  }
  if (typeof v === 'object') {
    if ('result' in v) return valorCru((v as any).result)
    if ('richText' in v) return (v as any).richText.map((t: any) => t.text).join('')
    if ('text' in v) return String((v as any).text)
    if ('error' in v) return ''
    return ''
  }
  return String(v)
}
