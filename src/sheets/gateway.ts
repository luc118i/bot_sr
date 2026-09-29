// Tudo que o bot precisa de uma planilha. Duas implementações:
//   - GoogleSheetsGateway: a planilha real (leitura e escrita);
//   - XlsxGateway: uma cópia .xlsx baixada, SÓ LEITURA — serve pra simular e
//     pro teste de aceitação sem tocar na planilha de verdade.
// Os valores sempre chegam como string "crua" (número sem formatação, data
// como serial, hora como fração do dia) — o core sabe interpretar.
export interface SheetGateway {
  readonly descricao: string
  titulo(): Promise<string>
  listarAbas(): Promise<string[]>
  /** Grid a partir de A1 (linha 1 = índice 0). null se a aba não existe. */
  lerGrid(aba: string): Promise<string[][] | null>
  /** Valor atual de cada célula (A1), na mesma ordem. */
  lerCelulas(aba: string, celulas: string[]): Promise<string[]>
  escrever(aba: string, valores: { celula: string; valor: string }[]): Promise<void>
  criarAba(nome: string, cabecalho: string[]): Promise<void>
}

export function refAba(aba: string): string {
  return `'${aba.replace(/'/g, "''")}'`
}
