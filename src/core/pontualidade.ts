import { CODIGOS, type Codigo } from './codigos'
import type { ItemPlano, Plano, Situacao } from './planner'
import { parseHora } from './tempo'

// Relatório de pontualidade. A fonte são os PLANOS que o bot já monta a cada
// conferência — nada é recalculado do zero: entrada batida, horário previsto,
// tolerância e de onde ela veio são exatamente os que decidiram "." ou "P".
//
// Um registro guarda só FATOS do dia (o que o ponto e a planilha diziam). A
// classe (pontual, atraso, adiantado…) é derivada na leitura — assim mudar o
// "adiantado a partir de" em Horários e regras vale também para o histórico,
// enquanto atraso continua usando a tolerância que valia naquele dia.

export interface RegistroPontualidade {
  data: string
  adm: string | null
  nome: string
  nomePonto: string | null
  entrada: string | null      // 1ª batida "HH:MM"
  previsto: string | null
  toleranciaMin: number | null
  origem: string | null       // padrão / horário individual / exceção
  codigo: string              // o que ficou (ou vai ficar) na planilha; '' = nada
  codigoBot: string | null    // o que o bot calcularia — difere de `codigo` na divergência
  situacao: Situacao
  motivo: string
}

// Quem não aparece no ponto (outro setor) não entra: não há o que medir.
export function registrosDoPlano(p: Plano): RegistroPontualidade[] {
  return p.itens.filter(i => i.situacao !== 'ausente_no_ponto').map(i => ({
    data: p.data,
    adm: i.adm,
    nome: i.nomePlanilha || i.nomePonto || '?',
    nomePonto: i.nomePonto,
    entrada: i.ponto?.entrada1 ?? null,
    previsto: i.horario?.previsto ?? null,
    toleranciaMin: i.horario?.toleranciaMin ?? null,
    origem: i.horario?.origem ?? null,
    codigo: codigoFinal(i),
    codigoBot: i.codigo,
    situacao: i.situacao,
    motivo: i.motivo,
  }))
}

/** O código que está (ou vai ficar) na planilha pra este item; '' = nada. */
export function codigoFinal(i: ItemPlano): string {
  if (i.situacao === 'escrever' || i.situacao === 'confere' || i.situacao === 'justificado') return i.codigo ?? ''
  if (i.situacao === 'ja_lancado' || i.situacao === 'divergente') return i.valorAtual.trim().toUpperCase()
  return ''
}

// ── Classificação ───────────────────────────────────────────────────────────

export type Classe = 'pontual' | 'atraso' | 'adiantado' | 'divergente' | 'ausencia' | 'pendente'
export const CLASSES: Classe[] = ['pontual', 'atraso', 'adiantado', 'divergente', 'ausencia', 'pendente']
export const ROTULO_CLASSE: Record<Classe, string> = {
  pontual: 'Pontual',
  atraso: 'Atraso',
  adiantado: 'Adiantado',
  divergente: 'Divergente', // mesmo sentido do resto do app: a planilha tem outro código
  ausencia: 'Ausência justificada',
  pendente: 'Pendente',
}

const AUSENCIAS = new Set<string>(['F', 'FE', 'FO', 'AT', 'AC', 'S', 'V'])

export interface RegistroClassificado extends RegistroPontualidade {
  classe: Classe
  diferencaMin: number | null // entrada − previsto (negativo = chegou antes)
  motivoCurto: string         // agrupável: alimenta o filtro e o gráfico de motivos
  setor: string
}

