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
  /** Colunas ocultas pelo usuário (1-based). Na planilha de frequência, coluna
   *  de dia oculta = domingo ou feriado — é assim que o calendário é mantido. */
  colunasOcultas(aba: string): Promise<Set<number>>
  escrever(aba: string, valores: { celula: string; valor: string }[]): Promise<void>
  /** Deixa as células vazias (usado só pelo "Desfazer" de uma escrita do bot). */
  limpar(aba: string, celulas: string[]): Promise<void>
}

export function refAba(aba: string): string {
  return `'${aba.replace(/'/g, "''")}'`
}
