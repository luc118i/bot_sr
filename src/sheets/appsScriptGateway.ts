import type { SheetGateway } from './gateway'

// Conecta na planilha pelo Apps Script publicado como App da Web
// (apps-script/Codigo.gs) — alternativa à Service Account. Toda chamada é um
// POST { token, acao, ... } no link /exec; o script responde { ok, dados } ou
// { ok: false, erro }. O Google responde o POST com um redirecionamento (302)
// pra outra URL que entrega o resultado — o fetch segue sozinho.

const TIMEOUT_MS = 60_000

// Quando algo está errado na implantação, o Google responde uma página HTML
// (HTTP 200) em vez do JSON do script. Tira o texto visível dela e traduz os
// casos conhecidos numa instrução do que fazer.
export function explicarPaginaDoGoogle(html: string, status: number, urlFinal = ''): string {
  const texto = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

  if (/fun[çc][ãa]o de script n[ãa]o encontrada|script function not found/i.test(texto)) {
    return `Apps Script: "${texto.replace(/^Erro\s*/i, '')}" — a versão publicada não tem o código do bot. ` +
      'Cole e salve o Codigo.gs, depois Implantar → Gerenciar implantações → editar (lápis) → Versão: Nova versão → Implantar. O link continua o mesmo.'
  }
  if (/accounts\.google\.com/.test(urlFinal) || /fazer login|sign in/i.test(texto)) {
    return 'Apps Script pediu login do Google — a implantação precisa ter acesso "Qualquer pessoa" (Implantar → Gerenciar implantações).'
  }
  if (/autoriza|authorization/i.test(texto)) {
    return `Apps Script: "${texto}" — abra o projeto, rode qualquer função uma vez no editor e aceite as permissões, depois publique uma nova versão.`
  }
  return `O Apps Script não respondeu JSON (HTTP ${status}). Resposta do Google: "${texto || 'vazia'}". ` +
    'Confira se a implantação é "App da Web" com acesso "Qualquer pessoa" e se o link é o da implantação atual.'
}

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
      throw new Error(explicarPaginaDoGoogle(texto, resp.status, resp.url))
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
}
