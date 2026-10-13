/**
 * src/services/pesquisa-regras.js
 * As regras da pesquisa pelo número alternativo. PURO: sem banco e sem
 * envio — o que entra e sai pelo WhatsApp está em `pesquisa.js`.
 *
 * ## O que este caminho tem de diferente da campanha de venda
 *
 * A campanha de venda sai pelo número principal, que a pessoa conhece, e o
 * texto é escrito pelo modelo. A pesquisa sai por um número que NINGUÉM tem
 * salvo, e isso muda três coisas:
 *
 *   1. **Nenhum texto é gerado.** A abertura existe para a pessoa acreditar
 *      que é a academia, e ela faz isso com fatos conferíveis — o número de
 *      atendimento, a recepção. Fato conferível não pode variar de mensagem
 *      para mensagem. O que varia é a redação, entre versões escritas por
 *      uma pessoa (`---` separa uma da outra).
 *
 *   2. **O link não vai na primeira mensagem.** Número desconhecido mandando
 *      link é o desenho de um golpe, e o WhatsApp trata assim: o link de
 *      quem não é contato chega sem ser clicável, até a pessoa responder ou
 *      salvar o número. A abertura pede a resposta; a resposta libera o
 *      link e é o que conta a favor do número.
 *
 *   3. **Ninguém conversa por lá.** Não há Leia no número alternativo. São
 *      no máximo três mensagens fixas por pessoa, e depois silêncio — quem
 *      quer assunto é apontado para o número de atendimento.
 *
 * ## Quem falou o quê (`wa_message_queue.source_app`, `wa_alt_mensagens.origem`)
 *
 *   alt:campanha:<slug>  a abertura — abre a conversa e CONTA no teto
 *   alt:link:<slug>      o link que saiu por prazo, sem resposta — não conta
 *   alt:auto             as respostas fixas deste arquivo — não contam
 *
 * O prefixo `alt:` é o que separa as duas pistas da fila: a do número
 * principal nunca pega uma linha `alt:`, com ou sem número alternativo
 * configurado — pesquisa não sai pelo número de atendimento nem por engano.
 */

export const PREFIXO_ALT = 'alt:';
export const PREFIXO_LINK = 'alt:link:';
export const ORIGEM_AUTO = 'alt:auto';
export const origemAbertura = (slug) => `alt:campanha:${slug}`;
export const origemLink = (slug) => `${PREFIXO_LINK}${slug}`;
export const ehOrigemDeLink = (origem) => String(origem ?? '').startsWith(PREFIXO_LINK);

/** Pesquisa sai pelo número alternativo, sempre — não há pesquisa pelo principal. */
export const ehPesquisa = (campanha) => campanha?.finalidade === 'pesquisa';

/**
 * Em que ponto cada pessoa está (`crm_campanha_alvos.etapa_conversa`).
 *
 * O prefixo `pesquisa_` não é enfeite: é por ele que o webhook do número
 * principal deixa estes alvos em paz. Sem isso, um aluno que escrevesse ao
 * atendimento no meio da pesquisa teria o alvo dado como "respondeu", e a
 * porta de consentimento da campanha de venda leria o "sim" dele.
 */
export const ETAPA = {
  aguardando: 'pesquisa_aguardando',     // abertura enviada, esperando resposta
  esclarecida: 'pesquisa_esclarecida',   // respondeu outra coisa; explicamos e pedimos SIM
  link: 'pesquisa_link',                 // o link foi (ou está indo)
  encerrada: 'pesquisa_encerrada',       // escreveu depois do link; agradecemos
  recusou: 'pesquisa_recusou',
  saiu: 'pesquisa_saiu',                 // pediu SAIR ao número alternativo
};
export const PREFIXO_ETAPA = 'pesquisa_';

// ──────────────────────────────────────────────
// Teto do dia — a rampa de aquecimento
// ──────────────────────────────────────────────

/**
 * Corte do teto diário, seja o que for escrito no `.env`. Acima disto, num
 * número Baileys abordando quem não o tem salvo, não é mais regulagem: é a
 * faixa em que os números caem.
 */
export const TETO_MAXIMO = 150;

// O Brasil não tem horário de verão desde 2019 — mesma constante, pelo mesmo
// motivo, de `limite-envio.js`.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const diaSP = (quando) => Math.floor((new Date(quando).getTime() + OFFSET_SP_MS) / DIA_MS);

/** Dias corridos desde a primeira abertura da instância: 0 no dia em que ela saiu. */
export function diasDeUso(primeiraEm, agora = new Date()) {
  if (!primeiraEm) return 0;
  return Math.max(0, diaSP(agora) - diaSP(primeiraEm));
}

