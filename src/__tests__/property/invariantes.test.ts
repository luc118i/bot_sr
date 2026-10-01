// Testes de propriedade: centenas de planilhas/pontos aleatórios (semente fixa)
// verificando as regras inegociáveis do bot. Uma falha mostra a semente:
//   FUZZ_SEED=<semente> FUZZ_RUNS=1 npm run test:property
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { CODIGOS } from '../../core/codigos'
import { parseConfigPlanilha } from '../../core/configPlanilha'
import { detectarLayout } from '../../core/layoutMes'
import { normalize } from '../../core/normalize'
import { montarPlano, type Plano } from '../../core/planner'
import { parsePontoHtml, type PontoRegistro } from '../../core/pontoParser'
import { registrosDaApi } from '../../core/pontoApi'
import { diasNoMes, parseDataISO, parseHora, toISO } from '../../core/tempo'
import { desfazerEscrita, executarEscrita } from '../../service'
import { chance, hora, htmlPonto, int, nomeFicticio, pick, propriedade, type Rng } from '../helpers/geradores'
import { colDoDia, gridMes, htmlFixture, MemoryGateway, posA1, preenchidas, RAIZ_PROJETO } from '../helpers/planilha'

const CODIGOS_PLANILHA = ['', '', '', '', '.', 'P', 'F', 'FE', 'FO', 'AT', 'AC', ' ', 'x', 'p']

/** Um mundo aleatório: aba do mês, ponto do dia, regras. */
function mundo(r: Rng) {
  const ano = 2026, mes = int(r, 1, 12)
  let dia = int(r, 1, diasNoMes(ano, mes))
  if (new Date(ano, mes - 1, dia).getDay() === 0) dia = dia > 1 ? dia - 1 : dia + 1
  const data = toISO({ ano, mes, dia })

  const pessoas = Array.from({ length: int(r, 1, 25) }, (_, i) => ({ adm: String(chance(r, 0.05) ? 1 : 100 + i), nome: nomeFicticio(r) }))
  const linhas = pessoas.map(p => [p.adm, p.nome, chance(r, 0.4) ? { [dia]: pick(r, CODIGOS_PLANILHA) } : {}] as [string, string, Record<number, string>])
  const grid = gridMes(ano, mes, linhas)
  const layout = detectarLayout('Mes', grid, ano, mes)

  // Ponto: parte de quem está na aba (às vezes com nome mexido), mais estranhos.
  const registros: PontoRegistro[] = []
  for (const p of pessoas) {
    if (!chance(r, 0.7)) continue
    const nome = chance(r, 0.2) ? ` ${p.nome.toLowerCase()} ` : p.nome
    const st = pick(r, ['batido', 'batido', 'batido', 'sem_registro', 'ferias', 'desconhecido'] as const)
    registros.push({ nome, icone: 'verde', status: st, entrada1: st === 'batido' ? (chance(r, 0.05) ? '99:99' : hora(r)) : null, textos: [] })
  }
  for (let i = int(r, 0, 3); i > 0; i--) registros.push({ nome: nomeFicticio(r) + ' X', icone: 'outro', status: 'batido', entrada1: hora(r), textos: [] })
  if (registros.length && chance(r, 0.1)) registros.push({ ...registros[0]! }) // duplicado no ponto

  const adms = pessoas.map(p => p.adm)
  const cfg = parseConfigPlanilha({
    geral: [['tolerancia_min', 'entrada_padrao', 'horario_corte'], [String(int(r, 0, 15)), hora(r), '17:00']],
    horarios: [['adm', 'entrada', 'tolerancia_min'], ...Array.from({ length: int(r, 0, 3) }, () => [pick(r, adms), hora(r), String(int(r, 0, 10))])],
    excecoes: [['data', 'adm', 'entrada_prevista', 'codigo'], ...Array.from({ length: int(r, 0, 3) }, () =>
      [data, pick(r, adms), chance(r, 0.5) ? hora(r) : '', chance(r, 0.5) ? pick(r, ['AT', 'FO', 'F', 'AC']) : ''])],
    apelidos: [['nome_no_ponto', 'adm'], ...(chance(r, 0.3) && registros.length ? [[registros[0]!.nome, pick(r, adms)]] : [])],
  })
  const now = new Date(ano, mes - 1, dia + 1, 8, 0)
  return { data, dia, grid, layout, registros, cfg, now, adms }
}

function plano(m: ReturnType<typeof mundo>): Plano {
  return montarPlano({ data: m.data, registros: m.registros, layout: m.layout, grid: m.grid, cfg: m.cfg, now: m.now })
}

const forcadoF = (m: ReturnType<typeof mundo>, adm: string) => m.cfg.excecoes.some(e => e.adm === adm && e.data === m.data && e.codigoForcado === 'F')

