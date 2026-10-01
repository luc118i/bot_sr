// E2E do app de verdade: main.ts + preload + as três telas, rodando no Electron,
// com a rede trocada por um mundo simulado — o ponto (Secullum) devolve o
// cenário dos testes e a "planilha do Google" é o apps-script/Codigo.gs real
// rodando numa sandbox. Nada sai pra internet e nada toca na pasta de dados do
// app de verdade (userData vai pra uma pasta temporária).
//
//   npm run test:ui          (abre janelas por alguns segundos)
//   E2E_MANTER=1 npm run test:ui   (não apaga a pasta temporária; mostra o caminho)
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { planilhaDoCenario, sandbox } from '../helpers/appsScriptFalso'
import { FIXTURE, listaApi, RAIZ_PROJETO, regrasCenario } from '../helpers/planilha'

// ── ambiente isolado ────────────────────────────────────────────────────────
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freq-e2e-'))
const USERDATA = path.join(DIR, 'userData')
const TELAS = path.join(DIR, 'telas')
fs.mkdirSync(TELAS, { recursive: true })
app.setPath('userData', USERDATA)
app.getAppPath = () => RAIZ_PROJETO // main.ts acha src/renderer e dist/preload.js a partir daqui
process.env['REGRAS_PATH'] = path.join(USERDATA, 'regras.json')
process.env['LOG_TO_CONSOLE'] = '0'

// ── mundo simulado ──────────────────────────────────────────────────────────
const pl = planilhaDoCenario() // também grava o regras.json do cenário
fs.writeFileSync(process.env['REGRAS_PATH']!, JSON.stringify({ ...regrasCenario(), geral: { tolerancia_min: '5', entrada_padrao: '08:00', horario_corte: '00:00' } }))
const google = sandbox(pl, { TOKEN: 'tok-e2e' })
const URL_GS = 'https://script.google.com/macros/s/E2E/exec'
const NOME_XSS = '<img src=x onerror="window.__xss=1">ZE XSS DA SILVA'
const rede = { pontoComSenhaErrada: false, bloqueadas: [] as string[] }

globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const u = String(url)
  if (u === URL_GS) return new Response(JSON.stringify(google.post(JSON.parse(String(init.body)))))
  if (u.startsWith('https://pontowebapp.secullum.com.br/123/')) {
    if (u.endsWith('/Login/VerificarBancoValido/')) return new Response('true')
    if (rede.pontoComSenhaErrada) return new Response('', { status: 401 })
    if (u.endsWith('/Login')) return new Response('{}')
    return new Response(JSON.stringify({
      lista: [...listaApi(), { funcionarioNome: NOME_XSS, data: '', batidas: [{ valor: '08:00' }], situacao: 0 }],
    }))
  }
  rede.bloqueadas.push(u)
  throw new Error(`rede bloqueada no E2E: ${u}`)
}) as typeof fetch

const CONFIG = {
  conexao: 'apps_script', apps_script_url: URL_GS, apps_script_token: 'tok-e2e', google_service_account_json_b64: '', spreadsheet_id: '',
  ponto_banco: '123', ponto_tipo: 'folha', ponto_numero: '42', ponto_senha: 'senha-e2e',
}
fs.mkdirSync(USERDATA, { recursive: true })
fs.writeFileSync(path.join(USERDATA, 'config.json'), JSON.stringify(CONFIG))

// Diálogos nativos travariam o teste — cada passo diz o que o "usuário" escolhe.
let escolhaArquivos: string[] = []
dialog.showOpenDialog = (async () => ({ canceled: !escolhaArquivos.length, filePaths: escolhaArquivos })) as any
dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any
shell.openPath = async () => ''

// ── utilidades do roteiro ───────────────────────────────────────────────────
const celula = (aba: string, ref: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!
  const c = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  return String(pl.abas[aba]!.grid[+m[2]! - 1]?.[c] ?? '')
}
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

