import fs from 'fs'
import path from 'path'
import { getDataDir, getRelatoriosDir, logger } from './logger'
import { ADIANTADO_MIN_PADRAO } from './core/configPlanilha'
import type { Plano } from './core/planner'
import {
  classificarRegistro, montarRelatorio, registrosDoPlano,
  type FiltrosPontualidade, type RegistroPontualidade, type RelatorioPontualidade,
} from './core/pontualidade'
import { cacheDaPlanilha, carregarConfigLocal } from './regras'

// Histórico de pontualidade: pontualidade.json, na pasta de dados (só nesta
// máquina, como os relatórios). Um retrato por dia — a conferência mais
// recente do dia substitui a anterior (justificar e conferir de novo também
// atualizam). Na primeira vez, os relatórios .json que o bot já tinha salvo
// viram o histórico inicial.

interface Arquivo { versao: 1; dias: Record<string, { quando: string; registros: RegistroPontualidade[] }> }

const arq = () => path.join(getDataDir(), 'pontualidade.json')

function ler(): Arquivo | null {
  try {
    const a = JSON.parse(fs.readFileSync(arq(), 'utf-8')) as Arquivo
    return a && a.dias && typeof a.dias === 'object' ? a : null
  } catch { return null }
}

function gravar(a: Arquivo): void {
  fs.mkdirSync(path.dirname(arq()), { recursive: true })
  fs.writeFileSync(arq(), JSON.stringify(a), 'utf-8')
}

// Relatórios antigos: por dia, o mais recente entre conferência gravada,
// justificativa e simulação. Férias e "desfeita" não são retrato do ponto.
export function importarRelatorios(): Arquivo {
  const a: Arquivo = { versao: 1, dias: {} }
  const dir = getRelatoriosDir()
  if (!fs.existsSync(dir)) return a
  const candidatos = fs.readdirSync(dir)
    .map(nome => ({ nome, m: /^(\d{4}-\d{2}-\d{2})_(escrita|justificativa|simulacao)_.*\.json$/.exec(nome) }))
    .filter(c => c.m)
    .map(c => ({ ...c, data: c.m![1]!, mtime: fs.statSync(path.join(dir, c.nome)).mtimeMs }))
    .sort((x, y) => x.mtime - y.mtime)
  for (const c of candidatos) {
    try {
      const { plano } = JSON.parse(fs.readFileSync(path.join(dir, c.nome), 'utf-8')) as { plano: Plano }
      if (!plano?.itens || plano.data !== c.data) continue
      a.dias[c.data] = { quando: new Date(c.mtime).toISOString(), registros: registrosDoPlano(plano) }
    } catch { /* relatório corrompido: ignora */ }
  }
  logger.info(`[pontualidade] histórico inicial a partir de ${candidatos.length} relatório(s): ${Object.keys(a.dias).length} dia(s)`)
  return a
}

function carregar(): Arquivo {
  const a = ler()
  if (a) return a
  const novo = importarRelatorios()
  gravar(novo)
  return novo
}

/** Guarda o retrato destes dias (chamado a cada conferência e justificativa). */
export function registrarPontualidade(planos: Plano[], quando = new Date().toISOString()): void {
  if (!planos.length) return
  const a = carregar()
  for (const p of planos) a.dias[p.data] = { quando, registros: registrosDoPlano(p) }
  gravar(a)
}

function adiantadoMin(): number {
  try { return carregarConfigLocal().geral.adiantadoMin } catch { return ADIANTADO_MIN_PADRAO }
}

/** Relatório pronto pra tela: classifica, junta o setor (BASE DE DADOS) e aplica os filtros. */
export function consultarPontualidade(f: FiltrosPontualidade = {}): RelatorioPontualidade & { adiantadoMin: number } {
  const setores = new Map((cacheDaPlanilha()?.colaboradores ?? []).map(c => [c.adm, c.setor]))
  const adi = adiantadoMin()
  const todos = Object.values(carregar().dias)
    .flatMap(d => d.registros)
    .map(r => classificarRegistro(r, adi, (r.adm && setores.get(r.adm)) || ''))
  return { ...montarRelatorio(todos, f), adiantadoMin: adi }
}