export function classificarRegistro(r: RegistroPontualidade, adiantadoMin: number, setor = ''): RegistroClassificado {
  const ent = parseHora(r.entrada), prev = parseHora(r.previsto)
  const diferencaMin = ent !== null && prev !== null ? ent - prev : null
  let classe: Classe
  let motivoCurto = ''
  if (r.situacao === 'divergente') {
    classe = 'divergente'
    motivoCurto = `Planilha "${r.codigo}" × ponto "${r.codigoBot ?? '?'}"`
  } else if (diferencaMin !== null) {
    // Mesma regra do planner (decidir): atraso só além da tolerância do dia.
    if (diferencaMin > (r.toleranciaMin ?? 0)) { classe = 'atraso'; motivoCurto = 'Atraso além da tolerância' }
    else if (diferencaMin < -adiantadoMin) { classe = 'adiantado'; motivoCurto = 'Entrada antecipada' }
    else classe = 'pontual'
  } else if (AUSENCIAS.has(r.codigo)) {
    classe = 'ausencia'
    motivoCurto = CODIGOS[r.codigo as Codigo]
  } else {
    classe = 'pendente'
    motivoCurto = r.situacao === 'nao_encontrado' ? 'Nome não encontrado'
      : r.situacao === 'ambiguo' ? 'Correspondência ambígua'
      : r.situacao === 'sem_linha_no_mes' ? 'Sem linha no mês'
      : /^Formato/.test(r.motivo) ? 'Ponto em formato desconhecido'
      : 'Sem ponto registrado'
  }
  return { ...r, classe, diferencaMin, motivoCurto, setor }
}

// ── Filtros e agregados ─────────────────────────────────────────────────────

