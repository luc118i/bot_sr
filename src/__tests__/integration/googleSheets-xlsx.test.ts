// Conectores Service Account (API do Google simulada) e cópia .xlsx (arquivo
// gerado na hora com o exceljs).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ExcelJS from 'exceljs'
import { criarAuth, GoogleSheetsGateway } from '../../sheets/googleSheets'
import { XlsxGateway } from '../../sheets/xlsxGateway'
import { refAba } from '../../sheets/gateway'
import { detectarLayout } from '../../core/layoutMes'
import { parseDataPlanilha, parseHora } from '../../core/tempo'
import { simular } from '../../service'
import { colDoDia, definirRegras, gridMes, htmlFixture, NOITE, regrasCenario } from '../helpers/planilha'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
const SA = b64({ type: 'service_account', client_email: 'bot@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' })

describe('criarAuth', () => {
  it('erros claros pra cada problema do JSON', () => {
    assert.throws(() => criarAuth(''), /não configurada/)
    assert.throws(() => criarAuth('!!!'), /inválida/)
    assert.throws(() => criarAuth(b64({ type: 'authorized_user' })), /tipo "authorized_user"/)
    assert.throws(() => criarAuth(b64({ type: 'service_account', client_email: 'x' })), /malformadas/)
  })
  it('JSON certo → e-mail da conta', () => {
    assert.equal(criarAuth(SA).email, 'bot@proj.iam.gserviceaccount.com')
  })
})

describe('refAba', () => {
  it('aspas simples na aba são escapadas (evita range quebrado)', () => {
    assert.equal(refAba('Setembro'), "'Setembro'")
    assert.equal(refAba("D'Ávila"), "'D''Ávila'")
  })
})

describe('GoogleSheetsGateway (API simulada)', () => {
  function gateway(api: any) {
    const gw = new GoogleSheetsGateway('ID1', SA)
    ;(gw as any).api = api
    return gw
  }
  const meta = { data: { properties: { title: 'T 2026' }, sheets: [{ properties: { title: 'Setembro' } }, { properties: { title: "D'Ávila" } }] } }

  it('descrição mostra o e-mail da conta (pra compartilhar a planilha)', () => {
    assert.match(new GoogleSheetsGateway('ID1', SA).descricao, /bot@proj/)
  })

  it('403/404 vira instrução de compartilhar com a Service Account', async () => {
    const gw = gateway({ spreadsheets: { get: async () => { throw Object.assign(new Error('forbidden'), { code: 403 }) } } })
    await assert.rejects(gw.titulo(), /Compartilhe a planilha/)
  })

  it('outros erros passam como estão', async () => {
    const gw = gateway({ spreadsheets: { get: async () => { throw Object.assign(new Error('boom'), { code: 500 }) } } })
    await assert.rejects(gw.titulo(), /boom/)
  })

  it('lerGrid: aba inexistente → null sem chamar a API de valores; valores viram string', async () => {
    const chamadas: any[] = []
    const gw = gateway({
      spreadsheets: {
        get: async () => meta,
        values: { get: async (p: any) => { chamadas.push(p); return { data: { values: [[1, null, 'x', true]] } } } },
      },
    })
    assert.equal(await gw.lerGrid('Outubro'), null)
    assert.equal(chamadas.length, 0)
    assert.deepEqual(await gw.lerGrid("D'Ávila"), [['1', '', 'x', 'true']])
    assert.equal(chamadas[0].range, "'D''Ávila'!A1:CZ1000")
    assert.equal(chamadas[0].valueRenderOption, 'UNFORMATTED_VALUE')
  })

  it('colunasOcultas respeita o startColumn de cada bloco', async () => {
    const gw = gateway({
      spreadsheets: {
        get: async () => ({ data: { sheets: [{ data: [
          { startColumn: 0, columnMetadata: [{}, { hiddenByUser: true }] },
          { startColumn: 10, columnMetadata: [{ hiddenByUser: true }, { hiddenByUser: false }] },
        ] }] } }),
      },
    })
    assert.deepEqual([...await gw.colunasOcultas('Setembro')].sort((a, b) => a - b), [2, 11])
  })

  it('lerCelulas devolve um valor por célula, na ordem; célula vazia = ""', async () => {
    const gw = gateway({ spreadsheets: { values: { batchGet: async (p: any) => ({ data: { valueRanges: p.ranges.map((r: string) => (r.endsWith('AH9') ? {} : { values: [['.']] })) } }) } } })
    assert.deepEqual(await gw.lerCelulas('Setembro', ['AH8', 'AH9', 'AH10']), ['.', '', '.'])
  })

  it('escrever usa RAW (". " e "P" entram como texto) e limpar usa batchClear', async () => {
    const chamadas: any[] = []
    const gw = gateway({ spreadsheets: { values: {
      batchUpdate: async (p: any) => { chamadas.push(['u', p]) },
      batchClear: async (p: any) => { chamadas.push(['c', p]) },
    } } })
    await gw.escrever('Setembro', [{ celula: 'AH8', valor: '.' }])
    await gw.limpar('Setembro', ['AH8'])
    await gw.escrever('Setembro', [])
    await gw.limpar('Setembro', [])
    assert.equal(chamadas.length, 2)
    assert.equal(chamadas[0][1].requestBody.valueInputOption, 'RAW')
    assert.deepEqual(chamadas[0][1].requestBody.data, [{ range: "'Setembro'!AH8", values: [['.']] }])
    assert.deepEqual(chamadas[1][1].requestBody.ranges, ["'Setembro'!AH8"])
  })
})

