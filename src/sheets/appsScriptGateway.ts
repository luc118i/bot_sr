import type { SheetGateway } from './gateway'

// Conecta na planilha pelo Apps Script publicado como App da Web
// (apps-script/Codigo.gs) — alternativa à Service Account. Toda chamada é um
// POST { token, acao, ... } no link /exec; o script responde { ok, dados } ou
// { ok: false, erro }. O Google responde o POST com um redirecionamento (302)
// pra outra URL que entrega o resultado — o fetch segue sozinho.

const TIMEOUT_MS = 60_000

export class AppsScriptGateway implements SheetGateway {
  private meta: { titulo: string; abas: string[] } | null = null
  readonly descricao: string

  constructor(private url: string, private token: string) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url.trim())) {
      throw new Error('Link do Apps Script inválido — deve ser o link da implantação "App da Web", terminando em /exec.')
    }
    if (!token) throw new Error('Token do Apps Script não configurado.')
    this.url = url.trim()
    this.descricao = 'Google Sheets via Apps Script'
  }

  private async chamar<T>(acao: string, params: Record<string, unknown> = {}): Promise<T> {
    let resp: Response
    try {
      resp = await fetch(this.url, {
        method: 'POST',
        // text/plain evita o "preflight" e é o que o Apps Script aceita sem frescura.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: this.token, acao, ...params }),
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err: any) {
      throw new Error(`Sem resposta do Apps Script (${err?.name === 'TimeoutError' ? 'tempo esgotado' : err?.message}).`)
    }
    const texto = await resp.text()
    let json: { ok: boolean; dados?: T; erro?: string }
    try {
      json = JSON.parse(texto)
    } catch {
      // Página HTML do Google = implantação sem acesso "Qualquer pessoa" ou link errado.
      throw new Error(
        `O Apps Script não respondeu JSON (HTTP ${resp.status}). Confira se a implantação é "App da Web" ` +
        `com acesso "Qualquer pessoa" e se o link é o da implantação atual.`,
      )
    }
    if (!json.ok) throw new Error(`Apps Script: ${json.erro ?? 'erro desconhecido'}`)
    return json.dados as T
  }

  private async carregarMeta() {
    if (!this.meta) this.meta = await this.chamar<{ titulo: string; abas: string[] }>('info')
    return this.meta
  }

  async titulo() { return (await this.carregarMeta()).titulo }
  async listarAbas() { return (await this.carregarMeta()).abas }

  async lerGrid(aba: string) {
    return this.chamar<string[][] | null>('lerGrid', { aba })
  }

  async lerCelulas(aba: string, celulas: string[]) {
    if (!celulas.length) return []
    return this.chamar<string[]>('lerCelulas', { aba, celulas })
  }

  async colunasOcultas(aba: string) {
    return new Set(await this.chamar<number[]>('colunasOcultas', { aba }))
  }

  async escrever(aba: string, valores: { celula: string; valor: string }[]) {
    if (!valores.length) return
    await this.chamar('escrever', { aba, valores })
  }

  async limpar(aba: string, celulas: string[]) {
    if (!celulas.length) return
    await this.chamar('limpar', { aba, celulas })
  }

  async criarAba(nome: string, cabecalho: string[]) {
    await this.chamar('criarAba', { nome, cabecalho })
    this.meta = null
  }

  async substituirTabela(aba: string, linhas: string[][]) {
    await this.chamar('substituirTabela', { aba, linhas })
    this.meta = null
  }
}
