/**
 * src/services/evolution.js
 * Client para a Evolution API v2 (WhatsApp).
 *
 * Docs: https://doc.evolution-api.com/v2/
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const { url, apiKey, instance } = config.evolution;

/** Helper para chamadas à Evolution API. */
async function evoFetch(path, options = {}) {
  const fullUrl = `${url}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    apikey: apiKey,
    ...options.headers,
  };

  logger.debug(`[evolution] ${options.method || 'GET'} ${fullUrl}`);

  const res = await fetch(fullUrl, { ...options, headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(`[evolution] ${res.status} ${fullUrl}`, body);
    throw new Error(`Evolution API ${res.status}: ${body}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

// ──────────────────────────────────────────────
// Conexão / Instância
// ──────────────────────────────────────────────

/** Obtém o status da conexão da instância. */
export async function getConnectionStatus() {
  return evoFetch(`/instance/connectionState/${instance}`);
}

/**
 * Obtém o QR code para conectar a instância.
 *
 * A resposta traz o QR em `base64` no próprio corpo, além de um link
 * montado a partir de SERVER_URL. O painel usa o **base64**, e é isso que
 * permite manter a porta 8080 da Evolution fechada: não é preciso que o
 * navegador do consultor alcance a Evolution, só o backend precisa.
 */
export async function getQrCode() {
  return evoFetch(`/instance/connect/${instance}`);
}

/** Lista as instâncias existentes na Evolution. */
export async function listarInstancias() {
  const lista = await evoFetch('/instance/fetchInstances');
  return Array.isArray(lista) ? lista : [];
}

/**
 * Cria a instância se ela ainda não existir.
 *
 * O nome tem de ser exatamente `EVOLUTION_INSTANCE` — é o que todo o resto
 * do código procura. Criar com outro nome faz o backend responder
 * "instance does not exist" para uma instância que está lá, pareada.
 */
export async function criarInstancia() {
  const existentes = await listarInstancias().catch(() => []);
  const jaExiste = existentes.some(i => (i?.name || i?.instance?.instanceName) === instance);

  if (jaExiste) {
    logger.info(`[evolution] Instância "${instance}" já existe`);
    return { criada: false, instancia: instance };
  }

  logger.info(`[evolution] Criando instância "${instance}"`);
  const resultado = await evoFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName: instance,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });

  return { criada: true, instancia: instance, resultado };
}

/** Desconecta o número sem apagar a instância. */
export async function desconectarInstancia() {
  return evoFetch(`/instance/logout/${instance}`, { method: 'DELETE' });
}

/** Reinicia a instância. */
export async function restartInstance() {
  return evoFetch(`/instance/restart/${instance}`, { method: 'PUT' });
}

// ──────────────────────────────────────────────
// Envio de Mensagens
// ──────────────────────────────────────────────

/**
 * Normaliza o número para o formato JID do WhatsApp.
 * Ex.: "11999999999" → "5511999999999"
 *      "5511999999999" → "5511999999999"
 */
export function normalizePhone(phone) {
  let digits = String(phone).replace(/\D/g, '');
  // Se já tem DDI (55) + DDD + número → 13 dígitos
  if (digits.length === 13 && digits.startsWith('55')) return digits;
  // Se tem DDD + número → 10-11 dígitos, adiciona DDI
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  // Retorna como está (pode ser número estrangeiro)
  return digits;
}

/**
 * Celular brasileiro utilizável para WhatsApp, ou `null`.
 *
 * Diferente de `normalizePhone`, que **formata** o que recebe: esta
 * **recusa** o que não dá para usar. Fixo, número truncado e lixo de
 * cadastro ficam de fora. No lote real de campanha, 46 dos 47 passaram.
 *
 * Nasceu privada em `campanhas.js` e subiu para cá em 28/08/2026, quando a
 * régua de silêncio precisou da mesma checagem. O que motivou: o primeiro
 * envio dela foi para `136030220984483`, lixo de cadastro que passou pelo
 * filtro que existia — só recusava telefone começando com "teste". A
 * Evolution respondeu `exists: false`, mas a mensagem já tinha sido gerada,
 * e o modelo já tinha sido pago. Recusar antes é o que evita o gasto.
 *
 * Duas validações, não uma: 11 dígitos depois do DDI, e o `9` na terceira
 * posição, que é o que distingue celular de fixo no plano brasileiro.
 */
export function telefoneValido(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  const semDdi = digitos.startsWith('55') && digitos.length > 11 ? digitos.slice(2) : digitos;
  if (semDdi.length !== 11) return null;
  if (semDdi[2] !== '9') return null;
  return `55${semDdi}`;
}

/**
 * Envia uma mensagem de texto.
 * @param {string} phone - Número do destinatário
 * @param {string} text - Texto da mensagem
 * @returns {Promise<object>} Resposta da Evolution API
 */
/**
 * Quanto tempo a mensagem fica "digitando" antes de sair, em ms.
 *
 * Proporcional ao texto, entre um piso e um teto. O teto existe porque o
 * `delay` da Evolution **segura a resposta HTTP**: digitar 400 caracteres
 * no ritmo real de um polegar seriam uns 90 segundos pendurados numa
 * chamada, e o ganho sobre 15s é nenhum. A folga aleatória fecha o resto —
 * duas mensagens do mesmo tamanho não podem levar exatamente o mesmo
 * tempo.
 */
