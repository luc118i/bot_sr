import type { Codigo } from './codigos'
import { codigoForcado, resolverHorario, type ConfigPlanilha, type HorarioPrevisto } from './configPlanilha'
import type { LayoutMes, LinhaColaborador } from './layoutMes'
import { Matcher, type BaseColaborador } from './matcher'
import type { PontoRegistro } from './pontoParser'
import { colunaA1, diaDaSemana, formatHora, hojeISO, parseDataISO, parseHora } from './tempo'

// Monta o PLANO do dia: o que seria escrito e o que fica pra revisão. Não
// escreve nada — a escrita (executarEscrita em service.ts) só aplica um plano
// já gerado, depois de o operador ver o relatório. Dry-run é o padrão.
//
// Proteções do plano (inegociáveis):
//   - célula já preenchida NUNCA entra em `escritas` (protege FO, AT, AC, S...
//     lançados à mão, sem regra especial por código) → rodar de novo o mesmo
//     dia é idempotente;
//   - sem ponto registrado NUNCA vira 'F' — vai pra revisão;
//   - qualquer dúvida de match (ambíguo, não achado) → revisão.

export type Situacao =
  | 'escrever'          // célula vazia + código decidido → será escrita
  | 'confere'           // célula já tem exatamente o código que o bot calcularia
  | 'divergente'        // célula já tem OUTRO código — não mexe, mas mostra
  | 'ja_lancado'        // célula preenchida e o bot não teria decidido nada
  | 'revisar'           // célula vazia e o bot não decide (sem ponto, formato desconhecido...)
  | 'ambiguo'
  | 'sem_linha_no_mes'
  | 'nao_encontrado'
  | 'ausente_no_ponto'  // linha da planilha sem ninguém correspondente no ponto

export interface ItemPlano {
  situacao: Situacao
  nomePonto: string | null
  adm: string | null
  nomePlanilha: string | null
  linha: number | null
  celula: string | null
  valorAtual: string
  codigo: Codigo | null
  motivo: string
  ponto: Pick<PontoRegistro, 'status' | 'entrada1' | 'icone'> | null
  horario: { previsto: string; toleranciaMin: number; origem: string } | null
}

export interface Escrita { celula: string; linha: number; coluna: number; codigo: Codigo }

export interface Plano {
  data: string
  aba: string
  geradoEm: string
  escritas: Escrita[]
  itens: ItemPlano[]
  avisos: string[]
  resumo: Record<Situacao, number>
}

export interface EntradaPlano {
  data: string
  registros: PontoRegistro[]
  layout: LayoutMes
  grid: string[][]
  cfg: ConfigPlanilha
  base?: BaseColaborador[]
  now?: Date
  forcar?: boolean
}

// Só depois do fim do expediente o dia pode ser classificado: um saldo
// negativo de manhã é só saldo parcial. Datas futuras, domingos e feriados
// também param aqui (a não ser com `forcar`).
export function validarData(data: string, cfg: ConfigPlanilha, now: Date, forcar: boolean): string[] {
  const d = parseDataISO(data)
  const hoje = hojeISO(now)
  const avisos: string[] = []
  const bloquear = (msg: string) => {
    if (!forcar) throw new Error(`${msg} (use "forçar" se tiver certeza)`)
    avisos.push(`FORÇADO: ${msg}`)
  }

  if (data > hoje) throw new Error(`A data ${data} está no futuro.`)
  if (data === hoje) {
    const corte = cfg.geral.horarioCorteMin
    const agora = now.getHours() * 60 + now.getMinutes()
    if (corte === null) bloquear('É o dia de hoje e CONFIG_GERAL não tem "horario_corte" — não dá pra saber se o expediente acabou.')
    else if (agora < corte) bloquear(`Ainda são ${formatHora(agora)}; o dia só pode ser classificado depois de ${formatHora(corte)} (horario_corte).`)
  }
  if (diaDaSemana(d) === 0) bloquear(`${data} é domingo — pela regra da planilha fica em branco.`)
  if (cfg.feriados.has(data)) bloquear(`${data} está em CONFIG_FERIADOS — pela regra da planilha fica em branco.`)
  return avisos
}

