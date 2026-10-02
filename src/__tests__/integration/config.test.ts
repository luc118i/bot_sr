// config.json local: segredos cifrados pelo cofre do sistema, compatibilidade
// com configs antigas e mensagens de erro.
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import {
  clearCachedConfig, configExiste, configurarCofre, credenciaisPonto, getConfig, getConfigPath, planilhaEmbutida, saveConfig, tipoConexao, type AgentConfig,
} from '../../config'
import { gatewayDaConfig } from '../../service'
import { AppsScriptGateway } from '../../sheets/appsScriptGateway'
import { extrairSpreadsheetId } from '../../sheets/googleSheets'

// Cofre de mentira: reversível e visivelmente diferente do texto puro.
const cofreFalso = {
  cifrar: (t: string) => Buffer.from(`enc:${t}`).toString('base64'),
  decifrar: (b: string) => {
    const s = Buffer.from(b, 'base64').toString()
    if (!s.startsWith('enc:')) throw new Error('não foi este cofre')
    return s.slice(4)
  },
}

const BASE: AgentConfig = {
  conexao: 'apps_script',
  apps_script_url: 'https://script.google.com/macros/s/ABC/exec',
  apps_script_token: 'tok-secreto',
  google_service_account_json_b64: '',
  spreadsheet_id: '',
  ponto_banco: '123',
  ponto_tipo: 'folha',
  ponto_numero: '42',
  ponto_senha: 's3nh@',
}

const bruto = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'))

describe('config.json', () => {
  beforeEach(() => { fs.rmSync(getConfigPath(), { force: true }); clearCachedConfig() })

  it('sem arquivo → mensagem diz onde criar', () => {
    assert.throws(() => getConfig(), (e: Error) => e.message.includes(getConfigPath()) && /Configurações/.test(e.message))
  })

  it('JSON quebrado → erro claro', () => {
    fs.writeFileSync(getConfigPath(), '{')
    assert.throws(() => getConfig(), /Erro ao ler config\.json/)
  })

  it('com cofre: senha e token NUNCA vão em texto puro pro disco, e voltam iguais', () => {
    configurarCofre(cofreFalso)
    saveConfig(BASE)
    const disco = fs.readFileSync(getConfigPath(), 'utf-8')
    assert.doesNotMatch(disco, /s3nh@|tok-secreto/)
    assert.ok(bruto().ponto_senha_enc && bruto().apps_script_token_enc)
    assert.equal(bruto().ponto_senha, undefined)
    const lido = getConfig()
    assert.equal(lido.ponto_senha, 's3nh@')
    assert.equal(lido.apps_script_token, 'tok-secreto')
    assert.equal((lido as any).ponto_senha_enc, undefined)
  })

  it('segredo vazio não grava "_enc" vazio', () => {
    configurarCofre(cofreFalso)
    saveConfig({ ...BASE, ponto_senha: '' })
    assert.equal(bruto().ponto_senha_enc, undefined)
  })

  it('saveConfig não altera o objeto recebido (a tela continua com a senha)', () => {
    configurarCofre(cofreFalso)
    const cfg = { ...BASE }
    saveConfig(cfg)
    assert.equal(cfg.ponto_senha, 's3nh@')
  })

  it('segredo cifrado sem cofre (CLI) → erro explicando', () => {
    configurarCofre(cofreFalso)
    saveConfig(BASE)
    // Simula a CLI: módulo novo, sem cofre.
    delete require.cache[require.resolve('../../config')]
    const cli = require('../../config') as typeof import('../../config')
    assert.throws(() => cli.getConfig(), /criptografado.*só o app/)
  })

  it('cache: lê o disco uma vez; saveConfig invalida', () => {
    configurarCofre(cofreFalso)
    saveConfig(BASE)
    const a = getConfig()
    assert.equal(getConfig(), a)
    saveConfig({ ...BASE, ponto_numero: '43' })
    assert.equal(getConfig().ponto_numero, '43')
  })

  it('link completo da planilha vira só o ID ao salvar e ao ler', () => {
    configurarCofre(cofreFalso)
    saveConfig({ ...BASE, spreadsheet_id: 'https://docs.google.com/spreadsheets/d/1AbC_d-9/edit#gid=0' })
    assert.equal(bruto().spreadsheet_id, '1AbC_d-9')
    assert.equal(getConfig().spreadsheet_id, '1AbC_d-9')
  })
})