/**
 * O teto de hoje. Nos primeiros dias vale o degrau da rampa; depois, o teto
 * cheio. O degrau nunca passa do teto — baixar o teto baixa a rampa junto.
 */
export function tetoDoDia(dia, { tetoDiario, rampa = [] } = {}) {
  const cheio = Math.min(Math.max(0, Number(tetoDiario) || 0), TETO_MAXIMO);
  const degrau = rampa[dia];
  return degrau == null ? cheio : Math.min(Math.max(0, degrau), cheio);
}

// ──────────────────────────────────────────────
// Os textos
// ──────────────────────────────────────────────

/**
 * A abertura que vale quando a campanha não traz a sua. Três redações do
 * mesmo recado, cada uma com o que dá credibilidade a um número novo: o
 * nome da pessoa, o porquê do número diferente, um jeito de conferir fora
 * daqui, UMA pergunta fácil no fim e a saída.
 *
 * Nenhuma tem link, e `problemasDosModelos` recusa a que tiver.
 */
export const ABERTURA_PADRAO = [
  'Oi, {nome}! Aqui é da direção da AP Academia 💙\n\n' +
  'Este é o número que a gente usa para pesquisas — por isso é diferente do WhatsApp de atendimento, ' +
  'que continua sendo o {numero_principal}.\n\n' +
  'Estamos ouvindo os alunos para melhorar a academia, e a sua opinião conta. ' +
  'Posso te enviar o link?\n\n' +
  'Se preferir não receber mensagens deste número, é só responder SAIR.',

  'Olá, {nome}! Aqui é da direção da AP Academia.\n\n' +
  'Estamos fazendo uma pesquisa de satisfação com os alunos, e ela sai por este número, separado do atendimento. ' +
  'Se quiser confirmar que somos nós, é só perguntar na recepção ou chamar no WhatsApp de sempre: {numero_principal}.\n\n' +
  'Posso te enviar o link?\n\n' +
  'Para não receber mais mensagens por aqui, responda SAIR.',

  '{nome}, oi! Aqui é da direção da AP Academia.\n\n' +
  'Queremos saber como está sendo a sua experiência com a gente, e preparamos uma pesquisa para os alunos. ' +
  'Ela está sendo enviada por este número, que é da academia mas não é o do atendimento — ' +
  'o atendimento segue no {numero_principal}.\n\n' +
  'Posso te enviar o link?\n\n' +
  'Se não quiser receber mensagens deste número, responda SAIR.',
].join('\n---\n');

export const LINK_PADRAO =
  '{nome}, este é o link da pesquisa de satisfação da AP Academia:\n{link}\n\n' +
  'A sua opinião ajuda muito a gente a melhorar. A gente agradece! 💙';

/** Vai junto do link que saiu por prazo: sem resposta, ele chega sem ser clicável. */
export const DICA_DO_LINK =
  'Se o link não abrir, responda qualquer coisa por aqui ou salve este número — ' +
  'o WhatsApp só libera link de contato conhecido.';

export const TEXTOS = {
  saida: 'Prontinho, não te mando mais mensagem por este número 👍',

  recusa: 'Sem problema, a gente agradece a resposta 🙂',

  // As três de baixo levam o número de atendimento como ENDEREÇO
  // ({link_principal}, um wa.me), e a abertura não. A diferença é quem
  // falou primeiro: estas respondem a alguém que já escreveu, então o link
  // chega clicável e não é "número desconhecido mandando link". O endereço
  // fica no fim da linha, sozinho — pontuação colada entra no link.
  esclarecimento:
    'Aqui é da direção da AP Academia. Este número é o que usamos para a pesquisa de satisfação com os alunos, ' +
    'e ninguém acompanha conversa por ele.\n\n' +
    'Se quiser confirmar que somos nós, pergunte na recepção ou chame no nosso WhatsApp de atendimento, ' +
    '{numero_principal}:\n{link_principal}\n\n' +
    'Quer que eu mande o link da pesquisa? É só responder SIM.',

  encerramento:
    'A gente agradece! 💙 O link da pesquisa está na mensagem acima.\n\n' +
    'Este número é só da pesquisa — para qualquer outro assunto, fale com a gente no WhatsApp de atendimento, ' +
    '{numero_principal}:\n{link_principal}',

  aviso:
    'Oi! Este número da AP Academia é usado só para pesquisas, e ninguém acompanha as mensagens por aqui 🙂\n\n' +
    'Para falar com a gente, chame no WhatsApp de atendimento, {numero_principal}:\n{link_principal}',
};

