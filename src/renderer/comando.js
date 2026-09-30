// Intérprete do campo "O que você deseja consultar?" da tela inicial.
// Frases curtas em português viram uma ação do bot — sem IA, só regras
// simples e previsíveis. O que não for entendido vira "ajuda" com exemplos.
// Carregado pela tela (window.interpretarComando) e pelos testes (require).
(function (global) {
  const SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

  function normalizar(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
  }

  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  function deISO(s) {
    const [a, m, d] = s.split('-').map(Number)
    return new Date(a, m - 1, d)
  }

  function somarDias(s, n) {
    const d = deISO(s)
    d.setDate(d.getDate() + n)
    return iso(d)
  }

  // Data citada na frase, ou null. Sem ano = ano de hoje.
  function extrairData(t, hoje) {
    const m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t)
    if (m) {
      const ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : deISO(hoje).getFullYear()
      const d = new Date(ano, Number(m[2]) - 1, Number(m[1]))
      if (d.getMonth() !== Number(m[2]) - 1) return { invalida: `${m[0]} não é uma data válida.` }
      return { data: iso(d) }
    }
    if (/\banteontem\b/.test(t)) return { data: somarDias(hoje, -2) }
    if (/\bontem\b/.test(t)) return { data: somarDias(hoje, -1) }
    if (/\bsemana passada\b/.test(t)) return { data: somarDias(hoje, -7) }
    if (/\bhoje\b/.test(t)) return { data: hoje }
    for (let i = 1; i < SEMANA.length; i++) {
      if (new RegExp(`\\b${SEMANA[i]}\\b`).test(t)) {
        // A mais recente (hoje inclusive) com esse dia da semana.
        const dow = deISO(hoje).getDay()
        return { data: somarDias(hoje, -((dow - i + 7) % 7)) }
      }
    }
    return null
  }

  function interpretarComando(texto, hoje) {
    const t = normalizar(texto)
    if (!t) return { acao: 'ajuda' }
    const simular = /simul|sem gravar|nao grav|so confer|previa/.test(t)

    if (/regra|horario|toleranc|apelido|excec|setor/.test(t)) return { acao: 'regras' }
    if (/config|login|senha|conex|token/.test(t)) return { acao: 'config' }
    if (/relatori/.test(t)) return { acao: 'relatorios' }
    if (/histor|atividade/.test(t)) return { acao: 'historico' }
    if (/\bpendenc|\brevis|\batenc/.test(t)) return { acao: 'pendencias' }
    if (/desfaz/.test(t)) return { acao: 'desfazer' }

    const achou = extrairData(t, hoje)
    if (achou && achou.invalida) return { acao: 'ajuda', erro: achou.invalida }
    const data = achou ? achou.data : null
    if (data && data > hoje) return { acao: 'ajuda', erro: 'Esse dia ainda não aconteceu — escolha hoje ou uma data anterior.' }

    if (/semana/.test(t)) return { acao: 'semana', data: data || hoje, simular }
    if (data || /preench|lanc|confer|frequenc|ponto/.test(t)) return { acao: 'dia', data: data || hoje, simular }
    return { acao: 'ajuda' }
  }

  const api = { interpretarComando, normalizar }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else global.interpretarComando = interpretarComando
})(typeof window !== 'undefined' ? window : globalThis)
