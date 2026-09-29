/**
 * Frequência Agent — conector da planilha (Google Apps Script).
 *
 * Alternativa à Service Account: o bot conversa com esta planilha chamando o
 * link deste script publicado como "App da Web". O script roda com a
 * permissão de quem publicou — não precisa de Google Cloud nem de JSON.
 *
 * Instalação (passo a passo completo no README, seção "Conectar via Apps Script"):
 *   1. Cole este arquivo no projeto do Apps Script.
 *   2. Configurações do projeto → Propriedades do script:
 *        TOKEN        = o token gerado nas Configurações do bot (obrigatório)
 *        PLANILHA_ID  = ID da planilha (só se o script NÃO foi criado de dentro
 *                       dela em Extensões → Apps Script)
 *   3. Implantar → Nova implantação → App da Web
 *        Executar como: Eu · Quem pode acessar: Qualquer pessoa
 *   4. Copie o link (termina em /exec) para as Configurações do bot.
 *
 * Segurança: sem o TOKEN certo nada é lido nem gravado. O link + token
 * funcionam como uma chave — ficam só no config.json da máquina do bot.
 * O script só faz o que o bot precisa: ler abas e ler/gravar/limpar células
 * pontuais dos dias. Não cria, apaga nem renomeia abas — as regras do bot
 * ficam num arquivo local da máquina, nunca na planilha.
 */

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents)
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN')
    if (!token) return resposta_({ ok: false, erro: 'O script não tem a propriedade TOKEN configurada.' })
    if (req.token !== token) return resposta_({ ok: false, erro: 'Token inválido.' })

    const acao = ACOES_[req.acao]
    if (!acao) return resposta_({ ok: false, erro: 'Ação desconhecida: ' + req.acao })

    // Uma operação por vez — duas máquinas rodando o bot ao mesmo tempo não
    // se atropelam.
    const lock = LockService.getScriptLock()
    lock.waitLock(30000)
    try {
      return resposta_({ ok: true, dados: acao(planilha_(), req) })
    } finally {
      lock.releaseLock()
    }
  } catch (err) {
    return resposta_({ ok: false, erro: String((err && err.message) || err) })
  }
}

// Só pra testar no navegador que o link está no ar (não expõe dados).
function doGet() {
  return resposta_({ ok: true, servico: 'frequencia-agent', versao: 1 })
}

/**
 * RODE ESTA FUNÇÃO UMA VEZ NO EDITOR (selecione "autorizar" → Executar) e
 * aceite as permissões. É o que libera o App da Web a ler/gravar a planilha
 * em seu nome. No fim, o registro de execução mostra se está tudo pronto.
 */
function autorizar() {
  const ss = planilha_()
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN')
  Logger.log('Planilha: "' + ss.getName() + '" (' + ss.getSheets().length + ' abas) — acesso OK.')
  Logger.log(token
    ? 'TOKEN configurado (' + token.length + ' caracteres). Confira se é o mesmo das Configurações do bot.'
    : 'FALTA o TOKEN: Configurações do projeto → Propriedades do script → adicionar TOKEN = token gerado no bot.')
}

const ACOES_ = {
  info: function (ss) {
    return { titulo: ss.getName(), abas: ss.getSheets().map(function (s) { return s.getName() }) }
  },

  lerGrid: function (ss, req) {
    const sh = ss.getSheetByName(req.aba)
    if (!sh) return null
    const tz = ss.getSpreadsheetTimeZone()
    return sh.getDataRange().getValues().map(function (linha) {
      return linha.map(function (v) { return valor_(v, tz) })
    })
  },

  lerCelulas: function (ss, req) {
    const sh = aba_(ss, req.aba)
    const tz = ss.getSpreadsheetTimeZone()
    if (!req.celulas.length) return []
    return sh.getRangeList(req.celulas).getRanges().map(function (r) { return valor_(r.getValue(), tz) })
  },

  colunasOcultas: function (ss, req) {
    const sh = aba_(ss, req.aba)
    const out = []
    for (var c = 1; c <= sh.getMaxColumns(); c++) if (sh.isColumnHiddenByUser(c)) out.push(c)
    return out
  },

  escrever: function (ss, req) {
    const sh = aba_(ss, req.aba)
    req.valores.forEach(function (v) { sh.getRange(v.celula).setValue(v.valor) })
    return req.valores.length
  },

  limpar: function (ss, req) {
    if (!req.celulas.length) return 0
    aba_(ss, req.aba).getRangeList(req.celulas).clearContent()
    return req.celulas.length
  },
}

function planilha_() {
  const id = PropertiesService.getScriptProperties().getProperty('PLANILHA_ID')
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet()
  if (!ss) throw new Error('Script não está vinculado a uma planilha — configure a propriedade PLANILHA_ID.')
  return ss
}

function aba_(ss, nome) {
  const sh = ss.getSheetByName(nome)
  if (!sh) throw new Error('Aba "' + nome + '" não existe.')
  return sh
}

// Mesmo contrato do conector da Service Account: tudo string; hora como
// "HH:mm", data como "yyyy-MM-dd" (o bot entende os dois).
function valor_(v, tz) {
  if (v === null || v === undefined) return ''
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return v.getFullYear() < 1900 ? Utilities.formatDate(v, tz, 'HH:mm') : Utilities.formatDate(v, tz, 'yyyy-MM-dd')
  }
  return String(v)
}

function resposta_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}
