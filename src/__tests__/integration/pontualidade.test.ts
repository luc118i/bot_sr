// Relatório de pontualidade: retrato de cada conferência (planos reais do
// cenário padrão), classificação e o histórico em pontualidade.json.
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { classificarRegistro, contar, csvPontualidade, montarRelatorio, registrosDoPlano, type RegistroPontualidade } from '../../core/pontualidade'
import { decidir } from '../../core/planner'
import { consultarPontualidade, registrarPontualidade } from '../../pontualidade'
import { salvarRelatorio, simular } from '../../service'
import { cenario, definirRegras, htmlFixture, NOITE, regrasCenario } from '../helpers/planilha'
import { getDataDir, getRelatoriosDir } from '../../logger'

const planoDoCenario = () => simular(cenario(), { data: '2026-09-28', html: htmlFixture(), now: NOITE })
const porNome = <T extends { nome: string }>(regs: T[], trecho: string) => regs.find(r => r.nome.includes(trecho))!

function limpar() {
  fs.rmSync(path.join(getDataDir(), 'pontualidade.json'), { force: true })
  fs.rmSync(getRelatoriosDir(), { recursive: true, force: true })
  fs.rmSync(path.join(getDataDir(), 'planilha-cache.json'), { force: true })
}

describe('pontualidade: classificação a partir do plano', () => {
  it('cada situação do cenário vira a classe certa, com a diferença em minutos', async () => {
    const regs = registrosDoPlano(await planoDoCenario()).map(r => classificarRegistro(r, 15))
    const c = (n: string) => porNome(regs, n)

    assert.deepEqual([c('JOAO').classe, c('JOAO').diferencaMin], ['pontual', -2])
    assert.deepEqual([c('PEDRO').classe, c('PEDRO').diferencaMin], ['pontual', 5])     // tolerância inclusiva
    assert.deepEqual([c('MARCOS').classe, c('MARCOS').diferencaMin], ['atraso', 36])   // individual 07:30 + 10
    assert.equal(c('MARCOS').origem, 'horário individual (item 2)')
    assert.deepEqual([c('PAULO').classe, c('PAULO').motivoCurto], ['pendente', 'Sem ponto registrado'])
    assert.deepEqual([c('ANDRE').classe, c('ANDRE').motivoCurto], ['ausencia', 'Férias'])
    assert.deepEqual([c('LUIZ').classe, c('LUIZ').motivoCurto], ['divergente', 'Planilha "FO" × ponto "."'])
    assert.equal(c('LUIZ').diferencaMin, -30) // diverge tem prioridade sobre "adiantado"
    assert.deepEqual([c('RENATO').classe, c('RENATO').motivoCurto], ['ausencia', 'Atestado médico']) // forçado, fora do ponto
    // Outros setores (fora do ponto, sem código forçado) não entram.
    assert.ok(!regs.some(r => /SERGIO|NELSON/.test(r.nome)))
  })

  it('"adiantado a partir de" muda só a fronteira pontual/adiantado', () => {
    const base: RegistroPontualidade = { data: '2026-09-28', adm: '1', nome: 'X', nomePonto: 'X', entrada: '07:45', previsto: '08:00', toleranciaMin: 5, origem: 'padrão', codigo: '.', codigoBot: '.', situacao: 'confere', motivo: '' }
    assert.equal(classificarRegistro(base, 15).classe, 'pontual')   // exatamente 15 antes
    assert.equal(classificarRegistro(base, 14).classe, 'adiantado')
    assert.equal(classificarRegistro({ ...base, entrada: '08:06', codigo: 'P' }, 15).classe, 'atraso')
  })

  it('atraso do relatório = "P" do bot, para qualquer entrada e tolerância', () => {
    for (let tol = 0; tol <= 20; tol += 5) {
      for (let m = 6 * 60; m <= 11 * 60; m += 7) {
        const entrada = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
        const bot = decidir({ nome: 'X', icone: 'verde', status: 'batido', entrada1: entrada, textos: [] }, { entradaMin: 8 * 60, toleranciaMin: tol, origem: 'padrão' })
        const r = classificarRegistro({ data: '2026-09-28', adm: '1', nome: 'X', nomePonto: 'X', entrada, previsto: '08:00', toleranciaMin: tol, origem: 'padrão', codigo: bot.codigo!, codigoBot: bot.codigo, situacao: 'escrever', motivo: '' }, 15)
        assert.equal(r.classe === 'atraso', bot.codigo === 'P', `${entrada} tol ${tol}`)
      }
    }
  })

  it('% de pontualidade conta só quem bateu ponto; agregados e filtros', async () => {
    const regs = registrosDoPlano(await planoDoCenario()).map(r => classificarRegistro(r, 15, r.adm === '76' ? 'Expedição' : 'Logística'))
    const c = contar(regs)
    assert.equal(c.atraso, 1)
    assert.equal(c.pontualidadePct, Math.round(1000 * (c.pontual + c.adiantado) / (c.pontual + c.adiantado + c.atraso)) / 10)

    const rel = montarRelatorio(regs, { classe: 'atraso' })
    assert.deepEqual(rel.registros.map(r => r.adm), ['76'])
    assert.deepEqual(rel.contagem, c) // indicadores ignoram o filtro de situação (eles são o seletor)
    assert.equal(rel.minutosAtraso, 36)
    assert.deepEqual(rel.porDia.map(d => [d.chave, d.contagem.pontualidadePct]), [['2026-09-28', c.pontualidadePct]]) // taxa: idem
    assert.deepEqual(rel.colaboradores.map(x => x.adm), ['76']) // ranking e motivos seguem o filtro
    assert.deepEqual(rel.porMotivo, [{ motivo: 'Atraso além da tolerância', total: 1 }])
    assert.deepEqual(rel.opcoes.setores, ['Expedição', 'Logística']) // opções vêm do histórico todo, não do filtro
    assert.equal(montarRelatorio(regs, { busca: 'marcos fictício' }).registros.length, 1) // sem acento, parcial
    assert.equal(montarRelatorio(regs, { setor: 'Expedição' }).registros.length, 1)
    assert.equal(montarRelatorio(regs, { inicio: '2026-09-29' }).registros.length, 0)
    assert.equal(montarRelatorio(regs, {}).colaboradores[0]!.adm, '76') // ranking: quem tem mais ocorrências primeiro…
    assert.equal(montarRelatorio(regs, {}).colaboradores[0]!.minutosAtraso, 36)
  })
})