describe('tipoConexao / credenciaisPonto / gatewayDaConfig', () => {
  it('config antiga sem "conexao": tem link do Apps Script → apps_script; senão service account', () => {
    assert.equal(tipoConexao({ ...BASE, conexao: undefined }), 'apps_script')
    assert.equal(tipoConexao({ ...BASE, conexao: undefined, apps_script_url: '' }), 'service_account')
    assert.equal(tipoConexao({ ...BASE, conexao: 'service_account' }), 'service_account')
  })

  it('credenciais do ponto: faltando qualquer campo → erro; tipo padrão = folha', () => {
    for (const k of ['ponto_banco', 'ponto_numero', 'ponto_senha'] as const) {
      assert.throws(() => credenciaisPonto({ ...BASE, [k]: '' }), /Login do ponto não configurado/)
    }
    assert.equal(credenciaisPonto({ ...BASE, ponto_tipo: undefined }).tipo, 'folha')
  })

  it('gateway certo pra cada conexão; service account sem planilha → erro', () => {
    assert.ok(gatewayDaConfig(BASE) instanceof AppsScriptGateway)
    assert.throws(() => gatewayDaConfig({ ...BASE, conexao: 'service_account' }), /planilha não configurado/)
    assert.throws(() => gatewayDaConfig({ ...BASE, conexao: 'service_account', spreadsheet_id: 'x' }), /Service Account/)
  })
})

describe('extrairSpreadsheetId', () => {
  it('aceita ID puro ou qualquer variação do link', () => {
    assert.equal(extrairSpreadsheetId('  1AbC  '), '1AbC')
    assert.equal(extrairSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC_d-9/edit?usp=sharing'), '1AbC_d-9')
    assert.equal(extrairSpreadsheetId('https://docs.google.com/spreadsheets/u/1/d/XyZ/htmlview'), 'XyZ')
    assert.equal(extrairSpreadsheetId(''), '')
  })
})

describe('planilha embutida no instalador (npm run dist)', () => {
  const EMB = { apps_script_url: 'https://script.google.com/macros/s/EMPRESA/exec', apps_script_token: 'token-da-empresa-0123456789' }
  const embutir = () => fs.writeFileSync(process.env['EMBUTIDO_PATH']!, JSON.stringify(EMB))
  beforeEach(() => { fs.rmSync(process.env['EMBUTIDO_PATH']!, { force: true }); fs.rmSync(getConfigPath(), { force: true }); clearCachedConfig() })

  it('sem config.json, o app já tem a planilha: só falta o login do ponto', () => {
    embutir()
    assert.equal(configExiste(), true)
    const c = getConfig()
    assert.deepEqual([c.conexao, c.apps_script_url, c.apps_script_token], ['apps_script', EMB.apps_script_url, EMB.apps_script_token])
    assert.throws(() => credenciaisPonto(c), /Login do ponto não configurado/)
  })

  it('a embutida vale por cima do que estiver no config.json', () => {
    configurarCofre(cofreFalso)
    saveConfig({ ...BASE, apps_script_url: 'https://script.google.com/macros/s/OUTRA/exec' })
    embutir()
    clearCachedConfig()
    assert.equal(getConfig().apps_script_url, EMB.apps_script_url)
    assert.equal(getConfig().ponto_numero, '42') // o resto continua vindo do config.json
  })

  it('salvar NUNCA grava link/token da empresa no config.json do operador', () => {
    configurarCofre(cofreFalso)
    embutir()
    saveConfig({ ...getConfig(), ponto_numero: '7' })
    const disco = fs.readFileSync(getConfigPath(), 'utf-8')
    assert.doesNotMatch(disco, /EMPRESA|token-da-empresa|apps_script_token_enc|apps_script_url/)
    assert.equal(bruto().ponto_numero, '7')
  })

  it('arquivo embutido incompleto ou quebrado é ignorado', () => {
    fs.writeFileSync(process.env['EMBUTIDO_PATH']!, JSON.stringify({ apps_script_url: EMB.apps_script_url }))
    assert.equal(planilhaEmbutida(), null)
    fs.writeFileSync(process.env['EMBUTIDO_PATH']!, '{')
    assert.equal(planilhaEmbutida(), null)
    assert.equal(configExiste(), false)
  })
})