async function esperar<T>(desc: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const fim = Date.now() + ms
  let ultimo: unknown
  while (Date.now() < fim) {
    try { const v = await fn(); if (v) return v as NonNullable<T> } catch (e) { ultimo = e }
    await dormir(100)
  }
  throw new Error(`Tempo esgotado esperando: ${desc}${ultimo ? ` (${(ultimo as Error).message})` : ''}`)
}

const js = <T = any>(wc: WebContents, codigo: string): Promise<T> => wc.executeJavaScript(codigo, true)
const textoDe = (wc: WebContents, sel: string) => js<string>(wc, `document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`)
const clicarTexto = (wc: WebContents, sel: string, re: RegExp) => js(wc, `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(b => ${re}.test(b.textContent) && !b.disabled)
  if (!b) throw new Error('botão ${re} não encontrado')
  b.click(); return true })()`)
const janela = (arquivo: string) => esperar(`janela ${arquivo}`, () =>
  BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().endsWith(arquivo)))
async function foto(w: BrowserWindow, nome: string) {
  // Janela em segundo plano não repinta — sem foco, a captura sai com um quadro antigo.
  w.show(); w.focus(); await dormir(400)
  try { fs.writeFileSync(path.join(TELAS, `${nome}.png`), (await w.webContents.capturePage()).toPNG()) } catch { /* janela oculta */ }
}

const errosConsole: string[] = []
const resultados: { passo: string; ok: boolean; erro?: string; ms: number }[] = []
async function passo(nome: string, fn: () => Promise<void>) {
  const t = Date.now()
  try { await fn(); resultados.push({ passo: nome, ok: true, ms: Date.now() - t }); console.log(`  ✔ ${nome}`) } catch (e: any) {
    resultados.push({ passo: nome, ok: false, erro: e.message, ms: Date.now() - t }); console.log(`  ✖ ${nome}\n      ${e.message}`)
  }
}
function igual(atual: unknown, esperado: unknown, oque: string) {
  if (JSON.stringify(atual) !== JSON.stringify(esperado)) throw new Error(`${oque}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`)
}