function tempoDeDigitacao(texto) {
  const { digitacaoMinMs, digitacaoMaxMs, digitacaoMsPorChar } = config.envio;
  const bruto = digitacaoMinMs + String(texto || '').length * digitacaoMsPorChar;
  const variacao = 1 + (Math.random() * 2 - 1) * 0.25;
  return Math.round(Math.min(Math.max(bruto * variacao, digitacaoMinMs), digitacaoMaxMs));
}

/**
 * Envia uma mensagem de texto.
 *
 * O `delay` não é enfeite. Até 31/08/2026 o corpo era `{ number, text }` e
 * toda mensagem saía com zero tempo de digitação — três linhas escritas
 * instantaneamente, sempre, o que nenhuma pessoa faz. A Evolution usa esse
 * campo para marcar presença "composing" pelo tempo pedido antes de
 * entregar.
 *
 * @param {string} phone - Número do destinatário
 * @param {string} text - Texto da mensagem
 * @param {object} [opts]
 * @param {number} [opts.delayMs] - Sobrescreve o tempo de digitação.
 * @returns {Promise<object>} Resposta da Evolution API
 */
export async function sendText(phone, text, { delayMs } = {}) {
  const number = normalizePhone(phone);
  const delay = delayMs ?? tempoDeDigitacao(text);
  logger.info(`[evolution] sendText → ${number} (${text.length} chars, ${delay}ms digitando)`);

  return evoFetch(`/message/sendText/${instance}`, {
    method: 'POST',
    body: JSON.stringify({ number, text, delay }),
  });
}

/**
 * O número existe no WhatsApp?
 *
 * `telefoneValido` confere FORMATO — 11 dígitos e o 9 na terceira posição.
 * Isto confere existência, que é outra pergunta e só a Meta responde.
 *
 * Por que passou a importar em 31/08/2026: enviar para número morto é um
 * dos sinais mais pesados do detector de spam, e a base fria do EVO
 * (inativos de 2024–2025) vem cheia deles. O sintoma já tinha aparecido
 * uma vez — `136030220984483` recebeu `exists: false` DEPOIS de a mensagem
 * ter sido gerada e o modelo, pago.
 *
 * Na dúvida responde `true`: uma Evolution fora do ar não pode parar a
 * régua inteira, e o gate de formato continua na frente. É o único ponto
 * deste conserto que falha aberto, e de propósito.
 *
 * @returns {Promise<boolean>}
 */
export async function numeroExiste(phone) {
  const number = normalizePhone(phone);

  try {
    const resposta = await evoFetch(`/chat/whatsappNumbers/${instance}`, {
      method: 'POST',
      body: JSON.stringify({ numbers: [number] }),
    });

    const lista = Array.isArray(resposta) ? resposta : [];
    if (!lista.length) return true;   // resposta que não sabemos ler

    return lista[0]?.exists !== false;
  } catch (err) {
    logger.warn(`[evolution] Não deu para conferir se ${number} existe: ${err.message}`);
    return true;
  }
}

/**
 * Envia mídia (imagem, documento, áudio, vídeo).
 * @param {string} phone - Número do destinatário
 * @param {string} mediaUrl - URL pública do arquivo
 * @param {string} [caption] - Legenda (apenas para imagem/vídeo)
 * @param {string} [mediatype] - Tipo: 'image', 'document', 'audio', 'video'
 */
export async function sendMedia(phone, mediaUrl, caption = '', mediatype = 'image') {
  const number = normalizePhone(phone);
  const delay = tempoDeDigitacao(caption);
  logger.info(`[evolution] sendMedia → ${number} (${mediatype}, ${delay}ms digitando)`);

  return evoFetch(`/message/sendMedia/${instance}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      mediatype,
      media: mediaUrl,
      caption,
      delay,
    }),
  });
}

/**
 * Envia mensagem com botões de resposta rápida.
 * @param {string} phone - Número do destinatário
 * @param {string} title - Título da mensagem
 * @param {string} description - Corpo da mensagem
 * @param {Array<{buttonText: string, buttonId: string}>} buttons - Botões (máx 3)
 */
export async function sendButtons(phone, title, description, buttons) {
  const number = normalizePhone(phone);
  logger.info(`[evolution] sendButtons → ${number} (${buttons.length} buttons)`);

  return evoFetch(`/message/sendButtons/${instance}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      title,
      description,
      buttons: buttons.slice(0, 3), // WhatsApp limita a 3
    }),
  });
}

/**
 * Envia mensagem com lista de opções.
 */
export async function sendList(phone, title, description, buttonText, sections) {
  const number = normalizePhone(phone);
  logger.info(`[evolution] sendList → ${number}`);

  return evoFetch(`/message/sendList/${instance}`, {
    method: 'POST',
    body: JSON.stringify({
      number,
      title,
      description,
      buttonText,
      sections,
    }),
  });
}

export const evolution = {
  getConnectionStatus,
  getQrCode,
  listarInstancias,
  criarInstancia,
  desconectarInstancia,
  restartInstance,
  sendText,
  sendMedia,
  sendButtons,
  sendList,
  normalizePhone,
  telefoneValido,
  numeroExiste,
};