export function decidir(reg: PontoRegistro, h: HorarioPrevisto): { codigo: Codigo | null; motivo: string } {
  switch (reg.status) {
    case 'ferias':
      return { codigo: 'FE', motivo: 'Ponto mostra FÉRIAS' }
    case 'sem_registro':
      return { codigo: null, motivo: 'Nenhum ponto registrado — pode ser folga, atestado ou falta; só uma pessoa sabe' }
    case 'desconhecido':
      return { codigo: null, motivo: `Formato da linha do ponto não reconhecido: ${reg.textos.join(' | ').slice(0, 160)}` }
    case 'batido': {
      const ent = parseHora(reg.entrada1)
      if (ent === null) return { codigo: null, motivo: `Entrada 1 ilegível ("${reg.entrada1}")` }
      const limite = h.entradaMin + h.toleranciaMin
      return ent <= limite
        ? { codigo: '.', motivo: `Entrada ${reg.entrada1} ≤ ${formatHora(limite)} (${formatHora(h.entradaMin)} + ${h.toleranciaMin} min)` }
        : { codigo: 'P', motivo: `Entrada ${reg.entrada1} > ${formatHora(limite)} (${formatHora(h.entradaMin)} + ${h.toleranciaMin} min) — atraso de ${ent - limite} min além da tolerância` }
    }
  }
}

