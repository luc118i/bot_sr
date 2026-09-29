import { google, type sheets_v4 } from 'googleapis'
import { refAba, type SheetGateway } from './gateway'

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']
// Folga generosa: a aba de mês usa até ~AZ e ~130 linhas hoje.
const FAIXA_LEITURA = 'A1:CZ1000'

/** Aceita o ID puro ou o link completo colado da barra do navegador. */
export function extrairSpreadsheetId(raw: string): string {
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  return m ? m[1]! : raw.trim()
}

export function criarAuth(serviceAccountB64: string) {
  if (!serviceAccountB64) {
    throw new Error('Service Account do Google não configurada. Abra as Configurações do agente e selecione o arquivo JSON.')
  }
  let creds: any
  try {
    creds = JSON.parse(Buffer.from(serviceAccountB64, 'base64').toString('utf-8'))
  } catch {
    throw new Error('Service Account do Google inválida. Selecione novamente o arquivo JSON nas Configurações.')
  }
  if (creds.type && creds.type !== 'service_account') {
    throw new Error(`Arquivo incorreto: tipo "${creds.type}". É necessário uma Service Account (type: "service_account").`)
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Credenciais do Google malformadas: faltam client_email ou private_key.')
  }
  return {
    email: creds.client_email as string,
    auth: new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES }),
  }
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

export class GoogleSheetsGateway implements SheetGateway {
  private api: sheets_v4.Sheets
  private meta: { titulo: string; abas: string[] } | null = null
  readonly descricao: string

  constructor(private spreadsheetId: string, serviceAccountB64: string) {
    const { auth, email } = criarAuth(serviceAccountB64)
    this.api = google.sheets({ version: 'v4', auth })
    this.descricao = `Google Sheets ${spreadsheetId} (como ${email})`
  }

  private async carregarMeta() {
    if (this.meta) return this.meta
    try {
      const r = await this.api.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
        fields: 'properties.title,sheets.properties.title',
      })
      this.meta = {
        titulo: r.data.properties?.title ?? '',
        abas: (r.data.sheets ?? []).map(s => s.properties?.title ?? '').filter(Boolean),
      }
      return this.meta
    } catch (err: any) {
      if (err?.code === 403 || err?.code === 404) {
        throw new Error(
          `Sem acesso à planilha (${err.code}). Compartilhe a planilha com o e-mail da Service Account ` +
          `como EDITOR e confira o ID/link nas Configurações.`,
        )
      }
      throw err
    }
  }

  async titulo() { return (await this.carregarMeta()).titulo }
  async listarAbas() { return (await this.carregarMeta()).abas }

  async lerGrid(aba: string): Promise<string[][] | null> {
    if (!(await this.listarAbas()).includes(aba)) return null
    const r = await this.api.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${refAba(aba)}!${FAIXA_LEITURA}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER',
    })
    return (r.data.values ?? []).map(row => row.map(str))
  }

  async colunasOcultas(aba: string): Promise<Set<number>> {
    const r = await this.api.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      ranges: [refAba(aba)],
      fields: 'sheets(data(startColumn,columnMetadata(hiddenByUser)))',
    })
    const ocultas = new Set<number>()
    for (const d of r.data.sheets?.[0]?.data ?? []) {
      const inicio = d.startColumn ?? 0
      ;(d.columnMetadata ?? []).forEach((m, i) => { if (m.hiddenByUser) ocultas.add(inicio + i + 1) })
    }
    return ocultas
  }

  async lerCelulas(aba: string, celulas: string[]): Promise<string[]> {
    if (!celulas.length) return []
    const r = await this.api.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: celulas.map(c => `${refAba(aba)}!${c}`),
      valueRenderOption: 'UNFORMATTED_VALUE',
    })
    return (r.data.valueRanges ?? []).map(vr => str(vr.values?.[0]?.[0]))
  }

  async escrever(aba: string, valores: { celula: string; valor: string }[]): Promise<void> {
    if (!valores.length) return
    await this.api.spreadsheets.values.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        // RAW: "." e "P" entram como texto puro, sem o Sheets tentar interpretar.
        valueInputOption: 'RAW',
        data: valores.map(v => ({ range: `${refAba(aba)}!${v.celula}`, values: [[v.valor]] })),
      },
    })
  }

  async limpar(aba: string, celulas: string[]): Promise<void> {
    if (!celulas.length) return
    await this.api.spreadsheets.values.batchClear({
      spreadsheetId: this.spreadsheetId,
      requestBody: { ranges: celulas.map(c => `${refAba(aba)}!${c}`) },
    })
  }
}
