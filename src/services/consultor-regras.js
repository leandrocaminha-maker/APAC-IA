/**
 * src/services/consultor-regras.js
 * Quem responde o cliente logo depois de um consultor falar.
 *
 * Pura: recebe a última mensagem nossa e o que o cliente mandou, e decide.
 * Quem lê o banco e cala a Leia é o webhook.
 *
 * ## Por que existe (30/10/2026)
 *
 * O botão "Devolver para a Leia" é usado como "encerrei": a consultora
 * responde e devolve no mesmo minuto — em 09/10 a Shirlei respondeu a Tais
 * às 6h20 e devolveu 5 segundos depois. Mas o cliente estava falando com
 * ela, e responde: "obrigada", "e amanhã, pode?". Com a conversa devolvida,
 * quem atendia era a Leia, entrando num assunto que não era dela. Em 30/10
 * a Tais agradeceu à Shirlei às 9h57 e a Leia respondeu no minuto seguinte.
 *
 * Não era caso isolado: nos 60 dias até ali, 176 respostas da Leia vieram
 * menos de 6 horas depois da fala de um consultor, 96 delas em menos de 10
 * minutos — várias dizendo "a Shirlei já está com você por aqui".
 *
 * ## A regra
 *
 * Até `janelaHoras` depois da última fala do consultor, a vez é dele:
 *
 *   - O cliente só encerrou (cortesia ou agradecimento curto, sem pergunta)
 *     → ninguém responde, e a conversa segue devolvida à Leia para a
 *     próxima vez. Voltar para o consultor por um "obrigada" desfaria a
 *     devolução e encheria o cartão "aguardando resposta" de despedida.
 *   - Qualquer outra coisa → a conversa volta para o consultor, e cai no
 *     cartão "aguardando resposta" do painel.
 *
 * Se a última fala do consultor foi uma pergunta, a resposta é dele mesmo
 * quando parece cortesia: um "sim" depois de "posso marcar às 9h?" é
 * resposta, não despedida.
 *
 * Passada a janela, a Leia responde como sempre: é assunto novo, e a
 * devolução vale.
 */
import { ehCortesia, normalizar } from './gerencia-regras.js';

const HORA_MS = 60 * 60 * 1000;

/** "obrigada", "obg", "brigadão", "valeu", "agradeço", "grata", "gratidão". */
const AGRADECIMENTO = /\b(obrigad|obgd|obg|brigad|valeu|vlw|agradec|grat[ao]\b|gratidao)/;

/** "Obrigada, mas..." puxa outro assunto. */
const VIRADA = /\b(mas|porem|so que)\b/;

/**
 * Até quantas palavras um agradecimento ainda é só despedida. Os casos
 * reais iam até 8 ("Liguei na academia e já me informei. Obrigado"); quem
 * escreve mais que isso está contando alguma coisa.
 */
const MAX_PALAVRAS_AGRADECIMENTO = 8;

/** A mensagem só encerra: não pede resposta de ninguém. */
export function ehDespedida(conteudo) {
  if (ehCortesia(conteudo)) return true;

  const t = normalizar(conteudo);
  if (t.includes('?') || VIRADA.test(t)) return false;

  const palavras = t.split(' ').filter(p => /[a-z0-9]/.test(p)).length;
  return palavras <= MAX_PALAVRAS_AGRADECIMENTO && AGRADECIMENTO.test(t);
}

/** `human:<email>` (painel) ou `human:whatsapp` (aparelho). */
export function ehDoConsultor(sentBy) {
  return String(sentBy || '').startsWith('human:');
}

/** O e-mail de quem respondeu pelo painel; `null` para o aparelho. */
export function emailDoConsultor(sentBy) {
  const resto = String(sentBy || '').replace(/^human:/, '');
  return resto.includes('@') ? resto : null;
}

/** A última linha da mensagem termina em pergunta (emoji depois do "?" não conta). */
export function terminaEmPergunta(conteudo) {
  return /\?[\s\p{Extended_Pictographic}\u{FE0F}\u{1F3FB}-\u{1F3FF}]*$/u.test(String(conteudo || '').trim());
}

/**
 * Quem responde a mensagem que acabou de chegar.
 *
 * @param {object} p
 * @param {{ sent_by: string, content: string, created_at: string }|null} p.ultimaNossa
 *        a última mensagem que SAIU nesta conversa
 * @param {string} p.conteudo     o que o cliente mandou
 * @param {number} p.janelaHoras  0 desliga a regra
 * @param {Date}   [p.agora]
 * @returns {'leia'|'ninguem'|'consultor'}
 */
export function quemResponde({ ultimaNossa, conteudo, janelaHoras, agora = new Date() }) {
  if (!(janelaHoras > 0)) return 'leia';
  if (!ultimaNossa || !ehDoConsultor(ultimaNossa.sent_by)) return 'leia';

  const desde = agora.getTime() - new Date(ultimaNossa.created_at).getTime();
  if (!(desde < janelaHoras * HORA_MS)) return 'leia';

  if (!terminaEmPergunta(ultimaNossa.content) && ehDespedida(conteudo)) return 'ninguem';
  return 'consultor';
}

export const consultorRegras = { quemResponde, ehDespedida, ehDoConsultor, emailDoConsultor, terminaEmPergunta };
