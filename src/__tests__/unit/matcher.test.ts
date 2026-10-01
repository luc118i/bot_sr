import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Matcher, semelhancaNomes } from '../../core/matcher'
import type { LinhaColaborador } from '../../core/layoutMes'

const L = (linha: number, adm: string, nome: string): LinhaColaborador => ({ linha, adm, nome })

describe('Matcher', () => {
  const linhas = [
    L(8, '374', 'JOÃO EXEMPLO DA SILVA'),
    L(9, '2376', 'PEDRO TESTE DE ARAUJO'),
    L(10, '1417', 'RAIMUNDO DAS NEVES PRADO DOS'),
    L(11, '50', 'MARIA HOMONIMA'),
    L(12, '51', 'MARIA HOMONIMA'),
    L(13, '60', 'ADM REPETIDO UM'),
    L(14, '60', 'ADM REPETIDO DOIS'),
  ]

  it('casa pelo nome normalizado (acento, caixa, espaço sobrando)', () => {
    const m = new Matcher(linhas, []).resolver('joao exemplo da silva ')
    assert.equal(m.tipo, 'ok')
    assert.equal(m.tipo === 'ok' && m.linha.linha, 8)
    assert.equal(m.tipo === 'ok' && m.via, 'nome')
  })

  it('apelido tem prioridade sobre o nome', () => {
    const m = new Matcher(linhas, [{ nomePonto: 'PEDRO TESTE DE ARAUJO', adm: '374' }]).resolver('Pedro Teste de Araujo')
    assert.equal(m.tipo === 'ok' && m.linha.adm, '374')
    assert.equal(m.tipo === 'ok' && m.via, 'apelido')
  })

  it('apelido pra ADM sem linha no mês → sem_linha_no_mes (via apelido)', () => {
    assert.deepEqual(new Matcher(linhas, [{ nomePonto: 'FULANO', adm: '9' }]).resolver('fulano'), { tipo: 'sem_linha_no_mes', adm: '9', via: 'apelido' })
  })

  it('apelido pra ADM repetido na aba → ambíguo', () => {
    const m = new Matcher(linhas, [{ nomePonto: 'X', adm: '60' }]).resolver('x')
    assert.equal(m.tipo, 'ambiguo')
    assert.equal(m.tipo === 'ambiguo' && m.candidatos.length, 2)
  })

  it('homônimos → ambíguo, nunca escolhe um', () => {
    const m = new Matcher(linhas, []).resolver('MARIA HOMONIMA')
    assert.equal(m.tipo, 'ambiguo')
  })

  it('nome único mas com ADM repetido na aba → ambíguo', () => {
    const m = new Matcher(linhas, []).resolver('ADM REPETIDO UM')
    assert.equal(m.tipo, 'ambiguo')
    assert.deepEqual(m.tipo === 'ambiguo' && m.candidatos.map(c => c.linha), [13, 14])
  })

  it('na BASE mas sem linha no mês → sem_linha_no_mes (via base)', () => {
    assert.deepEqual(new Matcher(linhas, [], [{ adm: '9999', nome: 'Felipe Semlinha' }]).resolver('FELIPE SEMLINHA'),
      { tipo: 'sem_linha_no_mes', adm: '9999', via: 'base' })
  })

  it('homônimo na BASE não decide nada → não encontrado', () => {
    const base = [{ adm: '1', nome: 'ZE' }, { adm: '2', nome: 'ZE' }]
    assert.equal(new Matcher(linhas, [], base).resolver('ZE').tipo, 'nao_encontrado')
  })

  it('nome truncado vira SUGESTÃO, nunca match', () => {
    const m = new Matcher(linhas, []).resolver('RAIMUNDO DAS NEVES PRADO DOS SANTOS')
    assert.equal(m.tipo, 'nao_encontrado')
    assert.equal(m.tipo === 'nao_encontrado' && m.sugestao?.adm, '1417')
  })

  it('prefixo curto demais não sugere (evita "JOAO" → qualquer JOAO)', () => {
    const m = new Matcher([L(8, '1', 'JOAO')], []).resolver('JOAO PEDRO DA SILVA')
    assert.deepEqual(m, { tipo: 'nao_encontrado', sugestao: null })
  })

  it('sugestão é o mais parecido; empate → sem sugestão', () => {
    const ls = [L(8, '1', 'FRANCISCO DE ASSIS PEREIRA'), L(9, '2', 'FRANCISCO DE ASSIS PEREIRA LIMA')]
    const m = new Matcher(ls, []).resolver('FRANCISCO DE ASSIS PEREIRA LIMA SOUZA')
    assert.equal(m.tipo === 'nao_encontrado' && m.sugestao?.adm, '2')
    const empate = new Matcher([L(8, '1', 'ANA LIMA COSTA'), L(9, '2', 'ANA LIMA SOUZA')], []).resolver('ANA LIMA')
    assert.deepEqual(empate, { tipo: 'nao_encontrado', sugestao: null })
  })

  it('linha sem nome não casa com nome vazio do ponto nem vira sugestão', () => {
    const m = new Matcher([L(8, '1', '')], []).resolver('ALGUEM COM NOME BEM COMPRIDO')
    assert.deepEqual(m, { tipo: 'nao_encontrado', sugestao: null })
  })
})