describe('planner: invariantes', () => {
  it('nunca decide "F" sozinho (só exceção explícita do operador)', propriedade('sem F', r => {
    const m = mundo(r)
    for (const e of plano(m).escritas) {
      if (e.codigo === 'F') {
        const linha = m.layout.linhas.find(l => l.linha === e.linha)!
        assert.ok(forcadoF(m, linha.adm), `F na linha ${e.linha} sem exceção`)
      }
    }
  }))

  it('só escreve em célula VAZIA, na coluna do dia, em linha de colaborador, sem repetir célula', propriedade('alvo', r => {
    const m = mundo(r)
    const p = plano(m)
    const col = colDoDia(m.dia)
    const linhas = new Set(m.layout.linhas.map(l => l.linha))
    const vistas = new Set<string>()
    for (const e of p.escritas) {
      assert.equal(e.coluna, col)
      assert.ok(linhas.has(e.linha))
      assert.equal(m.grid[e.linha - 1]![col - 1] ?? '', '', `${e.celula} já tinha "${m.grid[e.linha - 1]![col - 1]}"`)
      assert.ok(!vistas.has(e.celula), `${e.celula} repetida`)
      assert.ok(e.codigo in CODIGOS)
      vistas.add(e.celula)
    }
  }))

  it('ADM repetido na aba nunca recebe escrita', propriedade('adm duplicado', r => {
    const m = mundo(r)
    const cont = new Map<string, number>()
    for (const l of m.layout.linhas) cont.set(l.adm, (cont.get(l.adm) ?? 0) + 1)
    for (const e of plano(m).escritas) {
      const adm = m.layout.linhas.find(l => l.linha === e.linha)!.adm
      assert.equal(cont.get(adm), 1, `escreveu na linha ${e.linha} com ADM ${adm} repetido`)
    }
  }))

  it('duas pessoas do ponto nunca escrevem na mesma linha', propriedade('mesma linha', r => {
    const m = mundo(r)
    const p = plano(m)
    const porLinha = new Map<number, number>()
    for (const i of p.itens) if (i.nomePonto && i.linha) porLinha.set(i.linha, (porLinha.get(i.linha) ?? 0) + 1)
    for (const e of p.escritas) assert.ok((porLinha.get(e.linha) ?? 0) <= 1)
  }))

  it('todo registro do ponto e toda linha da aba aparecem no relatório; o resumo fecha', propriedade('cobertura', r => {
    const m = mundo(r)
    const p = plano(m)
    assert.equal(p.itens.filter(i => i.nomePonto !== null).length, m.registros.length)
    const cobertas = new Set(p.itens.map(i => i.linha))
    for (const l of m.layout.linhas) assert.ok(cobertas.has(l.linha), `linha ${l.linha} sumiu`)
    assert.equal(Object.values(p.resumo).reduce((a, b) => a + b, 0), p.itens.length)
  }))

  it('é idempotente: aplicar o plano e planejar de novo não escreve mais nada', propriedade('idempotência', r => {
    const m = mundo(r)
    const p = plano(m)
    for (const e of p.escritas) m.grid[e.linha - 1]![e.coluna - 1] = e.codigo
    assert.deepEqual(plano(m).escritas, [])
  }))

  it('a decisão "." × "P" respeita entrada + tolerância (limite inclusivo)', propriedade('pontualidade', r => {
    const m = mundo(r)
    for (const i of plano(m).itens) {
      if (!i.horario || i.ponto?.status !== 'batido' || !i.codigo || !['.', 'P'].includes(i.codigo) || /forçado/.test(i.motivo)) continue
      const ent = parseHora(i.ponto.entrada1)!
      const lim = parseHora(i.horario.previsto)! + i.horario.toleranciaMin
      assert.equal(i.codigo, ent <= lim ? '.' : 'P', `${i.ponto.entrada1} vs ${i.horario.previsto}+${i.horario.toleranciaMin}`)
    }
  }))
})

describe('escrita/desfazer: invariantes', () => {
  it('escrever e desfazer sem ninguém mexer devolve a planilha EXATAMENTE como era', propriedade('ida e volta', async r => {
    const m = mundo(r)
    const gw = new MemoryGateway({ Mes: m.grid.map(l => [...l]) })
    const antes = preenchidas(gw)
    const p = plano(m)
    const w = await executarEscrita(gw, { ...p, aba: 'Mes' })
    assert.equal(w.escritas.length, p.escritas.length)
    await desfazerEscrita(gw, 'Mes', w.escritas)
    assert.deepEqual(preenchidas(gw), antes)
  }, 100))

  it('desfazer nunca apaga célula que alguém mudou depois', propriedade('respeita edição', async r => {
    const m = mundo(r)
    const gw = new MemoryGateway({ Mes: m.grid.map(l => [...l]) })
    const w = await executarEscrita(gw, { ...plano(m), aba: 'Mes' })
    const mexidas = new Map<string, string>()
    for (const e of w.escritas) if (chance(r, 0.3)) {
      const novo = pick(r, ['AT', 'FO', 'x'].filter(v => v !== e.codigo))
      const [lin, col] = posA1(e.celula)
      gw.abas['Mes']![lin]![col] = novo
      mexidas.set(e.celula, novo)
    }
    const d = await desfazerEscrita(gw, 'Mes', w.escritas)
    for (const [cel, v] of mexidas) {
      assert.ok(!d.apagadas.includes(cel))
      assert.deepEqual(await gw.lerCelulas('Mes', [cel]), [v])
    }
  }, 100))
})

