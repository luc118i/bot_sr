// A CLI de verdade (node dist/cli.js) num processo separado, lendo uma cópia
// .xlsx — nunca a planilha do Google.
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { cenario, FIXTURE, htmlDoDia } from '../helpers/planilha'
import { salvarXlsx } from '../helpers/xlsx'

const CLI = path.join(__dirname, '..', '..', 'cli.js')
let pasta = ''
let xlsx = ''

function cli(args: string[], entrada = '') {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: pasta,
    input: entrada,
    encoding: 'utf-8',
    env: { ...process.env, DATA_DIR: pasta, AGENT_CONFIG_PATH: path.join(pasta, 'config.json') },
    timeout: 60_000,
  })
  return { codigo: r.status, saida: r.stdout, erro: r.stderr }
}

before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'freq-cli-'))
  xlsx = await salvarXlsx(cenario()) // cenario() também grava o regras.json do teste
})

describe('CLI', () => {
  it('sem comando mostra a ajuda', () => {
    const r = cli([])
    assert.equal(r.codigo, 0)
    assert.match(r.saida, /Uso:[\s\S]*simular[\s\S]*escrever[\s\S]*desfazer/)
  })

  it('simular sem --html → erro e código de saída 1', () => {
    const r = cli(['simular', '--xlsx', xlsx])
    assert.equal(r.codigo, 1)
    assert.match(r.erro, /Informe --html/)
  })

  it('simular com a cópia .xlsx: relatório, arquivos salvos e comando pra gravar', () => {
    const r = cli(['simular', '--html', FIXTURE, '--xlsx', xlsx])
    assert.equal(r.codigo, 0, r.erro)
    assert.match(r.saida, /2026-09-28 — aba "Setembro" — SIMULAÇÃO/)
    assert.match(r.saida, /Será escrito \(4\)/)
    assert.match(r.saida, /Para gravar: node dist\/cli\.js escrever --plano/)
    const rel = fs.readdirSync(path.join(pasta, 'relatorios'))
    assert.ok(rel.some(f => /^2026-09-28_simulacao_.*\.json$/.test(f)))
  })

  it('vários --html: domingo vira PULADO, HTML inválido vira ERRO (saída 1)', () => {
    const dom = path.join(pasta, 'dom.html'); fs.writeFileSync(dom, htmlDoDia('2026-09-27'))
    const ruim = path.join(pasta, 'ruim.html'); fs.writeFileSync(ruim, '<p>login</p>')
    const r = cli(['simular', '--html', FIXTURE, '--html', dom, '--html', ruim, '--xlsx', xlsx])
    assert.equal(r.codigo, 1)
    assert.match(r.saida, /PULADO 2026-09-27 \(dom\.html\)/)
    assert.match(r.saida, /ERRO +\(ruim\.html\)/)
  })

  it('--entrada-padrao/--tolerancia sobrepõem as regras', () => {
    const r = cli(['simular', '--html', FIXTURE, '--xlsx', xlsx, '--entrada-padrao', '07:00', '--tolerancia', '0'])
    assert.equal(r.codigo, 0, r.erro)
    // Entrando às 07:00 sem tolerância, JOAO (07:58) atrasou.
    assert.match(r.saida, /AH8 +ADM 374 +JOAO EXEMPLO DA SILVA → "P"/)
  })

  it('escrever: mostra o plano e NÃO grava sem confirmação "s"', () => {
    const json = fs.readdirSync(path.join(pasta, 'relatorios')).find(f => /simulacao.*\.json$/.test(f))!
    const r = cli(['escrever', '--plano', path.join(pasta, 'relatorios', json)], 'n\n')
    assert.equal(r.codigo, 0, r.erro)
    assert.match(r.saida, /célula\(s\) a escrever: AH/)
    assert.match(r.saida, /Cancelado\./)
  })

  it('escrever sem --plano → erro', () => {
    assert.equal(cli(['escrever']).codigo, 1)
  })

  it('desfazer com relatório que não é de escrita → erro', () => {
    const json = fs.readdirSync(path.join(pasta, 'relatorios')).find(f => /simulacao.*\.json$/.test(f))!
    const r = cli(['desfazer', '--escrita', path.join(pasta, 'relatorios', json)])
    assert.equal(r.codigo, 1)
    assert.match(r.erro, /não é o relatório de uma escrita/)
  })

  it('arquivo inexistente → erro com saída 1, sem stack trace', () => {
    const r = cli(['simular', '--html', path.join(pasta, 'nao-existe.html'), '--xlsx', xlsx])
    assert.equal(r.codigo, 1)
    assert.match(r.erro, /^ERRO: /)
    assert.doesNotMatch(r.erro, /\n\s+at /)
  })

  it('CLI grava o log na pasta de dados (DATA_DIR)', () => {
    assert.ok(fs.existsSync(path.join(pasta, 'logs', 'frequencia.log')))
  })
})