describe('semelhancaNomes (palavra por palavra)', () => {
  const pct = (a: string, b: string) => Math.round(semelhancaNomes(a, b) * 100)

  it('nome cortado na planilha: 3 de 4 palavras = 75%', () => {
    assert.equal(pct('RAIMUNDO DAS NEVES PRADO DOS SANTOS', 'RAIMUNDO DAS NEVES PRADO DOS'), 75)
  })

  it('partículas (de, da, dos, e) não contam', () => {
    assert.equal(pct('PEDRO TESTE DE ARAUJO', 'PEDRO TESTE ARAUJO'), 100)
    assert.equal(pct('ANA E SILVA', 'ANA SILVA'), 100)
  })

  it('erro de digitação em sobrenome conta como igual (inclusive letras trocadas de lugar)', () => {
    assert.equal(pct('MARCOS FICTICIO PEREIRA', 'MARCOS FICTICIO PERERIA'), 100)
    assert.equal(pct('ANDRE SOUZA', 'ANDRE SOUSA'), 100)
  })

  it('sobrenome DIFERENTE não é erro de digitação: JOAO SILVA × JOAO SOUZA = 50%', () => {
    assert.equal(pct('JOAO SILVA', 'JOAO SOUZA'), 50)
  })

  it('primeiro nome tem que ser IGUAL (MARIA × MARIO, FRANCISCO × FRANCISCA são outras pessoas)', () => {
    assert.equal(pct('MARIA SOUZA', 'MARIO SOUZA'), 0)
    assert.equal(pct('FRANCISCO LIMA', 'FRANCISCA LIMA'), 0)
    assert.equal(pct('ANA PAULA COSTA', 'PAULA COSTA'), 0)
  })

  it('acento, caixa e espaço não importam; vazio = 0', () => {
    assert.equal(pct(' joão  da silva ', 'JOAO SILVA'), 100)
    assert.equal(pct('', 'JOAO'), 0)
  })

  it('é simétrica', () => {
    for (const [a, b] of [['RAIMUNDO NEVES PRADO SANTOS', 'RAIMUNDO NEVES PRADO'], ['ANA LIMA', 'ANA LIMA COSTA SOUZA']]) {
      assert.equal(semelhancaNomes(a!, b!), semelhancaNomes(b!, a!))
    }
  })
})

describe('Matcher.parecido (≥ 70%, só um candidato, só linhas livres)', () => {
  const linhas = [
    L(8, '1417', 'RAIMUNDO DAS NEVES PRADO DOS'),
    L(9, '20', 'JOAO SOUZA'),
    L(10, '30', 'ANA LIMA COSTA'),
    L(11, '31', 'ANA LIMA SOUZA'),
    L(12, '40', 'CARLOS ROCHA MELO'),
    L(13, '40', 'CARLOS ROCHA MELO FILHO'),
  ]
  const m = new Matcher(linhas, [])

  it('casa o nome cortado e diz a semelhança', () => {
    const r = m.parecido('RAIMUNDO DAS NEVES PRADO DOS SANTOS', new Set())
    assert.equal(r?.tipo === 'ok' && r.linha.adm, '1417')
    assert.equal(r?.tipo === 'ok' && r.via, 'parecido')
    assert.equal(r?.tipo === 'ok' && r.semelhanca, 0.75)
  })

  it('abaixo de 70% não casa (JOAO SILVA não vira JOAO SOUZA)', () => {
    assert.equal(m.parecido('JOAO SILVA', new Set()), null)
  })

  it('dois candidatos ≥ 70% → não escolhe nenhum', () => {
    // × "ANA LIMA COSTA" = 3/4 e × "ANA LIMA SOUZA" = 3/4: os dois passam de 70% → revisão.
    assert.equal(semelhancaNomes('ANA LIMA COSTA SOUZA', 'ANA LIMA COSTA'), 0.75)
    assert.equal(semelhancaNomes('ANA LIMA COSTA SOUZA', 'ANA LIMA SOUZA'), 0.75)
    assert.equal(m.parecido('ANA LIMA COSTA SOUZA', new Set()), null)
  })

  it('linha já ocupada por um match exato não entra na disputa', () => {
    assert.equal(m.parecido('RAIMUNDO DAS NEVES PRADO DOS SANTOS', new Set([8])), null)
  })

  it('candidato único mas com ADM repetido na aba → ambíguo', () => {
    const r = new Matcher([L(12, '40', 'CARLOS ROCHA MELO'), L(13, '40', 'PAULO ALVES')], []).parecido('CARLOS ROCHA MELO FILHO', new Set())
    assert.equal(r?.tipo, 'ambiguo')
  })

  it('apelido cadastrado com o nome da PLANILHA (cortado) também vale pro nome completo do ponto', () => {
    const comApelido = new Matcher([L(8, '1417', 'OUTRO NOME NA ABA')], [{ nomePonto: 'FRANCISCO DAS CHAGAS PRADO DOS', adm: '1417' }])
    const r = comApelido.resolver('FRANCISCO DAS CHAGAS PRADO DOS SANTOS')
    assert.equal(r.tipo === 'ok' && r.via, 'apelido')
    assert.equal(r.tipo === 'ok' && r.linha.linha, 8)
  })
})