/**
 * O endereço que abre a conversa com um número: "11 94071-5006" vira
 * `https://wa.me/5511940715006`. Vazio quando não há número.
 */
export function linkDoNumero(numero) {
  const digitos = String(numero ?? '').replace(/\D/g, '');
  if (!digitos) return '';
  // Sem DDI (DDD + número, 10 ou 11 dígitos) é número do Brasil.
  return `https://wa.me/${digitos.length <= 11 ? `55${digitos}` : digitos}`;
}

/** As redações de um modelo. `---` sozinho numa linha separa uma da outra. */
export function variantes(modelo) {
  return String(modelo ?? '')
    .replace(/\r\n/g, '\n')
    .split(/^[ \t]*---[ \t]*$/m)
    .map(v => v.trim())
    .filter(Boolean);
}

/**
 * A redação desta pessoa. Pela semente (o id do alvo), e não por sorteio:
 * reprocessar o mesmo alvo dá o mesmo texto, e a lista se divide por igual.
 */
export function escolherVariante(modelo, semente = 0) {
  const lista = variantes(modelo);
  if (!lista.length) return '';
  return lista[Math.abs(Number(semente) || 0) % lista.length];
}

/**
 * O primeiro nome, como se escreve para uma pessoa. O cadastro do EVO traz
 * "MARIA APARECIDA", "joao", "Teste 2", "." — e o texto não passa por modelo
 * nenhum que conserte isso. O que não parece nome fica sem nome.
 */
