import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { Plano } from './core/planner'
import { relatorioTexto } from './core/relatorio'
import { abrirGateway, criarAbasConfig, desfazerEscrita, executarEscrita, salvarRelatorio, simularLote, type ResultadoEscrita } from './service'

const AJUDA = `
Uso:
  node dist/cli.js simular  --html seg.html [--html ter.html ...] [--xlsx copia.xlsx]
                            [--entrada-padrao 08:00 --tolerancia 5] [--forcar]
  node dist/cli.js escrever --plano relatorios/<arquivo>.json
  node dist/cli.js desfazer --escrita relatorios/<data>_escrita_<hora>.json
  node dist/cli.js criar-abas-config

  simular            Gera o relatório do que SERIA escrito (nada é gravado), um por
                     dia — a data vem de dentro de cada HTML; domingos e colunas
                     ocultas (feriados) são pulados. Salva .txt e .json em
                     ./relatorios. Padrão: planilha do Google do config.json; com
                     --xlsx lê uma cópia local (só leitura).
  escrever           Aplica EXATAMENTE o plano .json de uma simulação revisada.
                     Relê cada célula antes e pula as que alguém preencheu.
  desfazer           Apaga as células de uma escrita que ainda tiverem o código
                     gravado pelo bot (o que alguém mudou depois fica).
  criar-abas-config  Cria na planilha as abas CONFIG_* que faltarem (só cabeçalho).

  --config caminho   config.json alternativo (padrão: ./config.json)
`

// --html pode repetir (um arquivo por dia); os demais valem a última ocorrência.
function args(argv: string[]): Record<string, string | boolean> & { htmls: string[] } {
  const out: Record<string, string | boolean> = {}
  const htmls: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      if (a === '--html') htmls.push(next)
      else out[a.slice(2)] = next
      i++
    } else out[a.slice(2)] = true
  }
  return Object.assign(out, { htmls }) as Record<string, string | boolean> & { htmls: string[] }
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
    if (!a.htmls.length) throw new Error('Informe --html com o arquivo salvo da tela do ponto (um --html por dia).')
    const gw = abrirGateway(typeof a['xlsx'] === 'string' ? a['xlsx'] : undefined)
    const lote = await simularLote(gw, {
      htmls: a.htmls.map(f => ({ arquivo: path.basename(f), html: fs.readFileSync(f, 'utf-8') })),
      forcar: !!a['forcar'],
      overrides: {
        entradaPadrao: typeof a['entrada-padrao'] === 'string' ? a['entrada-padrao'] : undefined,
        toleranciaMin: typeof a['tolerancia'] === 'string' ? Number(a['tolerancia']) : undefined,
      },
    })
    for (const plano of lote.planos) {
      console.log(relatorioTexto(plano, 'simulacao'))
      const arq = salvarRelatorio(plano, 'simulacao')
      console.log(`\nRelatório salvo em ${arq}`)
      if (plano.escritas.length) console.log(`Para gravar: node dist/cli.js escrever --plano "${arq.replace(/\.txt$/, '.json')}"`)
      console.log('\n' + '═'.repeat(70) + '\n')
    }
    for (const p of lote.pulados) console.log(`PULADO ${p.data} (${p.arquivo}): ${p.motivo}`)
    for (const e of lote.erros) console.log(`ERRO ${e.data ?? ''} (${e.arquivo}): ${e.motivo}`)
    if (lote.erros.length) process.exitCode = 1
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
