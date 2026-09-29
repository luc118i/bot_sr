import * as cheerio from 'cheerio'
import type { Element } from 'domhandler'
import { normalize } from './normalize'

// Tela "acompanhamento de ponto" do centraldofuncionario.com.br — app React
// Native Web. As classes (r-1k9400p...) são geradas no build e mudam sem aviso,
// então NÃO são usadas como seletor. Estrutura confirmada no HTML real
// (outerHTML de 29/09/2026):
//
//   <div id="dia-resumido-2026-09-29">          ← uma por colaborador (id repetido!)
//     <div dir="auto" data-testid="exclamation-circle|exclamation-triangle|check-circle">  ← ícone
//     <div dir="auto">NOME </div>
//     <div style="flex: 6 1 0%">
//       6 × <div dir="auto">HH:MM ou vazio ou FÉRIAS</div>   ← Entrada 1 … Saída 3
//       (ou 1 × <div dir="auto">Nenhum ponto registrado</div>)
//     </div>
//     <div dir="auto">-08:00</div>               ← saldo (vazio nas férias)
//
// Âncoras: o id "dia-resumido-AAAA-MM-DD" (também diz de QUE DIA é o HTML) e a
// ordem dos <div dir="auto"> que não são o ícone — incluindo os vazios, então
// "Entrada 1" é sempre a célula logo depois do nome, nunca "o primeiro horário
// que aparecer".

export type PontoStatus = 'batido' | 'sem_registro' | 'ferias' | 'desconhecido'
export type PontoIcone = 'vermelho' | 'amarelo' | 'verde' | 'outro'

export interface PontoRegistro {
  nome: string            // como veio do ponto, só com trim
  icone: PontoIcone
  status: PontoStatus
  entrada1: string | null // "HH:MM"
  textos: string[]        // células da linha, em ordem — vai pro relatório pra depurar
}

export interface ResultadoParse {
  data: string | null     // AAAA-MM-DD tirado do id das linhas
  registros: PontoRegistro[]
  avisos: string[]
}

const LINHA_SELECTOR = '[id^="dia-resumido-"]'
const HORA_RE = /^\d{1,2}:\d{2}$/
const SEM_REGISTRO = 'NENHUM PONTO REGISTRADO'
const FERIAS = 'FERIAS'

const ICONES: Record<string, PontoIcone> = {
  'exclamation-circle': 'vermelho',
  'exclamation-triangle': 'amarelo',
  'check-circle': 'verde',
}

export function parsePontoHtml(html: string): ResultadoParse {
  const $ = cheerio.load(html)
  const avisos: string[] = []
  const registros: PontoRegistro[] = []

  const linhas = $(LINHA_SELECTOR).toArray()
  if (linhas.length === 0) {
    return {
      data: null,
      registros,
      avisos: [
        'Nenhuma linha "dia-resumido-…" encontrada no HTML — o arquivo é mesmo a tela de acompanhamento ' +
        'de ponto, copiada (outerHTML) depois de a lista carregar?',
      ],
    }
  }

  const datas = new Set<string>()
  for (const linha of linhas) {
    const m = /^dia-resumido-(\d{4}-\d{2}-\d{2})$/.exec($(linha).attr('id') ?? '')
    if (m) datas.add(m[1]!)

    const iconeEl = $(linha).find('[data-testid]').first()
    const icone = ICONES[iconeEl.attr('data-testid') ?? ''] ?? 'outro'

    const celulas = $(linha).find('[dir="auto"]').toArray()
      .filter(el => !$(el).is('[data-testid]'))
      .map(el => texto($, el))

    const nome = celulas[0] ?? ''
    const resto = celulas.slice(1)
    if (!/[A-Za-zÀ-ÿ]{2}/.test(nome)) {
      avisos.push(`Linha do ponto sem nome reconhecível ignorada: ${JSON.stringify(celulas).slice(0, 200)}`)
      continue
    }

    const restoNorm = resto.map(normalize)
    let status: PontoStatus
    let entrada1: string | null = null

    if (restoNorm.some(t => t.includes(SEM_REGISTRO))) {
      status = 'sem_registro'
    } else if (restoNorm.slice(0, 6).some(t => t === FERIAS)) {
      status = 'ferias'
    } else if (resto.length >= 7 && HORA_RE.test(resto[0]!)) {
      status = 'batido'
      entrada1 = padHora(resto[0]!)
    } else {
      // Ex.: Entrada 1 vazia mas outra batida preenchida, ou estrutura nova.
      status = 'desconhecido'
    }

    registros.push({ nome: nome.trim(), icone, status, entrada1, textos: celulas })
  }

  if (datas.size > 1) avisos.push(`O HTML tem linhas de mais de um dia: ${[...datas].join(', ')}.`)

  const vistos = new Map<string, number>()
  for (const r of registros) {
    const k = normalize(r.nome)
    vistos.set(k, (vistos.get(k) ?? 0) + 1)
  }
  for (const [nome, n] of vistos) {
    if (n > 1) avisos.push(`"${nome}" aparece ${n} vezes no ponto — vai para revisão.`)
  }

  return { data: datas.size === 1 ? [...datas][0]! : null, registros, avisos }
}

function texto($: cheerio.CheerioAPI, el: Element): string {
  return $(el).text().replace(/\s+/g, ' ').trim()
}

function padHora(h: string): string {
  const [a, b] = h.split(':')
  return `${a!.padStart(2, '0')}:${b}`
}
