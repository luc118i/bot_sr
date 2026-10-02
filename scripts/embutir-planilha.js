// Passo do `npm run dist`: põe o link + token do Apps Script da empresa dentro
// do instalador (dist/embutido.json → app.asar). Assim o operador só configura
// o próprio login do ponto e nunca vê o token.
//
// De onde vem (nesta ordem):
//   1. variáveis APPS_SCRIPT_URL e APPS_SCRIPT_TOKEN (ex.: num CI privado);
//   2. planilha.local.json na raiz do projeto: { "apps_script_url": "...", "apps_script_token": "..." }
// Os dois ficam FORA do Git (.gitignore) — o repositório é público.
// Sem nenhum dos dois o build para: melhor falhar do que gerar um instalador
// que pede a planilha pro operador. Para buildar sem planilha: EMBUTIR_PLANILHA=0.
const fs = require('fs')
const path = require('path')

const raiz = path.join(__dirname, '..')
const destino = path.join(raiz, 'dist', 'embutido.json')

if (process.env.EMBUTIR_PLANILHA === '0') {
  fs.rmSync(destino, { force: true })
  console.log('[embutir] EMBUTIR_PLANILHA=0 — instalador SEM planilha (o operador configura).')
  process.exit(0)
}

let dados = null
if (process.env.APPS_SCRIPT_URL && process.env.APPS_SCRIPT_TOKEN) {
  dados = { apps_script_url: process.env.APPS_SCRIPT_URL, apps_script_token: process.env.APPS_SCRIPT_TOKEN }
} else {
  const local = path.join(raiz, 'planilha.local.json')
  if (fs.existsSync(local)) dados = JSON.parse(fs.readFileSync(local, 'utf-8'))
}

if (!dados) {
  console.error('[embutir] Falta a planilha da empresa: crie planilha.local.json ou defina APPS_SCRIPT_URL/APPS_SCRIPT_TOKEN.')
  process.exit(1)
}
const url = String(dados.apps_script_url || '').trim()
const token = String(dados.apps_script_token || '').trim()
if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) {
  console.error('[embutir] apps_script_url inválido — tem que ser o link /exec da implantação.')
  process.exit(1)
}
if (token.length < 16) {
  console.error('[embutir] apps_script_token vazio ou curto demais.')
  process.exit(1)
}

fs.mkdirSync(path.dirname(destino), { recursive: true })
fs.writeFileSync(destino, JSON.stringify({ apps_script_url: url, apps_script_token: token }))
// Nunca imprime o token — só que ele está lá.
console.log(`[embutir] planilha embutida no instalador (link …${url.slice(-12)}, token de ${token.length} caracteres).`)