export interface FiltrosPontualidade {
  inicio?: string
  fim?: string
  busca?: string    // nome (planilha ou ponto) ou ADM, parcial, sem acento
  adm?: string
  setor?: string
  classe?: Classe
  motivo?: string
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

export function filtrar(regs: RegistroClassificado[], f: FiltrosPontualidade): RegistroClassificado[] {
  const busca = f.busca ? semAcento(f.busca.trim()) : ''
  return regs.filter(r =>
    (!f.inicio || r.data >= f.inicio)
    && (!f.fim || r.data <= f.fim)
    && (!f.adm || r.adm === f.adm)
    && (!f.setor || r.setor === f.setor)
    && (!f.classe || r.classe === f.classe)
    && (!f.motivo || r.motivoCurto === f.motivo)
    && (!busca || semAcento(`${r.nome} ${r.nomePonto ?? ''} ${r.adm ?? ''}`).includes(busca)))
}

export type Contagem = Record<Classe, number> & { total: number; pontualidadePct: number | null }

/** % de pontualidade = (pontual + adiantado) ÷ quem bateu ponto (pontual + adiantado + atraso). */
export function contar(regs: RegistroClassificado[]): Contagem {
  const c = Object.fromEntries(CLASSES.map(k => [k, 0])) as Record<Classe, number>
  for (const r of regs) c[r.classe]++
  const comPonto = c.pontual + c.adiantado + c.atraso
  return { ...c, total: regs.length, pontualidadePct: comPonto ? Math.round(1000 * (c.pontual + c.adiantado) / comPonto) / 10 : null }
}

export function agrupar(regs: RegistroClassificado[], chave: (r: RegistroClassificado) => string): { chave: string; contagem: Contagem }[] {
  const grupos = new Map<string, RegistroClassificado[]>()
  for (const r of regs) { const k = chave(r); grupos.set(k, [...(grupos.get(k) ?? []), r]) }
  return [...grupos].map(([k, rs]) => ({ chave: k, contagem: contar(rs) }))
}

export interface ResumoColaborador {
  adm: string | null
  nome: string
  setor: string
  contagem: Contagem
  ocorrencias: number        // atraso + divergente + pendente
  minutosAtraso: number      // soma dos minutos além do previsto nos atrasos
}

export function porColaborador(regs: RegistroClassificado[]): ResumoColaborador[] {
  const grupos = new Map<string, RegistroClassificado[]>()
  for (const r of regs) { const k = r.adm ?? `?${r.nome}`; grupos.set(k, [...(grupos.get(k) ?? []), r]) }
  return [...grupos.values()].map(rs => {
    const c = contar(rs)
    const ult = rs.reduce((a, b) => (b.data > a.data ? b : a))
    return {
      adm: ult.adm, nome: ult.nome, setor: ult.setor, contagem: c,
      ocorrencias: c.atraso + c.divergente + c.pendente,
      minutosAtraso: rs.filter(r => r.classe === 'atraso').reduce((s, r) => s + (r.diferencaMin ?? 0), 0),
    }
  }).sort((a, b) => b.ocorrencias - a.ocorrencias || b.minutosAtraso - a.minutosAtraso || a.nome.localeCompare(b.nome))
}

// CSV pro Excel em pt-BR: ";" como separador, BOM pra acentos, data dd/mm/aaaa.
export function csvPontualidade(regs: RegistroClassificado[]): string {
  const cel = (v: string | number | null) => {
    const s = v === null ? '' : String(v)
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const linhas = [
    ['Data', 'Colaborador', 'ADM', 'Setor', 'Previsto', 'Realizado', 'Diferença (min)', 'Tolerância (min)', 'Situação', 'Motivo', 'Código na planilha', 'Origem do horário', 'Nome no ponto'],
    ...regs.map(r => [
      r.data.split('-').reverse().join('/'), r.nome, r.adm, r.setor, r.previsto, r.entrada, r.diferencaMin, r.toleranciaMin,
      ROTULO_CLASSE[r.classe], r.motivoCurto, r.codigo, r.origem, r.nomePonto,
    ]),
  ]
  return '﻿' + linhas.map(l => l.map(cel).join(';')).join('\r\n') + '\r\n'
}

export interface RelatorioPontualidade {
  registros: RegistroClassificado[]
  // Os indicadores ignoram o filtro de SITUAÇÃO: eles são o próprio seletor —
  // escolher "Atrasos" não pode zerar os outros nem a % de pontualidade.
  contagem: Contagem
  minutosAtraso: number
  porDia: { chave: string; contagem: Contagem }[]
  porSetor: { chave: string; contagem: Contagem }[]
  porMotivo: { motivo: string; total: number }[]
  colaboradores: ResumoColaborador[]
  cobertura: { primeiro: string | null; ultimo: string | null; dias: number }
  opcoes: { setores: string[]; motivos: string[]; colaboradores: { adm: string; nome: string }[] }
}

/** Tudo que a tela precisa, de uma vez. `todos` = histórico inteiro (pras opções e a cobertura). */
export function montarRelatorio(todos: RegistroClassificado[], f: FiltrosPontualidade): RelatorioPontualidade {
  const regs = filtrar(todos, f).sort((a, b) => b.data.localeCompare(a.data) || a.nome.localeCompare(b.nome))
  const motivos = new Map<string, number>()
  for (const r of regs) if (r.motivoCurto) motivos.set(r.motivoCurto, (motivos.get(r.motivoCurto) ?? 0) + 1)
  const dias = [...new Set(todos.map(r => r.data))].sort()
  const semSituacao = f.classe ? filtrar(todos, { ...f, classe: undefined }) : regs
  return {
    registros: regs,
    contagem: contar(semSituacao),
    minutosAtraso: semSituacao.filter(r => r.classe === 'atraso').reduce((s, r) => s + (r.diferencaMin ?? 0), 0),
    // Pontualidade por dia/setor também é taxa: ignora o filtro de situação como os indicadores.
    porDia: agrupar(semSituacao, r => r.data).sort((a, b) => a.chave.localeCompare(b.chave)),
    porSetor: agrupar(semSituacao, r => r.setor || 'Sem setor').sort((a, b) => b.contagem.total - a.contagem.total),
    porMotivo: [...motivos].map(([motivo, total]) => ({ motivo, total })).sort((a, b) => b.total - a.total),
    colaboradores: porColaborador(regs),
    cobertura: { primeiro: dias[0] ?? null, ultimo: dias[dias.length - 1] ?? null, dias: dias.length },
    opcoes: {
      setores: [...new Set(todos.map(r => r.setor).filter(Boolean))].sort(),
      motivos: [...new Set(todos.map(r => r.motivoCurto).filter(Boolean))].sort(),
      colaboradores: [...new Map(todos.filter(r => r.adm).map(r => [r.adm!, { adm: r.adm!, nome: r.nome }])).values()].sort((a, b) => a.nome.localeCompare(b.nome)),
    },
  }
}
