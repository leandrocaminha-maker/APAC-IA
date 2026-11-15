/**
 * src/services/mensagem-regras.js
 * O que é a mensagem que chegou: texto, mídia, reação, figurinha…
 *
 * ## Por que existe
 *
 * O webhook conhecia texto, imagem, documento, áudio e vídeo. Todo o resto
 * virava `[mensagem não suportada]` e seguia para a Leia como se fosse
 * conversa. Em 30 dias (até 15/11/2026) foram 135 mensagens assim, e em 39
 * delas a Leia respondeu "sua mensagem chegou num formato que eu não consigo
 * abrir" — 27 vezes a um simples ❤️ ou 👍, 4 a uma figurinha.
 *
 * O que essas 135 eram, pelo banco da Evolution: reação (83), mensagem
 * editada ou cifrada que não dá para ler (21), figurinha (16), mensagem
 * automática de outra empresa (modelo, lista, botões: 10) e contato, álbum.
 *
 * ## O que este arquivo decide
 *
 * Só o NOME de cada coisa — `content` e `contentType`. Quem responde ou não
 * continua sendo o webhook, pela regra de sempre: a Leia só abre turno para
 * `text` e `unknown`. Dar nome é o que tira reação e figurinha desse caminho.
 *
 * Três saídas:
 *   - `{ content, contentType, ... }` — grava e segue o caminho normal;
 *   - `null` — não é mensagem (edição ilegível, fixar, voto de enquete, o
 *     cabeçalho de um álbum, reação retirada): não grava nem responde;
 *   - `unknown` — o que ainda não se conhece. Segue como antes, para aparecer.
 *
 * Sem banco e sem rede: recebe o `message` do evento e devolve a leitura.
 */

/** Tipos que a Leia responde. O resto é gravado e fica para quem atende. */
export const TIPOS_QUE_ABREM_TURNO = ['text', 'unknown'];

/** Formatos de imagem que o modelo lê. A figurinha do WhatsApp é `image/webp`. */
export const IMAGEM_LEGIVEL = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Embrulhos: a mensagem de verdade vem dentro de `.message`.
const EMBRULHOS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'associatedChildMessage', 'editedMessage',
];

// Não são mensagem de ninguém para ninguém: são o WhatsApp mexendo numa
// mensagem que já existe, ou avisando de algo que virá em outras mensagens.
const SEM_CONTEUDO = [
  'protocolMessage',          // edição, apagar, sincronização
  'secretEncryptedMessage',   // edição cifrada: não dá para ler
  'pinInChatMessage',         // fixou uma mensagem
  'pollUpdateMessage',        // voto em enquete
  'albumMessage',             // só anuncia quantas fotos vêm; cada foto chega sozinha
  'senderKeyDistributionMessage',
  'keepInChatMessage',
];

function desembrulhar(msg) {
  let atual = msg;
  for (let i = 0; i < 4; i++) {
    const embrulho = EMBRULHOS.find(e => atual?.[e]?.message);
    if (!embrulho) break;
    atual = atual[embrulho].message;
  }
  return atual || {};
}

/** O texto de uma mensagem automática de empresa (modelo, lista, botões). */
function textoAutomatico(msg) {
  const modelo = msg.templateMessage?.hydratedTemplate || msg.templateMessage?.hydratedFourRowTemplate;
  if (modelo) return [modelo.hydratedTitleText, modelo.hydratedContentText].filter(Boolean).join('\n');
  if (msg.listMessage) return [msg.listMessage.title, msg.listMessage.description].filter(Boolean).join('\n');
  if (msg.buttonsMessage) return msg.buttonsMessage.contentText || '';
  if (msg.interactiveMessage) return msg.interactiveMessage.body?.text || '';
  return null;
}

/**
 * Lê o `message` de um evento `messages.upsert`.
 *
 * @param {object} mensagem - `data.message` do evento da Evolution.
 * @returns {null | {
 *   content: string,
 *   contentType: string,
 *   descritivel?: boolean,   // imagem ou figurinha que dá para descrever
 *   legenda?: string,        // a legenda da imagem, quando há
 * }}
 */
