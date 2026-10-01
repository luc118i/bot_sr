// fetch global substituído durante um teste: cada chamada passa por `responder`
// e fica registrada em `pedidos`. Sempre restaure com `restaurar()` (finally).
export interface PedidoFetch {
  url: string
  metodo: string
  headers: Record<string, string>
  corpo: any
}

export function instalarFetch(responder: (p: PedidoFetch, n: number) => Response | Promise<Response>) {
  const original = globalThis.fetch
  const pedidos: PedidoFetch[] = []
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit | undefined).entries())
    let corpo: any = init.body ?? null
    if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo) } catch { /* texto puro */ } }
    const p = { url: String(url), metodo: init.method ?? 'GET', headers, corpo }
    pedidos.push(p)
    return responder(p, pedidos.length)
  }) as typeof fetch
  return { pedidos, restaurar: () => { globalThis.fetch = original } }
}

export const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
