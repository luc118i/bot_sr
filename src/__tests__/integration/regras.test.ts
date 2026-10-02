// Tela "Horários e regras": arquivo local regras.json, nunca a planilha.
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import {
  cacheDaPlanilha, carregarConfigLocal, carregarRegras, dadosDaPlanilha, lerColaboradores, lerRegrasLocais, regrasDaTela, salvarRegras, validarRegras,
  type RegrasEditaveis,
} from '../../regras'
import { simular } from '../../service'
import { caminhoRegrasTeste, cenario, definirRegras, htmlFixture, MemoryGateway, NOITE, preenchidas, regrasCenario } from '../helpers/planilha'

const geralOk = { tolerancia_min: '5', entrada_padrao: '08:00', horario_corte: '18:00' }
const horario = (o: Partial<RegrasEditaveis['horarios'][number]>) =>
  ({ adm: '1', entrada: '08:00', saida: '', tolerancia_min: '', vigencia_inicio: '', vigencia_fim: '', obs: '', ...o })

const arqCache = () => path.join(process.env['DATA_DIR']!, 'planilha-cache.json')
beforeEach(() => fs.rmSync(arqCache(), { force: true }))

describe('abertura rápida da tela (regras na hora, planilha depois)', () => {
  it('regrasDaTela não chama a planilha e já traz a última lista guardada', async () => {
    const gw = cenario()
    assert.equal(regrasDaTela().cache, null)
    await dadosDaPlanilha(gw, '2026-09-29')
    const chamadasAntes = gw.leituras
    const r = regrasDaTela()
    assert.equal(gw.leituras, chamadasAntes)
    assert.equal(r.regras.geral.entrada_padrao, '08:00')
    assert.deepEqual(r.cache!.colaboradores.map(c => c.adm), ['9999'])
    assert.deepEqual(r.cache!.feriados.map(f => [f.aba, f.dias]), [['Setembro', [7]], ['Outubro', [12]]])
  })

  it('as leituras da planilha vão em paralelo (não uma depois da outra)', async () => {
    const gw = cenario()
    let abertas = 0, maximo = 0
    const lento = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A) => {
      abertas++; maximo = Math.max(maximo, abertas)
      await new Promise(r => setTimeout(r, 30))
      try { return await fn(...a) } finally { abertas-- }
    }
    gw.lerGrid = lento(gw.lerGrid.bind(gw))
    gw.colunasOcultas = lento(gw.colunasOcultas.bind(gw))
    await dadosDaPlanilha(gw, '2026-09-29')
    // BASE DE DADOS + (grade + colunas ocultas) de dois meses = 5 leituras juntas.
    assert.equal(maximo, 5)
  })

  it('cache corrompido é ignorado (a tela abre sem lista e busca de novo)', () => {
    fs.writeFileSync(arqCache(), '{ quebrado')
    assert.equal(cacheDaPlanilha(), null)
    fs.writeFileSync(arqCache(), JSON.stringify({ colaboradores: 'x' }))
    assert.equal(cacheDaPlanilha(), null)
  })

  it('planilha fora do ar: dadosDaPlanilha falha e o cache antigo continua lá', async () => {
    const gw = cenario()
    await dadosDaPlanilha(gw, '2026-09-29')
    gw.listarAbas = async () => { throw new Error('sem rede') }
    await assert.rejects(dadosDaPlanilha(gw), /sem rede/)
    assert.deepEqual(cacheDaPlanilha()!.colaboradores.map(c => c.adm), ['9999'])
  })

  it('salvar usa a lista em cache pra conferir ADMs, sem ir de novo à planilha', async () => {
    const gw = cenario()
    await dadosDaPlanilha(gw, '2026-09-29')
    gw.listarAbas = async () => { throw new Error('não devia chamar') }
    gw.lerGrid = async () => { throw new Error('não devia chamar') }
    const v = await salvarRegras(regrasCenario(), gw)
    assert.deepEqual(v.erros, [])
    assert.match(v.avisos.join('\n'), /ADM 76 não existe na BASE DE DADOS/)
  })
})