describe('pontualidade: exportação CSV', () => {
  it('Excel pt-BR: BOM, ";" e aspas onde precisa, data dd/mm/aaaa', async () => {
    const regs = registrosDoPlano(await planoDoCenario()).map(r => classificarRegistro(r, 15, 'Setor; com ponto e vírgula'))
    const csv = csvPontualidade(regs)
    assert.ok(csv.startsWith('﻿Data;Colaborador;ADM;Setor;Previsto;Realizado;Diferença (min)'))
    const linhas = csv.trim().split('\r\n')
    assert.equal(linhas.length, regs.length + 1)
    const marcos = linhas.find(l => l.includes('MARCOS'))!
    assert.match(marcos, /^28\/09\/2026;MARCOS FICTICIO PEREIRA;76;"Setor; com ponto e vírgula";07:30;08:06;36;10;Atraso;Atraso além da tolerância;P;/)
    assert.match(linhas.find(l => l.includes('LUIZ'))!, /;"Planilha ""FO"" × ponto ""\.""";/) // aspas dobradas
  })
})

describe('pontualidade: histórico em disco', () => {
  beforeEach(limpar)

  it('primeira leitura importa os relatórios antigos; depois cada conferência substitui o dia', async () => {
    const plano = await planoDoCenario()
    salvarRelatorio(plano, 'escrita', { escritas: [], puladas: [] })
    salvarRelatorio({ ...plano, data: '2026-09-29' }, 'ferias', { escritas: [], puladas: [] }) // férias não é retrato do ponto

    const r1 = consultarPontualidade()
    assert.deepEqual(r1.cobertura, { primeiro: '2026-09-28', ultimo: '2026-09-28', dias: 1 })
    assert.equal(r1.contagem.atraso, 1)
    assert.ok(fs.existsSync(path.join(getDataDir(), 'pontualidade.json')))

    // O operador justifica o "sem ponto" como AT e o dia é registrado de novo.
    const paulo = plano.itens.find(i => i.nomePlanilha?.includes('PAULO'))!
    Object.assign(paulo, { situacao: 'justificado', codigo: 'AT', valorAtual: 'AT' })
    registrarPontualidade([plano])
    const r2 = consultarPontualidade({ adm: paulo.adm! })
    assert.deepEqual(r2.registros.map(r => [r.classe, r.motivoCurto]), [['ausencia', 'Atestado médico']])
    assert.equal(consultarPontualidade().cobertura.dias, 1) // substituiu, não duplicou
  })

  it('setor vem da BASE DE DADOS guardada; "adiantado" vem das regras', async () => {
    fs.writeFileSync(path.join(getDataDir(), 'planilha-cache.json'), JSON.stringify({ colaboradores: [{ adm: '374', nome: 'JOAO', setor: 'Expedição', ativo: true }], feriados: [], quando: '' }))
    registrarPontualidade([await planoDoCenario()]) // o cenário grava as regras padrão…
    definirRegras({ ...regrasCenario(), geral: { ...regrasCenario().geral, adiantado_min: '1' } }) // …e só depois mudamos
    const r = consultarPontualidade({ setor: 'Expedição' })
    assert.equal(r.adiantadoMin, 1)
    assert.deepEqual(r.registros.map(x => [x.adm, x.classe]), [['374', 'adiantado']]) // 07:58 é 2 min antes
    definirRegras(regrasCenario())
  })

  it('arquivo corrompido não derruba: recomeça a partir dos relatórios', () => {
    fs.writeFileSync(path.join(getDataDir(), 'pontualidade.json'), '{ quebrado')
    assert.equal(consultarPontualidade().contagem.total, 0)
  })
})