describe('XlsxGateway (arquivo real gerado na hora)', () => {
  async function criarXlsx(): Promise<string> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Setembro')
    const g = gridMes(2026, 9, [['374', 'JOAO EXEMPLO DA SILVA'], ['2376', 'PEDRO TESTE DE ARAUJO', { 28: 'FO' }]])
    g.forEach((linha, r) => linha.forEach((v, c) => {
      if (!v) return
      ws.getCell(r + 1, c + 1).value = /^\d+$/.test(v) ? Number(v) : v // números como número, como na planilha real
    }))
    ws.getColumn(colDoDia(7)).hidden = true
    ws.getCell('A1').value = new Date(Date.UTC(2026, 8, 28))
    ws.getCell('B1').value = { formula: '1+1', result: 2 } as any
    ws.getCell('C1').value = { richText: [{ text: 'ri' }, { text: 'co' }] } as any
    ws.getCell('D1').value = { error: '#N/A' } as any
    wb.addWorksheet('BASE DE DADOS').addRow(['ADM', 'Colaborador'])
    const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'freq-xlsx-')), 'copia.xlsx')
    await wb.xlsx.writeFile(arq)
    return arq
  }

  it('lê abas, valores crus (serial/fórmula/rich text/erro) e colunas ocultas', async () => {
    const gw = new XlsxGateway(await criarXlsx())
    assert.deepEqual(await gw.listarAbas(), ['Setembro', 'BASE DE DADOS'])
    assert.equal(await gw.titulo(), 'copia')
    const grid = (await gw.lerGrid('Setembro'))!
    assert.equal(parseDataPlanilha(grid[0]![0]!), '2026-09-28')
    assert.deepEqual(grid[0]!.slice(1, 4), ['2', 'rico', ''])
    assert.ok((await gw.colunasOcultas('Setembro')).has(colDoDia(7)))
    assert.equal(await gw.lerGrid('Nao existe'), null)
    assert.deepEqual(await gw.lerCelulas('Setembro', ['AH9', 'AH8']), ['FO', ''])
    await assert.rejects(gw.lerCelulas('Nao existe', ['A1']), /não existe/)
  })

  it('o layout e a simulação funcionam lendo a cópia .xlsx', async () => {
    const gw = new XlsxGateway(await criarXlsx())
    const l = detectarLayout('Setembro', (await gw.lerGrid('Setembro'))!, 2026, 9, await gw.colunasOcultas('Setembro'))
    assert.equal(l.diasNaoUteis.get(7), 'coluna oculta')
    assert.deepEqual(l.linhas.map(x => x.adm), ['374', '2376'])

    definirRegras(regrasCenario())
    const t = new (class extends XlsxGateway { async titulo() { return '[SR] 2026' } })((gw as any).arquivo)
    const plano = await simular(t, { data: '2026-09-28', html: htmlFixture(), now: NOITE })
    assert.deepEqual(plano.escritas.map(e => `${e.celula}=${e.codigo}`), ['AH8=.'])
  })

  it('é SOMENTE LEITURA: escrever e limpar falham', async () => {
    const gw = new XlsxGateway(await criarXlsx())
    await assert.rejects(gw.escrever(), /somente leitura/)
    await assert.rejects(gw.limpar(), /somente leitura/)
  })

  it('arquivo inexistente → erro ao ler', async () => {
    await assert.rejects(new XlsxGateway(path.join(os.tmpdir(), 'nao-existe-123.xlsx')).listarAbas())
  })

  it('hora como fração de dia (como o Google devolve) é entendida', () => {
    assert.equal(parseHora(String(8 / 24)), 480)
  })
})