describe('salvar e carregar', () => {
  it('salvam no arquivo local, nunca na planilha, e a simulação passa a usar', async () => {
    const gw = cenario()
    const planilhaAntes = preenchidas(gw)
    const abasAntes = await gw.listarAbas()
    const { regras, arquivo } = await carregarRegras(gw)
    assert.equal(arquivo, caminhoRegrasTeste())
    assert.equal(regras.geral.entrada_padrao, '08:00')

    regras.horarios.push(horario({ adm: '2376', entrada: '09:00', vigencia_inicio: '2026-09-01', obs: 'entra 9h' }))
    const v = await salvarRegras(regras, gw)
    assert.deepEqual(v.erros, [])
    assert.equal(JSON.parse(fs.readFileSync(caminhoRegrasTeste(), 'utf-8')).horarios.at(-1).obs, 'entra 9h')
    assert.ok(fs.existsSync(caminhoRegrasTeste().replace(/\.json$/, '.anterior.json')))
    assert.deepEqual(await gw.listarAbas(), abasAntes)
    assert.deepEqual(preenchidas(gw), planilhaAntes)
    assert.deepEqual(gw.escritas, [])

    const plano = await simular(gw, { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    const pedro = plano.itens.find(i => i.adm === '2376')!
    assert.equal(pedro.horario!.previsto, '09:00')
    assert.match(pedro.horario!.origem, /horário individual/)
  })

  it('a cópia .anterior.json é a versão de ANTES do salvamento', async () => {
    const gw = cenario()
    const antes = fs.readFileSync(caminhoRegrasTeste(), 'utf-8')
    const { regras } = await carregarRegras(gw)
    regras.geral.tolerancia_min = '9'
    await salvarRegras(regras, gw)
    assert.equal(fs.readFileSync(caminhoRegrasTeste().replace(/\.json$/, '.anterior.json'), 'utf-8'), antes)
  })

  it('bloqueia salvamento inválido e o arquivo fica como estava', async () => {
    const gw = cenario()
    const antes = fs.readFileSync(caminhoRegrasTeste(), 'utf-8')
    const { regras } = await carregarRegras(gw)

    regras.excecoes.push({ data: '2026-09-30', adm: '374', entrada_prevista: '', codigo: 'XX', obs: '' })
    let v = await salvarRegras(regras, gw)
    assert.match(v.erros.join('\n'), /código "XX"/)

    regras.excecoes.pop()
    regras.horarios.push(horario({ adm: '76', entrada: '06:00', vigencia_inicio: '2026-09-20' }))
    v = await salvarRegras(regras, gw)
    assert.match(v.erros.join('\n'), /ADM 76: dois horários/)

    regras.horarios.pop()
    regras.geral.entrada_padrao = ''
    v = await salvarRegras(regras, gw)
    assert.match(v.erros.join('\n'), /entrada padrão/)
    assert.equal(fs.readFileSync(caminhoRegrasTeste(), 'utf-8'), antes)
  })

  it('tela abre sem planilha configurada; simulação sem regras explica o que fazer', async () => {
    definirRegras(regrasCenario())
    const r = await carregarRegras(null)
    assert.equal(r.regras.geral.entrada_padrao, '08:00')
    assert.deepEqual(r.colaboradores, [])

    const gw = cenario()
    fs.rmSync(caminhoRegrasTeste())
    await assert.rejects(simular(gw, { data: '2026-09-28', html: htmlFixture(), now: NOITE }), /Horários e regras/)
  })

  it('planilha fora do ar: tela abre do mesmo jeito, com aviso', async () => {
    definirRegras(regrasCenario())
    const gw = cenario()
    gw.listarAbas = async () => { throw new Error('sem rede') }
    const r = await carregarRegras(gw)
    assert.equal(r.regras.geral.entrada_padrao, '08:00')
    assert.match(r.avisos[0]!, /sem rede/)
  })

  it('planilha fora do ar não impede salvar (só não confere ADMs)', async () => {
    const gw = cenario()
    gw.listarAbas = async () => { throw new Error('sem rede') }
    const r = regrasCenario()
    r.horarios.push(horario({ adm: '123456', vigencia_inicio: '2027-01-01' }))
    const v = await salvarRegras(r, gw)
    assert.deepEqual(v, { erros: [], avisos: [] })
  })

  it('setores escolhidos são salvos e voltam ao abrir; lixo é filtrado', async () => {
    const gw = cenario()
    const { regras } = await carregarRegras(gw)
    assert.deepEqual(regras.setores, [])
    regras.setores = ['Guará - Pisos', 'Distribuição']
    assert.deepEqual((await salvarRegras(regras, gw)).erros, [])
    assert.deepEqual((await carregarRegras(gw)).regras.setores, ['Guará - Pisos', 'Distribuição'])

    fs.writeFileSync(caminhoRegrasTeste(), JSON.stringify({ ...regrasCenario(), setores: ['A', '', '  ', 3, null] }))
    assert.deepEqual(lerRegrasLocais()!.setores, ['A'])
  })

  it('arquivo de regras corrompido → erro claro com o caminho (não "regras vazias")', () => {
    fs.writeFileSync(caminhoRegrasTeste(), '{ quebrado')
    assert.throws(() => lerRegrasLocais(), /Não deu pra ler .*regras\.json/)
    assert.throws(() => carregarConfigLocal(), /regras\.json/)
  })

  it('arquivo antigo sem campos novos ganha os padrões', () => {
    fs.writeFileSync(caminhoRegrasTeste(), JSON.stringify({ geral: { entrada_padrao: '08:00' } }))
    const r = lerRegrasLocais()!
    assert.deepEqual(r.geral, { tolerancia_min: '', entrada_padrao: '08:00', horario_corte: '', adiantado_min: '' })
    assert.deepEqual([r.horarios, r.excecoes, r.apelidos], [[], [], []])
  })

  it('overrides da CLI dispensam o arquivo', () => {
    fs.rmSync(caminhoRegrasTeste(), { force: true })
    assert.throws(() => carregarConfigLocal(), /não configuradas/)
    assert.equal(carregarConfigLocal({ entradaPadrao: '07:00', toleranciaMin: 0 }).geral.entradaPadraoMin, 420)
  })

  it('feriados do mês atual e do próximo (colunas ocultas que não são domingo)', async () => {
    const r = await carregarRegras(cenario(), '2026-09-29')
    assert.deepEqual(r.feriados, [{ aba: 'Setembro', dias: [7], erro: null }, { aba: 'Outubro', dias: [12], erro: null }])
  })

  it('feriados: dezembro olha janeiro do ano seguinte; aba faltando vira erro só dela', async () => {
    const r = await carregarRegras(cenario(), '2026-12-10')
    assert.deepEqual(r.feriados.map(f => f.aba), ['Dezembro', 'Janeiro'])
    assert.ok(r.feriados.every(f => /não encontrada/.test(f.erro ?? '')))
  })
})

describe('validarRegras', () => {
  const v = (r: Partial<RegrasEditaveis>, colabs: { adm: string; nome: string; setor: string; ativo: boolean }[] = []) =>
    validarRegras({ geral: geralOk, horarios: [], excecoes: [], apelidos: [], ...r }, colabs)

  it('avisa ADM que não existe na BASE DE DADOS (sem bloquear)', () => {
    const r = v({ horarios: [horario({ adm: '123456', entrada: '09:00' })] }, [{ adm: '1', nome: 'X', setor: '', ativo: true }])
    assert.deepEqual(r.erros, [])
    assert.match(r.avisos[0]!, /123456/)
  })

  it('ADM com formatos diferentes ("12.0", " 12 ") é o mesmo da BASE', () => {
    const r = v({ apelidos: [{ nome_no_ponto: 'X', adm: '12.0', obs: '' }] }, [{ adm: '12', nome: 'X', setor: '', ativo: true }])
    assert.deepEqual(r.avisos, [])
  })

  it('vigências que se tocam no mesmo dia se sobrepõem; dia seguinte não', () => {
    const toca = v({ horarios: [horario({ vigencia_fim: '2026-09-15' }), horario({ vigencia_inicio: '2026-09-15' })] })
    assert.match(toca.erros.join(), /dois horários/)
    const encaixa = v({ horarios: [horario({ vigencia_fim: '2026-09-15' }), horario({ vigencia_inicio: '2026-09-16' })] })
    assert.deepEqual(encaixa.erros, [])
  })

  it('dois horários sem vigência pro mesmo ADM se sobrepõem', () => {
    assert.match(v({ horarios: [horario({}), horario({ entrada: '09:00' })] }).erros.join(), /dois horários/)
  })

  it('ADMs diferentes não conflitam', () => {
    assert.deepEqual(v({ horarios: [horario({ adm: '1' }), horario({ adm: '2' })] }).erros, [])
  })

  it('vigência inválida bloqueia o salvamento', () => {
    assert.match(v({ horarios: [horario({ vigencia_inicio: '31/02/2026' })] }).erros.join(), /vigência/)
  })

  it('tolerância individual inválida bloqueia o salvamento', () => {
    assert.match(v({ horarios: [horario({ tolerancia_min: 'dez' })] }).erros.join(), /tolerância/)
  })

  it('exceção com data inexistente bloqueia o salvamento', () => {
    assert.match(v({ excecoes: [{ data: '2026-02-30', adm: '1', entrada_prevista: '09:00', codigo: '', obs: '' }] }).erros.join(), /item 1/)
  })

  const exc = (o: Partial<RegrasEditaveis['excecoes'][number]>) =>
    ({ data: '', adm: '1', entrada_prevista: '', codigo: '', obs: '', recorrente: 'sempre', ...o })

  it('exceção permanente: salva sem data; duas entradas ou dois códigos pro mesmo ADM bloqueiam', () => {
    assert.deepEqual(v({ excecoes: [exc({ entrada_prevista: '09:00' })] }).erros, [])
    assert.match(v({ excecoes: [exc({ entrada_prevista: '09:00' }), exc({ entrada_prevista: '10:00' })] }).erros.join(), /duas entradas previstas permanentes \(itens 1 e 2\)/)
    assert.match(v({ excecoes: [exc({ codigo: 'FO' }), exc({ codigo: 'AT' })] }).erros.join(), /dois códigos permanentes/)
    // Uma com entrada e outra com código pro mesmo ADM pode.
    assert.deepEqual(v({ excecoes: [exc({ entrada_prevista: '09:00' }), exc({ codigo: 'FO' })] }).erros, [])
  })

  it('exceção permanente + horário individual pro mesmo ADM → aviso (não bloqueia)', () => {
    const r = v({ horarios: [horario({ adm: '1' })], excecoes: [exc({ entrada_prevista: '09:00' })] })
    assert.deepEqual(r.erros, [])
    assert.match(r.avisos.join(), /vale no lugar do horário individual/)
  })

  it('exceção permanente com código "." ou "P" bloqueia o salvamento, explicando', () => {
    assert.match(v({ excecoes: [exc({ entrada_prevista: '09:00', codigo: '.' })] }).erros.join(), /não pode forçar "\."/)
    assert.match(v({ excecoes: [exc({ codigo: 'P' })] }).erros.join(), /não pode forçar "P"/)
    assert.deepEqual(v({ excecoes: [exc({ codigo: 'FO' })] }).erros, []) // folga fixa continua valendo
  })

  it('exceção permanente vazia (sem entrada nem código) bloqueia', () => {
    assert.match(v({ excecoes: [exc({})] }).erros.join(), /não muda nada/)
  })

  it('campos com espaço sobrando são aceitos', () => {
    assert.deepEqual(v({ geral: { tolerancia_min: ' 5 ', entrada_padrao: ' 08:00 ', horario_corte: ' 18:00 ' } }).erros, [])
  })
})

describe('lerColaboradores (BASE DE DADOS)', () => {
  it('lê ADM, nome, setor e status; aceita "Locação" ou "Setor"', async () => {
    const gw = new MemoryGateway({
      'Base de Dados': [
        ['Nº', 'ADM', 'Colaborador', 'Locação', 'Status de Atividade'],
        ['1', '10.0', ' ANA ', 'Pisos', 'Ativo'],
        ['2', '11', 'BIA', 'Pisos', 'DESLIGADO'],
        ['3', '', 'SEM ADM', '', ''],
        ['4', '12', '', '', ''],
      ],
    })
    assert.deepEqual(await lerColaboradores(gw), [
      { adm: '10', nome: 'ANA', setor: 'Pisos', ativo: true },
      { adm: '11', nome: 'BIA', setor: 'Pisos', ativo: false },
    ])
  })

  it('sem aba BASE DE DADOS ou sem colunas obrigatórias → lista vazia', async () => {
    assert.deepEqual(await lerColaboradores(new MemoryGateway({ Setembro: [[]] })), [])
    assert.deepEqual(await lerColaboradores(new MemoryGateway({ 'BASE DE DADOS': [['Nome', 'Setor']] })), [])
  })

  it('sem coluna de status → todos ativos', async () => {
    const gw = new MemoryGateway({ 'BASE DE DADOS': [['ADM', 'COLABORADOR'], ['1', 'A']] })
    assert.equal((await lerColaboradores(gw))[0]!.ativo, true)
  })
})