export function montarPlano(e: EntradaPlano): Plano {
  const now = e.now ?? new Date()
  const { layout, grid, cfg, data } = e
  const avisos = [...cfg.avisos, ...layout.avisos, ...validarData(data, cfg, now, !!e.forcar)]

  const dia = parseDataISO(data).dia
  const col = layout.colunaDoDia.get(dia)
  if (!col) throw new Error(`[${layout.aba}] Sem coluna para o dia ${dia}.`)

  const valor = (linha: number) => String(grid[linha - 1]?.[col - 1] ?? '')
  const celula = (linha: number) => `${colunaA1(col)}${linha}`
  const matcher = new Matcher(layout.linhas, cfg.apelidos, e.base)

  const itens: ItemPlano[] = []
  const porLinha = new Map<number, ItemPlano[]>()

  const itemBase = (l: LinhaColaborador | null, nomePonto: string | null): ItemPlano => ({
    situacao: 'revisar',
    nomePonto,
    adm: l?.adm ?? null,
    nomePlanilha: l?.nome ?? null,
    linha: l?.linha ?? null,
    celula: l ? celula(l.linha) : null,
    valorAtual: l ? valor(l.linha) : '',
    codigo: null,
    motivo: '',
    ponto: null,
    horario: null,
  })

  for (const reg of e.registros) {
    const m = matcher.resolver(reg.nome)
    const ponto = { status: reg.status, entrada1: reg.entrada1, icone: reg.icone }

    if (m.tipo !== 'ok') {
      const it = itemBase(null, reg.nome)
      it.ponto = ponto
      if (m.tipo === 'ambiguo') {
        it.situacao = 'ambiguo'
        it.motivo = `Mais de uma linha possível: ${m.candidatos.map(c => `linha ${c.linha} (ADM ${c.adm})`).join(', ')}`
      } else if (m.tipo === 'sem_linha_no_mes') {
        it.situacao = 'sem_linha_no_mes'
        it.adm = m.adm
        it.motivo = `ADM ${m.adm} (via ${m.via === 'base' ? 'BASE DE DADOS' : 'CONFIG_APELIDOS'}) não tem linha na aba ${layout.aba}`
      } else {
        it.situacao = 'nao_encontrado'
        it.motivo = m.sugestao
          ? `Não achado. Possível: ADM ${m.sugestao.adm} "${m.sugestao.nome}" — se for, cadastre em CONFIG_APELIDOS`
          : 'Nome não encontrado na aba do mês nem na BASE DE DADOS'
      }
      itens.push(it)
      continue
    }

    const it = itemBase(m.linha, reg.nome)
    it.ponto = ponto
    const h = resolverHorario(cfg, m.linha.adm, data)
    it.horario = { previsto: formatHora(h.entradaMin), toleranciaMin: h.toleranciaMin, origem: h.origem }

    const forcado = codigoForcado(cfg, m.linha.adm, data)
    const dec = forcado
      ? { codigo: forcado.codigoForcado, motivo: `Código forçado em CONFIG_EXCECOES linha ${forcado.linha}` }
      : decidir(reg, h)
    it.codigo = dec.codigo
    it.motivo = (m.via === 'apelido' ? '[via CONFIG_APELIDOS] ' : '') + dec.motivo
    classificar(it)
    itens.push(it)
    porLinha.set(m.linha.linha, [...(porLinha.get(m.linha.linha) ?? []), it])
  }

  // Duas pessoas do ponto caindo na mesma linha → nenhuma escreve.
  for (const [linha, its] of porLinha) {
    if (its.length > 1) {
      for (const it of its) {
        it.situacao = 'ambiguo'
        it.motivo = `${its.length} registros do ponto caíram na linha ${linha}: ${its.map(i => `"${i.nomePonto}"`).join(', ')}`
      }
    }
  }

  // Código forçado pra quem nem aparece no ponto (ex.: atestado já conhecido).
  const vistos = new Set(porLinha.keys())
  for (const l of layout.linhas) {
    if (vistos.has(l.linha)) continue
    const it = itemBase(l, null)
    const forcado = codigoForcado(cfg, l.adm, data)
    if (forcado) {
      it.codigo = forcado.codigoForcado
      it.motivo = `Código forçado em CONFIG_EXCECOES linha ${forcado.linha} (não aparece no ponto)`
      classificar(it)
    } else {
      it.situacao = it.valorAtual.trim() ? 'ja_lancado' : 'ausente_no_ponto'
      it.motivo = 'Não aparece no HTML do ponto'
    }
    itens.push(it)
  }

  // Não escreve em coluna com ADM repetido na aba (aviso já vem do layout).
  const admCount = new Map<string, number>()
  for (const l of layout.linhas) admCount.set(l.adm, (admCount.get(l.adm) ?? 0) + 1)
  for (const it of itens) {
    if (it.situacao === 'escrever' && it.adm && (admCount.get(it.adm) ?? 0) > 1) {
      it.situacao = 'ambiguo'
      it.motivo = `ADM ${it.adm} aparece em mais de uma linha da aba`
    }
  }

  const escritas: Escrita[] = itens
    .filter(i => i.situacao === 'escrever')
    .map(i => ({ celula: i.celula!, linha: i.linha!, coluna: col, codigo: i.codigo! }))

  const resumo = Object.fromEntries(
    (['escrever', 'confere', 'divergente', 'ja_lancado', 'revisar', 'ambiguo', 'sem_linha_no_mes', 'nao_encontrado', 'ausente_no_ponto'] as Situacao[])
      .map(s => [s, itens.filter(i => i.situacao === s).length]),
  ) as Record<Situacao, number>

  return { data, aba: layout.aba, geradoEm: now.toISOString(), escritas, itens, avisos, resumo }
}

// Célula já preenchida (qualquer coisa não-branca, até " ." ou "-") nunca é
// sobrescrita — só classificamos pra o relatório mostrar se bate ou não.
function classificar(it: ItemPlano) {
  const atual = it.valorAtual.trim()
  if (!atual && it.valorAtual.length > 0) {
    it.situacao = 'ja_lancado'
    it.motivo += ' [célula contém só espaços — não mexo; apague-a se quiser que o bot preencha]'
    return
  }
  if (!atual) {
    it.situacao = it.codigo ? 'escrever' : 'revisar'
    return
  }
  if (!it.codigo) { it.situacao = 'ja_lancado'; return }
  it.situacao = atual.toUpperCase() === it.codigo ? 'confere' : 'divergente'
}
