/**
 * src/services/resposta-regras.js
 * Quando a Leia responde a quem escreveu: agora, ou na fila espaçada.
 *
 * ## O que faltava
 *
 * O webhook tratava toda mensagem recebida como escrita naquele segundo. Em
 * 14/11/2026 a sessão voltou de uma falha e o WhatsApp entregou 104
 * mensagens de uma vez — a mais nova tinha 16 horas, a mais velha 28. A
 * Leia respondeu 23 conversas em 36 segundos, como se 23 pessoas tivessem
 * acabado de escrever. Nada no sistema lia o `messageTimestamp`, que é a
 * hora em que a pessoa mandou.
 *
 * ## As duas regras
 *
 *   - **Atrasada.** Mensagem escrita há mais de `atrasoMin` minutos. Entrega
 *     normal leva segundos; minutos de diferença só aparecem quando alguma
 *     coisa represou. A resposta sai, mas pela fila espaçada, e a Leia fica
 *     sabendo do atraso para pedir desculpas em vez de responder um "boa
 *     tarde" de ontem.
 *   - **Rajada.** Mais de `rajadaMax` turnos da Leia começando no mesmo
 *     minuto. Pega o que a primeira regra não pega (mensagens novas que
 *     chegam juntas por qualquer motivo) sem depender de saber a causa.
 *
 * Quem escreve de novo AGORA sai da fila: a conversa está viva, e a
 * resposta é para já.
 *
 * Aqui só as regras, sem banco nem relógio: o webhook lê e age.
 */

const TIMEZONE = 'America/Sao_Paulo';

/**
 * A hora em que a pessoa mandou a mensagem, segundo o WhatsApp.
 *
 * A Evolution entrega `messageTimestamp` em segundos — como número, como
 * texto, ou como o `Long` do protobuf (`{ low, high }`), conforme o caminho
 * por onde a mensagem passou lá dentro.
 *
 * @returns {Date|null} `null` quando não dá para ler: quem chama trata como
 *   mensagem nova, que é o comportamento de sempre.
 */
export function instanteDaMensagem(bruto) {
  let segundos = null;

  if (typeof bruto === 'number') segundos = bruto;
  else if (typeof bruto === 'string' && /^\d+$/.test(bruto.trim())) segundos = Number(bruto);
  else if (bruto && typeof bruto === 'object' && Number.isFinite(bruto.low)) {
    segundos = (bruto.high || 0) * 2 ** 32 + (bruto.low >>> 0);
  }

  if (!Number.isFinite(segundos) || segundos <= 0) return null;
  // Em milissegundos, por garantia: 1e12 s seria o ano 33658.
  const ms = segundos > 1e12 ? segundos : segundos * 1000;
  const data = new Date(ms);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * Há quantos minutos a mensagem foi escrita.
 *
 * Relógio adiantado do outro lado não vira atraso negativo: fica em zero.
 *
 * @param {Date|null} enviadaEm
 * @param {Date} [agora]
 * @returns {number} 0 quando não há hora de envio.
 */
export function atrasoEmMinutos(enviadaEm, agora = new Date()) {
  if (!enviadaEm) return 0;
  return Math.max(0, (agora.getTime() - enviadaEm.getTime()) / 60_000);
}

/** A mensagem chegou atrasada? `limiarMin` em 0 desliga a regra. */
export function ehAtrasada(atrasoMin, limiarMin) {
  return limiarMin > 0 && atrasoMin > limiarMin;
}

/**
 * O turno da Leia começa agora ou entra na fila espaçada?
 *
 * @param {object} p
 * @param {boolean} p.atrasada - Todas as mensagens do turno chegaram atrasadas.
 * @param {number[]} p.iniciosRecentes - Instantes (ms) em que turnos começaram.
 * @param {number} p.agora
 * @param {number} p.rajadaMax - 0 desliga a regra da rajada.
 * @returns {'atrasada'|'rajada'|null} O motivo para segurar, ou `null`.
 */
export function motivoParaSegurar({ atrasada, iniciosRecentes, agora, rajadaMax }) {
  if (atrasada) return 'atrasada';
  if (rajadaMax > 0) {
    const noMinuto = iniciosRecentes.filter(t => agora - t < 60_000).length;
    if (noMinuto >= rajadaMax) return 'rajada';
  }
  return null;
}

/** "há 40 minutos", "há cerca de 23 horas", "há 3 dias". */
export function haQuantoTempo(atrasoMin) {
  if (atrasoMin < 90) return `há ${Math.max(1, Math.round(atrasoMin))} minutos`;
  const horas = Math.round(atrasoMin / 60);
  if (horas < 48) return `há cerca de ${horas} horas`;
  return `há ${Math.round(horas / 24)} dias`;
}

/**
 * O bloco que avisa a Leia de que ela está respondendo tarde.
 *
 * Vai na camada 3 do system (por conversa, depois do breakpoint de cache).
 *
 * @param {object} p
 * @param {Date} p.enviadaEm - A mensagem mais antiga do turno.
 * @param {Date} [p.agora]
 * @returns {string[]} Linhas do bloco.
 */
export function contextoDoAtraso({ enviadaEm, agora = new Date() }) {
  const formatar = (opcoes) =>
    new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, ...opcoes }).format(enviadaEm);
  const quando =
    `${formatar({ weekday: 'long' })}, ${formatar({ day: '2-digit', month: '2-digit' })}, ` +
    `às ${formatar({ hour: '2-digit', minute: '2-digit' })}`;

  return [
    '',
    '## MENSAGEM QUE CHEGOU ATRASADA',
    `A mensagem que você vai responder foi escrita ${haQuantoTempo(atrasoEmMinutos(enviadaEm, agora))} ` +
      `(${quando}) e só chegou agora, por uma falha do nosso WhatsApp. A pessoa ficou esse tempo sem resposta.`,
    '- Comece pedindo desculpas pela demora, em uma frase curta, sem explicar a falha.',
    '- Não devolva o cumprimento do horário em que ela escreveu ("bom dia", "boa noite"): vale a hora de agora.',
    '- "Hoje", "amanhã" e horários que ela citou valem para o dia em que escreveu. Confira com a data de ' +
      'agora antes de confirmar ou propor qualquer coisa, e não ofereça horário que já passou.',
  ];
}