export function nomeDeTratamento(nome) {
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  if (primeiro.length < 2 || !/^\p{L}[\p{L}'-]*$/u.test(primeiro)) return null;
  const minusculo = primeiro.toLocaleLowerCase('pt-BR');
  return minusculo.charAt(0).toLocaleUpperCase('pt-BR') + minusculo.slice(1);
}

/**
 * Preenche `{nome}`, `{link}`, `{numero_principal}` e `{link_principal}` (o
 * wa.me do número de atendimento).
 *
 * Sem nome o marcador sai com a vírgula que o acompanhava — "Oi, {nome}!"
 * vira "Oi!", e "{nome}, oi!" vira "Oi!" —, em vez de sobrar "Oi, !".
 */
export function preencher(modelo, { nome = null, link = '', numeroPrincipal = '' } = {}) {
  let texto = String(modelo ?? '').replace(/\r\n/g, '\n');

  texto = nome
    ? texto.replaceAll('{nome}', nome)
    : texto
      .replace(/,?[ \t]*\{nome\}/g, '')
      .replace(/^[ \t]*[,!.:;][ \t]*(\p{L})/gmu, (_, letra) => letra.toLocaleUpperCase('pt-BR'));

  return texto
    .replaceAll('{link}', link)
    .replaceAll('{numero_principal}', numeroPrincipal)
    .replaceAll('{link_principal}', linkDoNumero(numeroPrincipal))
    .trim();
}

/** A abertura desta pessoa. */
export function textoDeAbertura(alvo, campanha, { numeroPrincipal = '' } = {}) {
  const modelo = escolherVariante(campanha?.mensagem_abertura || ABERTURA_PADRAO, alvo?.id);
  return preencher(modelo, { nome: nomeDeTratamento(alvo?.nome), numeroPrincipal });
}

/**
 * A mensagem do link desta pessoa. Vazio quando a campanha não tem link —
 * quem chama não envia nada, em vez de mandar a frase sem o endereço.
 */
export function textoDoLink(alvo, campanha, { numeroPrincipal = '', semResposta = false } = {}) {
  if (!campanha?.link) return '';
  const modelo = escolherVariante(campanha.mensagem_link || LINK_PADRAO, alvo?.id);
  const texto = preencher(modelo, {
    nome: nomeDeTratamento(alvo?.nome), link: campanha.link, numeroPrincipal,
  });
  return semResposta ? `${texto}\n\n${DICA_DO_LINK}` : texto;
}

/** Uma resposta fixa, com o número de atendimento no lugar. */
export function textoFixo(qual, { numeroPrincipal = '' } = {}) {
  return preencher(TEXTOS[qual], { numeroPrincipal });
}

/**
 * O que está errado nos textos de uma campanha de pesquisa. Lista vazia =
 * pode criar. Conferido na criação, porque depois de ativa o erro já saiu
 * para alguém.
 */
export function problemasDosModelos({ mensagem_abertura, mensagem_link, link } = {}) {
  const problemas = [];

  if (!/^https:\/\/\S+$/.test(String(link ?? ''))) {
    problemas.push('o link da pesquisa precisa começar com https:// e não ter espaço');
  }

  const aberturas = variantes(mensagem_abertura || ABERTURA_PADRAO);
  aberturas.forEach((v, i) => {
    // `\{link` pega os dois marcadores de endereço: {link} e {link_principal}.
    if (/https?:\/\/|www\.|wa\.me|\{link/i.test(v)) {
      problemas.push(`abertura ${i + 1}: tem link — a primeira mensagem de um número novo não leva link`);
    }
    if (!/\bSAIR\b/.test(v)) {
      problemas.push(`abertura ${i + 1}: falta dizer como parar de receber (a palavra SAIR)`);
    }
    if ((v.match(/\?/g) ?? []).length !== 1) {
      problemas.push(`abertura ${i + 1}: precisa de UMA pergunta — é a resposta a ela que libera o link`);
    }
  });

  variantes(mensagem_link || LINK_PADRAO).forEach((v, i) => {
    if (!v.includes('{link}')) problemas.push(`mensagem do link ${i + 1}: falta o marcador {link}`);
  });

  return problemas;
}

// ──────────────────────────────────────────────
// A resposta da pessoa
// ──────────────────────────────────────────────

/**
 * O que chegou ao número alternativo, lido do evento `messages.upsert`.
 *
 * Devolve null para o que não é mensagem de uma pessoa — grupo, status,
 * canal, e os eventos de protocolo que a Evolution também entrega (edição,
 * apagamento, reação retirada).
 *
 * A REAÇÃO vale como resposta: um 👍 na abertura é o "sim" mais comum que
 * existe, e ele não chega como texto.
 *
 * `phone` vem null quando a conta usa LID e o evento não traz o número
 * (`senderPn`): sem número não há como achar o alvo, e quem chama registra
 * isso no log em vez de adivinhar.
 *
 * @returns {{phone: string|null, fromMe: boolean, id: string|null, content: string}|null}
 */
export function lerMensagemRecebida(evento) {
  const data = evento?.data || evento || {};
  const messageData = data.message || data;
  const key = data.key || messageData.key || {};

  const remoteJid = String(key.remoteJid || '');
  if (!remoteJid || /@(g\.us|broadcast|newsletter)$/.test(remoteJid)) return null;

  const msg = messageData.message || messageData;
  let content = null;

  if (msg.conversation) content = msg.conversation;
  else if (msg.extendedTextMessage?.text) content = msg.extendedTextMessage.text;
  else if (msg.reactionMessage) content = msg.reactionMessage.text || null;
  else if (msg.buttonsResponseMessage) content = msg.buttonsResponseMessage.selectedDisplayText || null;
  else if (msg.listResponseMessage) content = msg.listResponseMessage.title || null;
  else if (msg.audioMessage) content = '[áudio]';
  else if (msg.imageMessage) content = msg.imageMessage.caption || '[imagem]';
  else if (msg.videoMessage) content = msg.videoMessage.caption || '[vídeo]';
  else if (msg.documentMessage) content = '[documento]';
  else if (msg.stickerMessage) content = '[figurinha]';

  if (!content) return null;

  const jid = remoteJid.endsWith('@lid') ? String(key.senderPn || key.remoteJidAlt || '') : remoteJid;
  const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');

  return { phone: phone || null, fromMe: Boolean(key.fromMe), id: key.id || null, content: String(content) };
}

/**
 * As formas de um mesmo celular brasileiro: com e sem o nono dígito.
 *
 * O cadastro do EVO traz o número com o 9 (é o que `telefoneValido` exige).
 * O WhatsApp identifica contas antigas, de vários DDDs, SEM ele — e é assim
 * que o número chega no webhook. Comparar por igualdade deixaria a resposta
 * dessas pessoas sem alvo, e elas ficariam sem o link que pediram.
 */
export function formasDoTelefone(phone) {
  const digitos = String(phone ?? '').replace(/\D/g, '');
  if (!digitos) return [];
  if (!digitos.startsWith('55')) return [digitos];
  if (digitos.length === 13 && digitos[4] === '9') return [digitos, digitos.slice(0, 4) + digitos.slice(5)];
  if (digitos.length === 12) return [digitos, `${digitos.slice(0, 4)}9${digitos.slice(4)}`];
  return [digitos];
}

/** Sem acento, minúsculo, só letra, número e interrogação. */
const normalizar = (texto) => String(texto ?? '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}?]+/gu, ' ')
  .trim();

// Ancoradas no começo, como em `campanhas.js`: "não" sozinho recusa; "não
// sei", "não entendi" e "não abriu" pedem ajuda.
const RECUSA = [
  /^nao$/, /^n$/, /^nn$/, /^nao nao\b/,
  /^nao (obrigad|quero|preciso|precisa|tenho interesse|me interessa|vou|posso)/,
  /^(agora|hoje|por enquanto) nao\b/,
  /^sem interesse\b/, /^dispenso\b/, /^negativo\b/, /^deixa (pra la|quieto)\b/,
];

const ACEITE = /\b(sim|pode|podem|claro|manda|mande|mandar|envia|envie|enviar|quero|ok|okay|okey|blz|beleza|bora|vamos|aceito|positivo|certo|certeza|por favor|pfv|fechado|combinado|uhum|aham|ta bom|ta bem)\b/;

// Com uma destas a frase não é um sim, mesmo trazendo "pode" ou "ok".
const DUVIDA = /\b(nao|nunca|nem|golpe|fraude|quem|qual|como|onde|porque|por que)\b/;

const EMOJI_DE_ACEITE = /^(?:\s|👍|👌|✅|🙏|🤝|💪|👏|😀|😃|😄|😁|😊|🙂|😉|❤|💙|[\u{1F3FB}-\u{1F3FF}]|️)+$/u;

/**
 * A pessoa aceitou o link, recusou, ou disse outra coisa?
 *
 * Mais solta que `lerConsentimento`, de `campanhas.js`, e de propósito: lá
 * um "sim" lido errado manda oferta a quem não pediu. Aqui manda o link de
 * uma pesquisa a quem acabou de responder — o erro custa pouco, e exigir o
 * "sim" no começo da frase perderia "bom dia! pode mandar".
 *
 * Pergunta e desconfiança são sempre 'outro': quem escreve "isso é golpe?"
 * não pode receber um link como resposta.
 *
 * @returns {'sim'|'nao'|'outro'}
 */
export function lerResposta(texto) {
  const bruto = String(texto ?? '').trim();
  if (!bruto) return 'outro';
  if (EMOJI_DE_ACEITE.test(bruto)) return 'sim';

  const limpo = normalizar(bruto);
  if (!limpo || limpo.length > 60) return 'outro';

  const semInterrogacao = limpo.replace(/\?/g, ' ').replace(/\s+/g, ' ').trim();
  if (RECUSA.some(re => re.test(semInterrogacao))) return 'nao';

  if (limpo.includes('?') || DUVIDA.test(limpo)) return 'outro';
  if (/^s{1,2}$/.test(limpo) || ACEITE.test(limpo)) return 'sim';
  return 'outro';
}

/**
 * O que fazer com a mensagem de alguém, dado onde a pessoa está.
 *
 *   sair       confirma a saída; nada mais vai a ela por este número
 *   link       manda o link agora
 *   recusar    agradece, sem link
 *   esclarecer explica quem somos e pede SIM — uma vez só
 *   encerrar   agradece e aponta o número de atendimento — uma vez só
 *   aviso      não é alvo da pesquisa: "este número não atende"
 *   silencio   já ouviu tudo o que este número tem a dizer
 *
 * @param {object} p
 * @param {string|null} p.etapa - `etapa_conversa` do alvo; null se não é alvo
 * @param {boolean} p.pedidoDeSaida - `ehPedidoDeSaida`, de `campanhas.js`
 * @param {'sim'|'nao'|'outro'} p.resposta - `lerResposta`
 * @returns {{acao: string, etapa: string|null}}
 */
export function decidirResposta({ etapa = null, pedidoDeSaida = false, resposta = 'outro' } = {}) {
  if (etapa === ETAPA.saiu) return { acao: 'silencio', etapa };
  if (pedidoDeSaida) return { acao: 'sair', etapa: ETAPA.saiu };

  const aceitaOuRecusa = () => {
    if (resposta === 'sim') return { acao: 'link', etapa: ETAPA.link };
    if (resposta === 'nao') return { acao: 'recusar', etapa: ETAPA.recusou };
    return null;
  };

  switch (etapa) {
    case ETAPA.aguardando:
      return aceitaOuRecusa() ?? { acao: 'esclarecer', etapa: ETAPA.esclarecida };
    case ETAPA.esclarecida:
      return aceitaOuRecusa() ?? { acao: 'silencio', etapa };
    case ETAPA.link:
      return resposta === 'nao'
        ? { acao: 'recusar', etapa: ETAPA.recusou }
        : { acao: 'encerrar', etapa: ETAPA.encerrada };
    case ETAPA.encerrada:
    case ETAPA.recusou:
      return { acao: 'silencio', etapa };
    default:
      return { acao: 'aviso', etapa: null };
  }
}
