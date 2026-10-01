import ExcelJS from 'exceljs'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MemoryGateway } from './planilha'

/** Grava a planilha em memória como um .xlsx de verdade (números como número, colunas ocultas). */
export async function salvarXlsx(gw: MemoryGateway, nome = '[SR] - Frequência logística 2026'): Promise<string> {
  const wb = new ExcelJS.Workbook()
  for (const [aba, grid] of Object.entries(gw.abas)) {
    const ws = wb.addWorksheet(aba)
    grid.forEach((linha, r) => linha.forEach((v, c) => {
      if (v) ws.getCell(r + 1, c + 1).value = /^\d+$/.test(v) ? Number(v) : v
    }))
    for (const c of gw.ocultas[aba] ?? []) ws.getColumn(c).hidden = true
  }
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'freq-xlsx-')), `${nome}.xlsx`)
  await wb.xlsx.writeFile(arq)
  return arq
}
