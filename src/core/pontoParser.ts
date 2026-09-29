import * as cheerio from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import { normalize } from './normalize'

// Tela "acompanhamento de ponto" do centraldofuncionario.com.br — app React
// Native Web. As classes (r-1k9400p...) são geradas no build e mudam sem aviso,
// então NÃO são usadas como seletor. Âncoras estáveis:
//   1. o ícone de status de cada linha: data-testid="exclamation-circle" (vermelho)
//      ou "check-circle" (verde);
//   2. a posição: o nome vem logo depois do ícone, e os horários (Entrada 1,
//      Saída 1, ..., Saída 3) e o saldo vêm no bloco seguinte.
// A "linha" de um colaborador é o maior ancestral do ícone que ainda contém SÓ
// aquele ícone — funciona sem conhecer a profundidade exata da árvore.

export type PontoStatus = 'batido' | 'sem_registro' | 'ferias' | 'desconhecido'

export interface PontoRegistro {
  nome: string            // como veio do ponto, só com trim
  icone: 'vermelho' | 'verde'
  status: PontoStatus
  entrada1: string | null // "HH:MM"
  textos: string[]        // textos da linha, em ordem — vai pro relatório pra depurar
}

export interface ResultadoParse {
  registros: PontoRegistro[]
  avisos: string[]
}

const ICON_SELECTOR = '[data-testid="exclamation-circle"], [data-testid="check-circle"]'
const HORA_RE = /^\d{1,2}:\d{2}$/
const SEM_REGISTRO = 'NENHUM PONTO REGISTRADO'
const FERIAS = 'FERIAS'

export function parsePontoHtml(html: string): ResultadoParse {
  const $ = cheerio.load(html)
  const avisos: string[] = []
  const registros: PontoRegistro[] = []

  const icones = $(ICON_SELECTOR).toArray()
  if (icones.length === 0) {
    return {
      registros,
      avisos: [
        'Nenhum ícone de status (data-testid "exclamation-circle"/"check-circle") encontrado no HTML — ' +
        'o arquivo é mesmo a tela de acompanhamento de ponto, salva depois de carregar a lista?',
      ],
    }
  }

  for (const icone of icones) {
    const linha = subirAteLinha($, icone)
    const textos = coletarTextos($, linha)
    const iconeCor = $(icone).attr('data-testid') === 'check-circle' ? 'verde' : 'vermelho'

    const idxNome = textos.findIndex(t => /[A-Za-zÀ-ÿ]{2}/.test(t) && !ehMarcador(t))
    if (idxNome === -1) {
      avisos.push(`Linha sem nome reconhecível ignorada: ${JSON.stringify(textos).slice(0, 200)}`)
      continue
    }
    const nome = textos[idxNome]!.trim()
    const resto = textos.slice(idxNome + 1)
    const restoNorm = resto.map(normalize)

    let status: PontoStatus
    let entrada1: string | null = null

    if (restoNorm.some(t => t.includes(SEM_REGISTRO))) {
      status = 'sem_registro'
    } else if (restoNorm.some(t => t === FERIAS)) {
      status = 'ferias'
    } else {
      // Primeiro horário SEM sinal depois do nome = Entrada 1. O saldo fica no
      // fim da linha e costuma vir com sinal ("-07:57"); como ele é o último
      // item, mesmo sem sinal só seria confundido se não houvesse nenhuma
      // batida — caso em que o ponto mostra "Nenhum ponto registrado".
      const primeiraHora = resto.find(t => HORA_RE.test(t.trim()))
      if (primeiraHora) {
        status = 'batido'
        entrada1 = padHora(primeiraHora.trim())
      } else {
        status = 'desconhecido'
      }
    }

    registros.push({ nome, icone: iconeCor, status, entrada1, textos })
  }

  const vistos = new Map<string, number>()
  for (const r of registros) {
    const k = normalize(r.nome)
    vistos.set(k, (vistos.get(k) ?? 0) + 1)
  }
  for (const [nome, n] of vistos) {
    if (n > 1) avisos.push(`"${nome}" aparece ${n} vezes no ponto — vai para revisão.`)
  }

  return { registros, avisos }
}

function subirAteLinha($: cheerio.CheerioAPI, icone: Element): Element {
  let atual: Element = icone
  for (;;) {
    const pai = atual.parent
    if (!pai || pai.type !== 'tag') return atual
    if ($(pai).find(ICON_SELECTOR).length > 1) return atual
    atual = pai as Element
  }
}

function coletarTextos($: cheerio.CheerioAPI, raiz: Element): string[] {
  const out: string[] = []
  const walk = (n: AnyNode) => {
    if (n.type === 'text') {
      const t = (n as any).data.replace(/\s+/g, ' ').trim()
      if (t) out.push(t)
      return
    }
    if (n.type === 'tag' || n.type === 'root') {
      const tag = (n as Element).name
      if (tag === 'script' || tag === 'style' || tag === 'svg') return
      for (const c of (n as Element).children ?? []) walk(c)
    }
  }
  walk(raiz)
  return out
}

function ehMarcador(t: string): boolean {
  const n = normalize(t)
  return n === FERIAS || n.includes(SEM_REGISTRO) || HORA_RE.test(t.trim())
}

function padHora(h: string): string {
  const [a, b] = h.split(':')
  return `${a!.padStart(2, '0')}:${b}`
}
