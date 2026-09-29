import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { Plano } from './core/planner'
import { relatorioTexto } from './core/relatorio'
import { hojeISO } from './core/tempo'
import { abrirGateway, criarAbasConfig, desfazerEscrita, executarEscrita, salvarRelatorio, simular, type ResultadoEscrita } from './service'

const AJUDA = `
Uso:
  node dist/cli.js simular  --html ponto.html [--data AAAA-MM-DD] [--xlsx copia.xlsx]
                            [--entrada-padrao 08:00 --tolerancia 5] [--forcar]
  node dist/cli.js escrever --plano relatorios/<arquivo>.json
  node dist/cli.js desfazer --escrita relatorios/<data>_escrita_<hora>.json
  node dist/cli.js criar-abas-config

  simular            Gera o relatório do que SERIA escrito (nada é gravado). Salva
                     .txt e .json em ./relatorios. Padrão: planilha do Google do
                     config.json; com --xlsx lê uma cópia local (só leitura).
  escrever           Aplica EXATAMENTE o plano .json de uma simulação revisada.
                     Relê cada célula antes e pula as que alguém preencheu.
  desfazer           Apaga as células de uma escrita que ainda tiverem o código
                     gravado pelo bot (o que alguém mudou depois fica).
  criar-abas-config  Cria na planilha as abas CONFIG_* que faltarem (só cabeçalho).

  --config caminho   config.json alternativo (padrão: ./config.json)
`

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++ } else out[a.slice(2)] = true
  }
  return out
}

function confirmar(pergunta: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(res => rl.question(pergunta, r => { rl.close(); res(/^s(im)?$/i.test(r.trim())) }))
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const a = args(rest)
  if (typeof a['config'] === 'string') process.env['AGENT_CONFIG_PATH'] = path.resolve(a['config'])
  process.env['LOG_TO_CONSOLE'] = '0'

  if (cmd === 'simular') {
    if (typeof a['html'] !== 'string') throw new Error('Informe --html com o arquivo salvo da tela do ponto.')
    const gw = abrirGateway(typeof a['xlsx'] === 'string' ? a['xlsx'] : undefined)
    const plano = await simular(gw, {
      data: typeof a['data'] === 'string' ? a['data'] : hojeISO(),
      html: fs.readFileSync(a['html'], 'utf-8'),
      forcar: !!a['forcar'],
      overrides: {
        entradaPadrao: typeof a['entrada-padrao'] === 'string' ? a['entrada-padrao'] : undefined,
        toleranciaMin: typeof a['tolerancia'] === 'string' ? Number(a['tolerancia']) : undefined,
      },
    })
    console.log(relatorioTexto(plano, 'simulacao'))
    const arq = salvarRelatorio(plano, 'simulacao')
    console.log(`\nRelatório salvo em ${arq}`)
    console.log(`Para gravar: node dist/cli.js escrever --plano "${arq.replace(/\.txt$/, '.json')}"`)
    return
  }

  if (cmd === 'escrever') {
    if (typeof a['plano'] !== 'string') throw new Error('Informe --plano com o .json gerado pela simulação.')
    const { plano } = JSON.parse(fs.readFileSync(a['plano'], 'utf-8')) as { plano: Plano }
    console.log(`Plano de ${plano.data}, aba "${plano.aba}", gerado em ${plano.geradoEm}`)
    console.log(`${plano.escritas.length} célula(s) a escrever: ${plano.escritas.map(e => `${e.celula}="${e.codigo}"`).join(', ') || '(nenhuma)'}`)
    if (!plano.escritas.length) return
    if (!(await confirmar('Gravar na planilha do Google? (s/N) '))) { console.log('Cancelado.'); return }
    const gw = abrirGateway()
    const r = await executarEscrita(gw, plano)
    console.log(`Escritas: ${r.escritas.length}. Puladas (preenchidas nesse meio tempo): ${r.puladas.length}`)
    for (const p of r.puladas) console.log(`  ${p.celula}: já tinha "${p.valorEncontrado}"`)
    salvarRelatorio(plano, 'escrita', r)
    return
  }

  if (cmd === 'desfazer') {
    if (typeof a['escrita'] !== 'string') throw new Error('Informe --escrita com o .json de uma escrita (relatorios/..._escrita_....json).')
    const { plano, extra } = JSON.parse(fs.readFileSync(a['escrita'], 'utf-8')) as { plano: Plano; extra?: ResultadoEscrita }
    if (!extra?.escritas) throw new Error('Esse arquivo não é o relatório de uma escrita.')
    console.log(`Escrita de ${plano.data}, aba "${plano.aba}": ${extra.escritas.map(e => `${e.celula}="${e.codigo}"`).join(', ') || '(nenhuma célula)'}`)
    if (!extra.escritas.length) return
    if (!(await confirmar('Apagar as células que ainda tiverem o código gravado pelo bot? (s/N) '))) { console.log('Cancelado.'); return }
    const r = await desfazerEscrita(abrirGateway(), plano.aba, extra.escritas)
    console.log(`Apagadas: ${r.apagadas.join(', ') || '(nenhuma)'}`)
    for (const m of r.mantidas) console.log(`  Mantida ${m.celula}: bot "${m.escritoPeloBot}" → agora "${m.valorEncontrado}"`)
    salvarRelatorio(plano, 'desfeita', r)
    return
  }

  if (cmd === 'criar-abas-config') {
    const criadas = await criarAbasConfig(abrirGateway())
    console.log(criadas.length ? `Abas criadas: ${criadas.join(', ')}` : 'Todas as abas CONFIG_* já existem.')
    return
  }

  console.log(AJUDA)
}

main().catch(err => {
  console.error(`ERRO: ${err.message}`)
  process.exit(1)
})
