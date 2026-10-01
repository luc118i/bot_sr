import { randomUUID } from 'crypto'

// Cliente da API por trás da Central do Funcionário (Secullum) — a mesma que a
// tela "Acompanhamento de Ponto" usa. Mapeado a partir do JavaScript público da
// página (centraldofuncionario.com.br, versão 1.45.0):
//   - base: https://pontowebapp.secullum.com.br/<banco>/<endpoint>
//   - toda chamada leva Authorization: Basic base64("numero:senha:tipo"), com
//     tipo 0 = Nº Folha, 1 = Nº Identificador — não há sessão/cookie;
//   - GET /Batidas/AAAA-MM-DD → { lista: [...] }, uma linha por colaborador da
//     equipe de quem logou (é o que a tela de acompanhamento mostra).
// Sem navegador: nada de Chromium, calendário ou seletor CSS pra quebrar.

const BASE = 'https://pontowebapp.secullum.com.br/'
// Versão da Central do Funcionário que o bot imita (header exigido pela API).
const VERSAO_CENTRAL = '1.45.0'
const TIMEOUT_MS = 30_000

export type TipoLoginPonto = 'folha' | 'identificador'

export interface CredenciaisPonto {
  banco: string
  tipo: TipoLoginPonto
  numero: string
  senha: string
}

// Uma linha da tela de acompanhamento (campos que o bot usa).
export interface LinhaPontoApi {
  funcionarioNome: string
  data: string
  feriado?: boolean
  batidas?: { valor?: string | null }[]
  saldo?: string
  situacao?: number        // 0 dia completo · 1 incompleto (amarelo) · 2 com faltas (vermelho)
  registroPendente?: boolean
}

export interface RespostaPontoDiario { lista?: LinhaPontoApi[] }

/** O que o preenchimento precisa de uma fonte de ponto — facilita testar sem rede. */
export interface FontePonto {
  pontoDiario(data: string): Promise<LinhaPontoApi[]>
}

export class PontoAuthError extends Error {}

export class SecullumClient implements FontePonto {
  private dispositivo = randomUUID()

  constructor(private cred: CredenciaisPonto) {
    if (!/^\d+$/.test(cred.banco.trim())) throw new Error('Banco do ponto inválido — é um número (o mesmo da tela de login).')
    if (!cred.numero.trim() || !cred.senha) throw new Error('Número e senha do ponto não configurados (Configurações → Ponto).')
  }

  private url(endpoint: string): string {
    return `${BASE}${this.cred.banco.trim()}${endpoint}`
  }

  private headers(json = false): Record<string, string> {
    const tipo = this.cred.tipo === 'identificador' ? 1 : 0
    const basic = Buffer.from(`${this.cred.numero.trim()}:${this.cred.senha}:${tipo}`, 'utf-8').toString('base64')
    return {
      Authorization: `Basic ${basic}`,
      'X-Sec-CentralFuncionarioVersao': VERSAO_CENTRAL,
      'Accept-Language': 'pt-BR',
      pragma: 'no-cache',
      'cache-control': 'no-cache',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private async chamar(endpoint: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(this.url(endpoint), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err: any) {
      throw new Error(`Sem resposta do servidor do ponto (${err?.name === 'TimeoutError' ? 'tempo esgotado' : err?.message}).`)
    }
  }

  async verificarBanco(): Promise<boolean> {
    const r = await this.chamar('/Login/VerificarBancoValido/', { headers: { 'X-Sec-CentralFuncionarioVersao': VERSAO_CENTRAL } })
    if (!r.ok) throw new Error(`Falha ao verificar o banco do ponto (HTTP ${r.status}).`)
    return JSON.parse((await r.text()) || 'false') === true
  }

  // Mesmo login que a tela faz. Só é usado se a API recusar o Basic direto
  // (401) — alguns bancos podem exigir o login antes da primeira consulta.
  private async login(): Promise<void> {
    const r = await this.chamar('/Login', {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        usuario: this.cred.numero.trim(),
        senha: this.cred.senha,
        plataformaLogin: 1, // Web
        UsuarioAutenticacao: this.cred.tipo === 'identificador' ? 1 : 0,
        identificacaoDispositivo: this.dispositivo,
      }),
    })
    if (r.status === 400 || r.status === 401) throw new PontoAuthError('Número ou senha do ponto inválidos.')
    if (!r.ok) throw new Error(`Login no ponto falhou (HTTP ${r.status}).`)
  }

  async pontoDiario(data: string): Promise<LinhaPontoApi[]> {
    const buscar = () => this.chamar(`/Batidas/${data}`, { headers: this.headers() })
    let r = await buscar()
    if (r.status === 401) {
      await this.login()
      r = await buscar()
      if (r.status === 401) throw new PontoAuthError('Número ou senha do ponto inválidos.')
    }
    if (!r.ok) throw new Error(`Ponto de ${data}: HTTP ${r.status} ${r.statusText}`)
    let json: RespostaPontoDiario
    try {
      json = JSON.parse((await r.text()) || '{}')
    } catch {
      throw new Error(`Ponto de ${data}: resposta inválida (não é JSON) — o servidor do ponto pode estar em manutenção.`)
    }
    if (!Array.isArray(json.lista)) throw new Error(`Ponto de ${data}: resposta sem "lista" — a API pode ter mudado.`)
    return json.lista
  }

  /** Pro botão "Testar login": banco existe e dá pra ler o ponto de hoje. */
  async testar(hoje: string): Promise<string> {
    if (!(await this.verificarBanco())) throw new Error(`Banco ${this.cred.banco} não encontrado no Secullum.`)
    const lista = await this.pontoDiario(hoje)
    return `Login ok — ${lista.length} colaborador(es) no acompanhamento de hoje.`
  }
}
