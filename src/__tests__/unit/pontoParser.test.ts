import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePontoHtml } from '../../core/pontoParser'
import { normalize } from '../../core/normalize'
import { htmlFixture } from '../helpers/planilha'
import { htmlPonto } from '../helpers/geradores'

const seis = (...h: string[]) => [...h, '', '', '', '', '', ''].slice(0, 6)

describe('parsePontoHtml: fixture com a marcação real', () => {
  it('lê os estados do ponto pela estrutura (dia-resumido + posição)', () => {
    const { data, registros, avisos } = parsePontoHtml(htmlFixture())
    assert.deepEqual(avisos, [])
    assert.equal(data, '2026-09-28')
    const por = Object.fromEntries(registros.map(r => [normalize(r.nome), r]))
    assert.equal(registros.length, 9)
    assert.equal(por['JOAO EXEMPLO DA SILVA']!.status, 'batido')
    assert.equal(por['JOAO EXEMPLO DA SILVA']!.entrada1, '07:58')
    // Triângulo amarelo (entrada + saída de almoço) — era ignorado pela primeira versão.
    assert.equal(por['JOAO EXEMPLO DA SILVA']!.icone, 'amarelo')
    assert.equal(por['LUIZ EXCECAO OLIVEIRA']!.entrada1, '09:30')
    assert.equal(por['PEDRO TESTE DE ARAUJO']!.entrada1, '08:05')
    assert.equal(por['PAULO MODELO DA SILVA']!.status, 'sem_registro')
    assert.equal(por['ANDRE JOSE DE EXEMPLO']!.status, 'ferias')
    assert.equal(por['ANDRE JOSE DE EXEMPLO']!.entrada1, null)
    // Entrada 1 vazia com Saída 1 preenchida: não chuta, vai pra revisão.
    assert.equal(por['OTAVIO SEMENTRADA']!.status, 'desconhecido')
  })

  it('nome vem só com trim (o espaço do fim some, o miolo não muda)', () => {
    const { registros } = parsePontoHtml(htmlFixture())
    assert.ok(registros.every(r => r.nome === r.nome.trim()))
  })

  it('avisa quando o HTML não é a tela do ponto', () => {
    const r = parsePontoHtml('<html><body><p>Faça login</p></body></html>')
    assert.equal(r.registros.length, 0)
    assert.equal(r.data, null)
    assert.match(r.avisos[0]!, /dia-resumido/)
  })

  it('HTML vazio ou quebrado não derruba o leitor', () => {
    for (const h of ['', '<<<>>>', '<div id="dia-resumido-2026-09-28">', '\u0000￿']) {
      assert.doesNotThrow(() => parsePontoHtml(h), JSON.stringify(h))
    }
  })
})

describe('parsePontoHtml: casos sintéticos', () => {
  it('Entrada 1 é SEMPRE a célula depois do nome — não "o primeiro horário que aparecer"', () => {
    const { registros } = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: 'ANA TESTE', celulas: seis('', '', '13:00', '17:00') }]))
    assert.equal(registros[0]!.status, 'desconhecido')
    assert.equal(registros[0]!.entrada1, null)
  })

  it('hora com um dígito vira HH:MM', () => {
    const { registros } = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: 'ANA TESTE', celulas: seis('7:59') }]))
    assert.equal(registros[0]!.entrada1, '07:59')
  })

  it('ícones: vermelho, amarelo, verde, desconhecido e ausente', () => {
    const { registros } = parsePontoHtml(htmlPonto('2026-09-28', [
      { nome: 'A VERMELHO', icone: 'vermelho', celulas: seis('08:00') },
      { nome: 'B AMARELO', icone: 'amarelo', celulas: seis('08:00') },
      { nome: 'C VERDE', icone: 'verde', celulas: seis('08:00') },
      { nome: 'D OUTRO', icone: 'outro', celulas: seis('08:00') },
      { nome: 'E NENHUM', icone: 'nenhum', celulas: seis('08:00') },
    ]))
    assert.deepEqual(registros.map(r => r.icone), ['vermelho', 'amarelo', 'verde', 'outro', 'outro'])
    assert.ok(registros.every(r => r.status === 'batido'))
  })

  it('"Férias" com acento/caixa diferentes ainda é férias', () => {
    const { registros } = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: 'ANA', celulas: Array(6).fill('férias') }]))
    assert.equal(registros[0]!.status, 'ferias')
  })

  it('texto que NÃO é exatamente FÉRIAS não vira férias (ex.: atestado, folga)', () => {
    for (const t of ['ATESTADO', 'FOLGA', 'FERIAS COLETIVAS?', 'FÉRIAS X']) {
      const { registros } = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: 'ANA', celulas: seis(t) }]))
      assert.equal(registros[0]!.status, 'desconhecido', t)
    }
  })

  it('nome sem letras é ignorado com aviso', () => {
    const r = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: '123', celulas: seis('08:00') }, { nome: 'ANA', celulas: seis('08:00') }]))
    assert.deepEqual(r.registros.map(x => x.nome), ['ANA'])
    assert.match(r.avisos.join('\n'), /sem nome reconhecível/)
  })

  it('HTML com mais de um dia: avisa e não escolhe data', () => {
    const r = parsePontoHtml(htmlPonto('2026-09-28', [
      { nome: 'ANA', celulas: seis('08:00') },
      { nome: 'BIA', celulas: seis('08:00'), data: '2026-09-29' },
    ]))
    assert.equal(r.data, null)
    assert.match(r.avisos.join('\n'), /mais de um dia/)
  })

  it('nome repetido no ponto vira aviso (vai pra revisão)', () => {
    const r = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: 'ANA', celulas: seis('08:00') }, { nome: 'Ána ', celulas: seis('09:00') }]))
    assert.match(r.avisos.join('\n'), /"ANA" aparece 2 vezes/)
  })

  it('caracteres especiais no nome não quebram nada (são texto, não HTML)', () => {
    const nome = 'ANA <script>alert(1)</script> & "CIA"'
    const r = parsePontoHtml(htmlPonto('2026-09-28', [{ nome, celulas: seis('08:00') }]))
    assert.equal(r.registros[0]!.nome, nome)
  })

  it('"Nenhum ponto registrado" ganha de qualquer outra coisa na linha', () => {
    const r = parsePontoHtml(htmlPonto('2026-09-28', [{ nome: 'ANA', semRegistro: true }]))
    assert.equal(r.registros[0]!.status, 'sem_registro')
  })
})