describe('leitores do ponto: robustez', () => {
  it('HTML sintético aleatório: nunca lança; status/entrada coerentes; data vem do id', propriedade('parser', r => {
    const data = '2026-09-28'
    const linhas = Array.from({ length: int(r, 0, 15) }, () => {
      const tipo = int(r, 0, 3)
      return {
        nome: nomeFicticio(r),
        icone: pick(r, ['vermelho', 'amarelo', 'verde', 'outro', 'nenhum'] as const),
        semRegistro: tipo === 0,
        celulas: tipo === 1 ? Array(6).fill('FÉRIAS') : Array.from({ length: 6 }, (_, i) => (i === 0 && tipo === 3 ? '' : chance(r, 0.6) ? hora(r) : '')),
      }
    })
    const res = parsePontoHtml(htmlPonto(data, linhas))
    assert.equal(res.registros.length, linhas.length)
    if (linhas.length) assert.equal(res.data, data)
    for (const reg of res.registros) {
      if (reg.status === 'batido') assert.match(reg.entrada1!, /^\d{2}:\d{2}$/)
      else assert.equal(reg.entrada1, null)
    }
  }))

  it('HTML real corrompido aleatoriamente: nunca lança', propriedade('parser corrompido', r => {
    const base = htmlFixture()
    let h = base
    for (let i = int(r, 1, 30); i > 0; i--) {
      const p = int(r, 0, h.length)
      h = chance(r, 0.5) ? h.slice(0, p) + h.slice(p + int(r, 1, 200)) : h.slice(0, p) + pick(r, ['<', '>', '"', '</div>', '<div dir="auto">', '\u0000']) + h.slice(p)
    }
    const res = parsePontoHtml(h)
    for (const reg of res.registros) assert.ok(['batido', 'sem_registro', 'ferias', 'desconhecido'].includes(reg.status))
  }, 300))

  it('API com campos aleatórios/faltando: nunca lança', propriedade('api', r => {
    const lista = Array.from({ length: int(r, 0, 10) }, () => ({
      funcionarioNome: chance(r, 0.9) ? nomeFicticio(r) : (pick(r, [null, '', 3]) as any),
      data: '',
      batidas: chance(r, 0.8) ? Array.from({ length: int(r, 0, 8) }, () => (chance(r, 0.9) ? { valor: pick(r, [hora(r), '', 'FÉRIAS', null, 'ATESTADO']) } : null)) as any : undefined,
      situacao: chance(r, 0.8) ? int(r, -1, 5) : undefined,
    }))
    const { registros } = registrosDaApi(lista)
    for (const reg of registros) assert.equal(reg.status === 'batido', reg.entrada1 !== null)
  }))
})

describe('comando: robustez', () => {
  const { interpretarComando } = require(path.join(RAIZ_PROJETO, 'src', 'renderer', 'comando.js'))
  const PALAVRAS = ['preencher', 'conferir', 'semana', 'passada', 'ontem', 'hoje', 'anteontem', 'segunda', 'sábado', 'simular',
    'sem gravar', '31/12', '29/02', '01/01/26', '15/07/2026', '99/99', 'de', 'o', 'dia', '/', '0/0', 'regra', 'desfazer']

  it('frases aleatórias: nunca lança, nunca devolve data futura ou inválida', propriedade('comando', r => {
    const hoje = toISO({ ano: int(r, 2025, 2028), mes: int(r, 1, 12), dia: int(r, 1, 28) })
    const frase = Array.from({ length: int(r, 0, 6) }, () => pick(r, PALAVRAS)).join(' ')
    const res = interpretarComando(frase, hoje)
    assert.ok(typeof res.acao === 'string')
    if (res.data) {
      assert.doesNotThrow(() => parseDataISO(res.data), `${frase} → ${res.data}`)
      assert.ok(res.data <= hoje, `${frase} (hoje ${hoje}) → ${res.data}`)
    }
  }, 500))
})

describe('normalize: propriedades', () => {
  it('idempotente e sem acento/minúscula/espaço duplo', propriedade('normalize', r => {
    const s = Array.from({ length: int(r, 0, 40) }, () => String.fromCharCode(int(r, 32, 0x24f))).join('')
    const n = normalize(s)
    assert.equal(normalize(n), n)
    assert.doesNotMatch(n, /[̀-ͯ]| {2}|^\s|\s$/)
  }, 500))
})