// ── roteiro ─────────────────────────────────────────────────────────────────
async function roteiro() {
  const w = await janela('app.html')
  const wc = w.webContents
  wc.on('console-message', (_e, nivel, msg) => { if (nivel >= 3) errosConsole.push(msg) })
  await esperar('tela carregada', () => js(wc, `document.readyState === 'complete' && !!window.agent`))
  // O "usuário" confirma tudo que a tela perguntar.
  const prepararTela = () => js(wc, `window.confirm = () => true; true`)
  await prepararTela()
  const resposta = () => textoDe(wc, '#resposta')
  const escolherDia = (data: string, simular: boolean) => js(wc, `(() => {
    const d = document.getElementById('data'); d.value = '${data}'; d.dispatchEvent(new Event('change'))
    document.getElementById('simular').checked = ${simular}; return true })()`)
  const ocupada = () => js<boolean>(wc, `document.getElementById('status').className.includes('ocupado')`)

  await passo('abre pronta: status "Pronto · ponto e planilha"', async () => {
    await esperar('status pronto', async () => /Pronto · ponto e planilha/.test(await textoDe(wc, '#status')))
  })

  await passo('simular um dia: mostra o que seria gravado e NÃO grava', async () => {
    await escolherDia('2026-09-28', true)
    await js(wc, `document.querySelector('#chips [data-cmd="dia"]').click()`)
    await esperar('resposta da simulação', async () => /Simulação\./.test(await resposta()))
    igual(['AH8', 'AH9', 'AH10', 'AH16'].map(c => celula('Setembro', c)), ['', '', '', ''], 'planilha depois de simular')
    await esperar('botão Gravar agora (4)', () => js(wc, `[...document.querySelectorAll('#resposta button')].some(b => b.textContent === 'Gravar agora (4)')`))
    await foto(w, '1-simulacao')
  })

  await passo('nome malicioso vindo do ponto aparece como TEXTO (sem XSS)', async () => {
    await js(wc, `document.querySelectorAll('#detalhesDias details').forEach(d => d.open = true); document.querySelectorAll('.aba[data-k="pendencias"]').forEach(b => b.click()); true`)
    await esperar('nome na tabela', async () => (await textoDe(wc, '#detalhesDias')).includes('ZE XSS DA SILVA'))
    igual(await js(wc, `[window.__xss, document.querySelectorAll('img[src="x"]').length]`), [null, 0], '[window.__xss, <img> injetadas]')
    if (!(await textoDe(wc, '#detalhesDias')).includes('<img src=x')) throw new Error('o nome deveria aparecer literalmente, com os sinais < >')
  })

  await passo('"Gravar agora" grava exatamente a simulação aprovada', async () => {
    // Guarda todo rótulo que o status mostrar durante a gravação.
    await js(wc, `window.__rotulos = []; new MutationObserver(() => window.__rotulos.push(document.getElementById('status').innerText))
      .observe(document.getElementById('status'), { childList: true, subtree: true, characterData: true }); true`)
    await clicarTexto(wc, '#resposta button', /^Gravar agora/)
    await esperar('toast de gravação', async () => /4 células gravadas/.test(await textoDe(wc, '#toast')))
    igual(['AH8', 'AH9', 'AH10', 'AH16', 'AH11', 'AH12', 'AH14'].map(c => celula('Setembro', c)), ['.', '.', 'P', 'AT', '', 'FE', 'FO'], 'planilha depois de gravar')
    const rotulos: string[] = await js(wc, 'window.__rotulos')
    if (rotulos.some(r => /Simulando/.test(r))) throw new Error(`status disse "Simulando…" durante a gravação: ${JSON.stringify(rotulos)}`)
    if (!rotulos.some(r => /Gravando/.test(r))) throw new Error(`status não disse "Gravando…": ${JSON.stringify(rotulos)}`)
    // O resultado na tela passa a ser o da gravação, não "nada foi gravado".
    await esperar('resultado da gravação', async () => /Pronto\. Conferi 1 dia e preenchi 4 células/.test(await resposta()))
    if (/nada foi gravado/i.test(await textoDe(wc, 'main'))) throw new Error('a tela ainda diz "nada foi gravado"')
    await foto(w, '2-gravado')
  })

  await passo('justificar quem ficou sem ponto grava só aquela célula', async () => {
    await js(wc, `(() => {
      const s = document.querySelector('select[aria-label="Justificar PAULO MODELO DA SILVA"]')
      s.value = 'AT'; s.dispatchEvent(new Event('change')); return true })()`)
    await clicarTexto(wc, '#detalhesDias button', /^Gravar 1 justificativa$/)
    await esperar('toast de justificativa', async () => /1 justificativa gravada/.test(await textoDe(wc, '#toast')))
    igual(celula('Setembro', 'AH11'), 'AT', 'AH11 (PAULO)')
    await foto(w, '3-justificado')
  })

  await passo('Desfazer do aviso apaga a justificativa e mais nada', async () => {
    await clicarTexto(wc, '#toast button', /^Desfazer$/)
    await esperar('resposta do desfazer', async () => /Desfeito\. Apaguei 1 célula/.test(await resposta()))
    igual(['AH11', 'AH8', 'AH10'].map(c => celula('Setembro', c)), ['', '.', 'P'], 'AH11 apagada, o resto intacto')
    await esperar('PAULO de volta às pendências', () => js(wc, `!!document.querySelector('select[aria-label="Justificar PAULO MODELO DA SILVA"]')`))
  })

  await passo('reabrir a tela traz de volta o último resultado e o histórico', async () => {
    wc.reload()
    await esperar('recarregou', () => js(wc, `document.readyState === 'complete' && !!window.agent`))
    await prepararTela()
    await esperar('último resultado restaurado', async () => /Última (conferência|simulação)/.test(await resposta()))
    await esperar('histórico', async () => /preenchido · 4 células/.test(await textoDe(wc, '#atividade')))
  })

  await passo('senha do ponto errada: mensagem clara + atalho pras Configurações, tela destrava', async () => {
    rede.pontoComSenhaErrada = true
    try {
      await escolherDia('2026-09-29', false)
      await js(wc, `document.querySelector('#chips [data-cmd="dia"]').click()`)
      await esperar('erro', async () => /Não consegui concluir[\s\S]*senha do ponto inválidos/.test(await resposta()))
      await esperar('botão Abrir Configurações', () => js(wc, `[...document.querySelectorAll('#resposta button')].some(b => b.textContent === 'Abrir Configurações')`))
      if (await ocupada()) throw new Error('a tela ficou presa em "Trabalhando…"')
    } finally { rede.pontoComSenhaErrada = false }
  })

  await passo('config quebrada entre simular e gravar: erro na tela, nada gravado, tela NÃO trava', async () => {
    await escolherDia('2026-09-29', true)
    await js(wc, `document.querySelector('#chips [data-cmd="dia"]').click()`)
    await esperar('simulação de 29/09', async () => /Simulação\./.test(await resposta()))
    await js(wc, `window.agent.getConfig().then(c => window.agent.saveConfig({ ...c, apps_script_url: 'https://exemplo.invalido/exec' }))`)
    try {
      await clicarTexto(wc, '#resposta button', /^Gravar agora/)
      await esperar('mensagem de erro', async () => /Não consegui concluir[\s\S]*Apps Script inválido/.test(await resposta()), 8000)
      if (await ocupada()) throw new Error('a tela ficou presa em "Trabalhando…"')
      igual(celula('Setembro', 'AI8'), '', 'AI8 (29/09) não pode ter sido gravada')
    } finally {
      await js(wc, `window.agent.saveConfig(${JSON.stringify(CONFIG)})`)
    }
  })

  await passo('"Conferir arquivos" (avançado) lê o HTML salvo do ponto', async () => {
    escolhaArquivos = [FIXTURE]
    await js(wc, `document.getElementById('btnHtml').click()`)
    // textContent: o nome fica dentro do <details> "Avançado", fechado (innerText vem vazio).
    await esperar('arquivo escolhido', async () => /ponto-sintetico\.html/.test(await js(wc, `document.getElementById('htmlName').textContent`)))
    await js(wc, `document.getElementById('btnSim').click()`)
    await esperar('simulação do arquivo', async () => /Conferir arquivos do ponto[\s\S]*Simulação\./.test(await resposta()))
    escolhaArquivos = []
  })

  await passo('"Desfazer escrita anterior" pelo relatório apaga o que o bot gravou em 28/09', async () => {
    const rel = path.join(USERDATA, 'relatorios')
    const arq = fs.readdirSync(rel).find(f => /^2026-09-28_escrita_.*\.json$/.test(f))
    if (!arq) throw new Error('relatório da escrita de 28/09 não foi salvo')
    escolhaArquivos = [path.join(rel, arq)]
    await js(wc, `document.getElementById('btnDesfazerAnt').click()`)
    await esperar('desfeito', async () => /Desfeito\. Apaguei 4 células/.test(await resposta()))
    igual(['AH8', 'AH9', 'AH10', 'AH16', 'AH12', 'AH14'].map(c => celula('Setembro', c)), ['', '', '', '', 'FE', 'FO'], 'só o que o bot gravou foi apagado')
    escolhaArquivos = []
  })

  await passo('tela "Horários e regras": carrega, lista colaboradores e salva no arquivo local', async () => {
    await js(wc, `window.agent.abrirRegras()`)
    const r = await janela('regras.html')
    const rc = r.webContents
    await esperar('regras carregadas', () => js(rc, `document.getElementById('entrada_padrao').value === '08:00'`))
    await esperar('colaboradores da BASE', () => js(rc, `[...document.querySelectorAll('#colabs option')].some(o => /FELIPE SEMLINHA/.test(o.value + o.label + o.textContent))`))
    await foto(r, '4-regras')
    await js(rc, `(() => { const t = document.getElementById('tolerancia_min'); t.value = '7'; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await esperar('Salvar habilitado', () => js(rc, `!document.getElementById('btnSalvar').disabled`))
    await js(rc, `document.getElementById('btnSalvar').click()`)
    await esperar('regras gravadas', () => JSON.parse(fs.readFileSync(process.env['REGRAS_PATH']!, 'utf-8')).geral.tolerancia_min === '7')
    // Os ADMs do cenário não estão na BASE DE DADOS → salva, avisa e fica aberta pra ler.
    await esperar('aviso de ADM fora da BASE', async () => r.isDestroyed() || /Salvo\.[\s\S]*ADM 76 não existe/.test(await textoDe(rc, '#msgs')))
    if (!r.isDestroyed()) r.destroy()
  })

  await passo('tela "Configurações": mostra a config, testa planilha e ponto', async () => {
    await js(wc, `window.agent.abrirConfig()`)
    const c = await janela('config.html')
    const cc = c.webContents
    await esperar('config carregada', () => js(cc, `document.getElementById('asUrl').value === ${JSON.stringify(URL_GS)}`))
    await js(cc, `document.getElementById('btnTest').click()`)
    await esperar('teste da planilha', async () => /Conectado a "\[SR\] - Frequência logística 2026" \(3 abas\)/.test(await textoDe(cc, '#msg')))
    await js(cc, `document.getElementById('btnTestarPonto').click()`)
    await esperar('teste do ponto', async () => /Login ok — 7 colaborador/.test(await textoDe(cc, '#msgPonto')))
    await foto(c, '5-configuracoes')
    c.destroy()
  })

  await passo('config.json no disco: senha e token cifrados (não em texto puro)', async () => {
    const disco = fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf-8')
    if (/senha-e2e|tok-e2e/.test(disco)) throw new Error('segredo em texto puro no config.json')
  })

  await passo('IPC "simular" recusa arquivo que não veio do seletor (ex.: C:\\Windows\\win.ini)', async () => {
    const r = await js(wc, `window.agent.simular({ htmlPaths: ['C:\\\\Windows\\\\win.ini'] })`)
    igual([r.ok, /Selecionar HTML/.test(r.message)], [false, true], 'resposta da IPC')
  })

  // Por último: derruba um handler, como quando a tela é mais nova que o app aberto.
  await passo('app antigo aberto (handler ausente): mensagem pra reiniciar, tela não trava', async () => {
    await escolherDia('2026-09-30', true)
    await js(wc, `document.querySelector('#chips [data-cmd="dia"]').click()`)
    await esperar('simulação de 30/09', async () => /Simulação\./.test(await resposta()))
    ipcMain.removeHandler('escrever')
    await clicarTexto(wc, '#resposta button', /^Gravar agora/)
    await esperar('mensagem de reiniciar', async () => /mais antigo que esta tela/.test(await resposta()), 8000)
    if (await ocupada()) throw new Error('a tela ficou presa em "Trabalhando…"')
  })

  await passo('nenhum erro no console das telas e nenhuma chamada fora do mundo simulado', async () => {
    igual(errosConsole, [], 'erros no console')
    igual(rede.bloqueadas, [], 'chamadas de rede inesperadas')
  })
}

// ── execução ────────────────────────────────────────────────────────────────
const vigia = setTimeout(() => { console.log('  ✖ E2E passou de 4 minutos — abortado'); app.exit(2) }, 240_000)
app.whenReady().then(async () => {
  console.log(`\nE2E do app (pasta temporária: ${DIR})`)
  try { await roteiro() } catch (e: any) { resultados.push({ passo: 'roteiro', ok: false, erro: e.stack, ms: 0 }); console.log(e.stack) }
  clearTimeout(vigia)
  const falhas = resultados.filter(r => !r.ok)
  fs.writeFileSync(path.join(DIR, 'resultado.json'), JSON.stringify({ resultados, errosConsole }, null, 2))
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} passos ok · telas em ${TELAS}`)
  if (!process.env['E2E_MANTER'] && !falhas.length) try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* Windows */ }
  app.exit(falhas.length ? 1 : 0)
})

require('../../main')
