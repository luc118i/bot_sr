// Roda a suíte (unit + integração + propriedade) em fusos que costumam quebrar
// código de data: UTC, o de Brasília, os extremos (+14/-11), um com meia hora e
// fusos com horário de verão. O bot trabalha com datas LOCAIS — nenhum fuso
// pode mudar o resultado. Uso: npm run test:tz  (precisa de `npm run build:ts`)
const { spawnSync } = require('child_process')

const FUSOS = [
  'America/Sao_Paulo',
  'UTC',
  'Pacific/Kiritimati', // UTC+14
  'Pacific/Pago_Pago',  // UTC-11
  'Asia/Kolkata',       // UTC+5:30
  'America/New_York',   // horário de verão
  'Europe/Lisbon',      // horário de verão, perto de UTC
]

const args = [
  '--enable-source-maps', '--require', './dist/__tests__/helpers/setup.js',
  '--test', '--test-reporter=dot', 'dist/__tests__/**/*.test.js',
]

const falhas = []
for (const tz of FUSOS) {
  process.stdout.write(`\n── TZ=${tz} `)
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, TEST_TZ: tz } })
  if (r.status !== 0) falhas.push(tz)
}
console.log(falhas.length ? `\nFalhou em: ${falhas.join(', ')}` : `\nOK em ${FUSOS.length} fusos.`)
process.exit(falhas.length ? 1 : 0)
