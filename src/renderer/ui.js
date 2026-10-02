// Utilidades comuns das telas (Início, Horários e regras, Configurações,
// Relatórios). Script clássico, carregado antes do script de cada tela: o que
// é declarado aqui fica global pra elas — por isso as telas não redeclaram.

const $ = id => document.getElementById(id)
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const SEM = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

// el('div', { className, textContent, html, style: 'a:b', onClick }, ...filhos)
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'html') e.innerHTML = v
    else if (k === 'style' && typeof v === 'string') e.style.cssText = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k in e) e[k] = v
    else e.setAttribute(k, v)
  }
  e.append(...kids.filter(k => k !== null && k !== undefined && k !== false))
  return e
}

function plural(n, um, varios) { return `${n} ${n === 1 ? um : varios}` }

// ── datas (sempre "AAAA-MM-DD" local, nunca com fuso) ──
function isoDe(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function hojeISO() { return isoDe(new Date()) }
function deISO(s) { const [a, m, d] = s.split('-').map(Number); return new Date(a, m - 1, d) }
function somarDias(iso, n) { const d = deISO(iso); d.setDate(d.getDate() + n); return isoDe(d) }
function dataCurta(iso) { const d = deISO(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}` }
function nomeDia(iso) { return `${SEM[deISO(iso).getDay()]} ${dataCurta(iso)}` }
function diaLongo(iso) { return `${SEMANA[deISO(iso).getDay()]}, ${dataCurta(iso)}` }
function horaDe(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function horaAgora() { return horaDe(new Date()) }
// "Hoje, 14:05" / "Ontem, 09:12" / "28/09, 17:40"
function quando(isoData) {
  const d = new Date(isoData), h = horaDe(d), dia = isoDe(d)
  return dia === hojeISO() ? `Hoje, ${h}` : dia === somarDias(hojeISO(), -1) ? `Ontem, ${h}` : `${dataCurta(dia)}, ${h}`
}

// IPC que rejeita (ex.: tela nova com o app antigo ainda aberto) vira {ok:false}
// com mensagem legível — a tela nunca fica presa em "Trabalhando…".
async function ipc(fn) {
  try { return await fn() } catch (err) {
    const msg = String((err && err.message) || err)
    return { ok: false, message: /No handler registered/.test(msg)
      ? 'O app aberto é mais antigo que esta tela — saia pelo ícone da bandeja (Sair) e abra de novo.'
      : msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
  }
}