export function lerMensagem(mensagem) {
  const msg = desembrulhar(mensagem);

  if (msg.conversation) return { content: msg.conversation, contentType: 'text' };
  if (msg.extendedTextMessage?.text) return { content: msg.extendedTextMessage.text, contentType: 'text' };

  if (msg.imageMessage) {
    const legenda = msg.imageMessage.caption || '';
    return {
      content: legenda || '[imagem]',
      contentType: 'image',
      legenda,
      descritivel: IMAGEM_LEGIVEL.includes(String(msg.imageMessage.mimetype || 'image/jpeg').split(';')[0].trim()),
    };
  }

  if (msg.stickerMessage) {
    return {
      content: '[figurinha]',
      contentType: 'sticker',
      // Animada é uma sequência de quadros (ou Lottie): fica só com o nome.
      descritivel: !msg.stickerMessage.isAnimated && !msg.stickerMessage.isLottie,
    };
  }

  if (msg.documentMessage) {
    return { content: msg.documentMessage.fileName || msg.documentMessage.caption || '[documento]', contentType: 'document' };
  }

  if (msg.audioMessage) return { content: '[áudio]', contentType: 'audio' };

  // No WhatsApp o GIF é um vídeo MP4 com a marca `gifPlayback`.
  if (msg.videoMessage?.gifPlayback) return { content: msg.videoMessage.caption || '[gif]', contentType: 'gif' };
  if (msg.videoMessage) return { content: msg.videoMessage.caption || '[vídeo]', contentType: 'video' };
  if (msg.ptvMessage) return { content: '[vídeo]', contentType: 'video' };

  if (msg.reactionMessage) {
    // Texto vazio é a reação RETIRADA.
    const emoji = String(msg.reactionMessage.text || '').trim();
    return emoji ? { content: `[reagiu com ${emoji}]`, contentType: 'reaction' } : null;
  }

  if (msg.contactMessage) {
    return { content: `[contato] ${msg.contactMessage.displayName || ''}`.trim(), contentType: 'contact' };
  }
  if (msg.contactsArrayMessage) {
    const nomes = (msg.contactsArrayMessage.contacts || []).map(c => c.displayName).filter(Boolean).join(', ');
    return { content: `[contatos] ${nomes}`.trim(), contentType: 'contact' };
  }

  if (msg.locationMessage || msg.liveLocationMessage) {
    const local = msg.locationMessage || msg.liveLocationMessage;
    const nome = [local.name, local.address].filter(Boolean).join(' — ');
    return { content: `[localização]${nome ? ` ${nome}` : ''}`, contentType: 'location' };
  }

  if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) {
    const enquete = msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3;
    return { content: `[enquete] ${enquete.name || ''}`.trim(), contentType: 'poll' };
  }

  if (msg.buttonsResponseMessage) {
    const texto = msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId || '';
    return texto ? { content: texto, contentType: 'text' } : null;
  }
  if (msg.listResponseMessage) {
    const texto = msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply?.selectedRowId || '';
    return texto ? { content: texto, contentType: 'text' } : null;
  }

  // Modelo, lista, botões: só conta comercial (API da Meta) e robô mandam.
  // Fica gravado, com o texto, para quem atende ver; a Leia não conversa
  // com o robô de outra empresa.
  const automatico = textoAutomatico(msg);
  if (automatico !== null) {
    return {
      content: `[mensagem automática de empresa]${automatico ? ` ${automatico}` : ''}`,
      contentType: 'automated',
    };
  }

  if (SEM_CONTEUDO.some(chave => msg[chave])) return null;

  return { content: '[mensagem não suportada]', contentType: 'unknown' };
}

/**
 * O texto que fica gravado depois de a imagem (ou figurinha) ser descrita.
 *
 * A marca vem na frente, como no áudio (`[áudio] …`): quem lê o histórico —
 * a Leia, o consultor no painel — sabe que aquilo é uma descrição, e não
 * algo que a pessoa escreveu. A legenda, que a pessoa ESCREVEU, vem antes.
 *
 * @param {object} p
 * @param {'image'|'sticker'} p.contentType
 * @param {string} p.descricao
 * @param {string} [p.legenda]
 */
export function textoDescrito({ contentType, descricao, legenda = '' }) {
  const marca = contentType === 'sticker' ? '[figurinha]' : '[imagem]';
  const corpo = `${marca} ${String(descricao).replace(/\s+/g, ' ').trim()}`;
  return legenda ? `${legenda}\n${corpo}` : corpo;
}
