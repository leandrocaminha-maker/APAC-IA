/**
 * src/services/evolution.js
 * Client para a Evolution API v2 (WhatsApp).
 *
 * Docs: https://doc.evolution-api.com/v2/
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { criarPista } from '../lib/pista-envio.js';

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

// O parâmetro `instancia` das funções abaixo existe para o NÚMERO
// ALTERNATIVO (`EVOLUTION_INSTANCE_ALT`, ver `numero-alternativo.js`). Sem
// ele tudo opera na instância principal, como sempre — e é assim que o
// atendimento inteiro chama. Só conexão, pareamento e texto têm o parâmetro:
// é o que o número alternativo faz.

/** Obtém o status da conexão da instância. */
export async function getConnectionStatus(instancia = instance) {
  return evoFetch(`/instance/connectionState/${instancia}`);
}

/**
 * Obtém o QR code para conectar a instância.
 *
 * A resposta traz o QR em `base64` no próprio corpo, além de um link
 * montado a partir de SERVER_URL. O painel usa o **base64**, e é isso que
 * permite manter a porta 8080 da Evolution fechada: não é preciso que o
 * navegador do consultor alcance a Evolution, só o backend precisa.
 */
export async function getQrCode(instancia = instance) {
  return evoFetch(`/instance/connect/${instancia}`);
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
export async function criarInstancia(instancia = instance) {
  const existentes = await listarInstancias().catch(() => []);
  const jaExiste = existentes.some(i => (i?.name || i?.instance?.instanceName) === instancia);

  if (jaExiste) {
    logger.info(`[evolution] Instância "${instancia}" já existe`);
    return { criada: false, instancia };
  }

  logger.info(`[evolution] Criando instância "${instancia}"`);
  const resultado = await evoFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName: instancia,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }),
  });

  return { criada: true, instancia, resultado };
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

// Uma pista por instância: o número principal e o alternativo são contas
// diferentes para a Meta, e um não espera o outro.
const pistas = new Map();

function pistaDe(instancia) {
  if (!pistas.has(instancia)) {
    pistas.set(instancia, criarPista({
      intervaloSeg: () => config.envio.pistaIntervaloSeg,
      maxPorMinuto: () => config.envio.pistaMaxPorMinuto,
    }));
  }
  return pistas.get(instancia);
}

// O PORTÃO DAS ABERTURAS: um segundo espaçamento, só para o que a máquina
// inicia — follow-up, avisos da avaliação, acompanhamento, fila.
//
// Existe desde 16/11/2026. Cada um desses caminhos tinha a sua pausa (75 s
// no follow-up, 20 a 40 s nos outros), dentro do próprio laço, e eles rodam
// em paralelo: somados, a pista os deixava sair a até 6 por minuto. É a
// lição de sempre — o espaçamento por chamador não vê a soma. O portão fica
// na frente da pista e espaça as aberturas entre si, de qualquer origem; a
// resposta a quem escreveu e o consultor não passam por ele e não esperam.
const portoes = new Map();

function portaoDe(instancia) {
  if (!portoes.has(instancia)) {
    portoes.set(instancia, criarPista({
      intervaloSeg: () => config.envio.aberturaIntervaloSeg,
      maxPorMinuto: () => 0,
    }));
  }
  return portoes.get(instancia);
}

// Quanto a chamada à Evolution pode levar além do "digitando". Sem prazo,
// uma Evolution travada seguraria a pista — e com ela todo envio do número.
const FOLGA_DO_ENVIO_MS = 60_000;

/**
 * Todo envio de mensagem sai por aqui: entra na pista da instância e só
 * chama a Evolution quando chega a vez (ver `lib/pista-envio.js`).
 *
 * O log do envio é escrito na SAÍDA, e não na entrada da pista: é a hora em
 * que a mensagem vai ao WhatsApp, e é por ela que se mede ritmo.
 *
 * @param {object} p
 * @param {string} p.instancia
 * @param {string} p.caminho - Rota da Evolution, sem a instância.
 * @param {object} p.corpo
 * @param {string} p.descricao - Para o log.
 * @param {'alta'|'normal'} [p.prioridade]
 */
function enviarPelaPista({ instancia, caminho, corpo, descricao, prioridade = 'normal', abertura = false }) {
  if (abertura && config.envio.aberturaIntervaloSeg > 0) {
    return portaoDe(instancia).passar(({ esperouMs, naFila }) => {
      const nota = esperouMs >= 3000 ? ` — abertura: esperou ${Math.round(esperouMs / 1000)}s no portão, ${naFila} atrás` : '';
      return enviarPelaPista({ instancia, caminho, corpo, descricao: descricao + nota, prioridade });
    });
  }

  return pistaDe(instancia).passar(({ esperouMs, naFila }) => {
    const espera = esperouMs >= 3000
      ? ` — esperou ${Math.round(esperouMs / 1000)}s na pista, ${naFila} atrás`
      : '';
    logger.info(`[evolution] ${descricao}${instancia === instance ? '' : ` [${instancia}]`}${espera}`);

    return evoFetch(`${caminho}/${instancia}`, {
      method: 'POST',
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout((corpo.delay || 0) + FOLGA_DO_ENVIO_MS),
    });
  }, { prioridade });
}

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
 * Aceita dois formatos de celular depois do DDI:
 *   - 11 dígitos com o `9` na terceira posição (o do cadastro);
 *   - 10 dígitos começando de 6 a 9 depois do DDD — o que o próprio
 *     WhatsApp entrega para muitos celulares de fora de SP, sem o 9 na
 *     frente (`556392248078`). Até 03/11/2026 este era recusado, e a lead
 *     que escreveu por ele não recebia lembrete nem follow-up, embora a Leia
 *     conversasse com ela normalmente. Fixo (2 a 5) continua de fora.
 * O número volta como chegou: é o endereço que o WhatsApp reconhece.
 */
export function telefoneValido(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  const semDdi = digitos.startsWith('55') && digitos.length > 11 ? digitos.slice(2) : digitos;
  if (semDdi.length === 11 && semDdi[2] === '9') return `55${semDdi}`;
  if (semDdi.length === 10 && /[6-9]/.test(semDdi[2])) return `55${semDdi}`;
  return null;
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
export function tempoDeDigitacao(texto) {
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
 * @param {string} [opts.instancia] - Por qual número sai. Padrão: o principal.
 * @param {'alta'|'normal'} [opts.prioridade] - `alta` passa na frente de
 *   quem espera na pista. É o consultor escrevendo pelo painel.
 * @param {boolean} [opts.abertura] - A máquina está iniciando a conversa:
 *   passa antes pelo portão das aberturas (`ENVIO_ABERTURA_INTERVALO_SEG`).
 * @returns {Promise<object>} Resposta da Evolution API
 */
export async function sendText(phone, text, { delayMs, instancia = instance, prioridade, abertura = false } = {}) {
  const number = normalizePhone(phone);
  const delay = delayMs ?? tempoDeDigitacao(text);

  return enviarPelaPista({
    instancia,
    caminho: '/message/sendText',
    corpo: { number, text, delay },
    descricao: `sendText → ${number} (${text.length} chars, ${delay}ms digitando)`,
    prioridade,
    abertura,
  });
}

/**
 * O número existe no WhatsApp?
 *
 * `telefoneValido` confere FORMATO de celular.
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
export async function sendMedia(phone, mediaUrl, caption = '', mediatype = 'image', { abertura = false } = {}) {
  const number = normalizePhone(phone);
  const delay = tempoDeDigitacao(caption);

  return enviarPelaPista({
    instancia: instance,
    caminho: '/message/sendMedia',
    corpo: { number, mediatype, media: mediaUrl, caption, delay },
    descricao: `sendMedia → ${number} (${mediatype}, ${delay}ms digitando)`,
    abertura,
  });
}

/**
 * Envia mídia que veio de outra mensagem (base64 da `baixarMidia`), para a
 * ponte do acompanhamento: a foto ou o vídeo do professor ao aluno, e o
 * contrário. `media` da Evolution v2 aceita URL ou base64.
 * @param {string} phone
 * @param {{ base64: string, mimetype: string, fileName?: string, caption?: string, mediatype: 'image'|'video'|'document' }} m
 */
export async function sendMediaBase64(phone, { base64, mimetype, fileName, caption = '', mediatype }, { abertura = false } = {}) {
  const number = normalizePhone(phone);
  return enviarPelaPista({
    instancia: instance,
    caminho: '/message/sendMedia',
    corpo: { number, mediatype, mimetype, media: base64, fileName, caption, delay: 1200 },
    descricao: `sendMedia (base64) → ${number} (${mediatype})`,
    abertura,
  });
}

/**
 * Envia áudio como mensagem de voz (o "microfone" do WhatsApp), e não como
 * arquivo — é assim que a voz do professor chega ao aluno pela ponte.
 * @param {string} phone
 * @param {string} audio  base64 ou URL
 */
export async function sendAudio(phone, audio) {
  const number = normalizePhone(phone);
  return enviarPelaPista({
    instancia: instance,
    caminho: '/message/sendWhatsAppAudio',
    corpo: { number, audio, delay: 1200 },
    descricao: `sendWhatsAppAudio → ${number}`,
  });
}

/**
 * Reage a uma mensagem recebida (✅, ⚠️). A ponte confirma assim ao
 * professor que a mensagem dele chegou ao aluno, sem mandar mais uma.
 * @param {{ remoteJid: string, id: string, fromMe?: boolean }} key
 * @param {string} reaction  um emoji; '' tira a reação
 */
export async function sendReaction({ remoteJid, id, fromMe = false }, reaction) {
  return evoFetch(`/message/sendReaction/${instance}`, {
    method: 'POST',
    body: JSON.stringify({ key: { remoteJid, fromMe, id }, reaction }),
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
  return enviarPelaPista({
    instancia: instance,
    caminho: '/message/sendButtons',
    // WhatsApp limita a 3
    corpo: { number, title, description, buttons: buttons.slice(0, 3) },
    descricao: `sendButtons → ${number} (${buttons.length} buttons)`,
  });
}

/**
 * Envia mensagem com lista de opções.
 */
export async function sendList(phone, title, description, buttonText, sections) {
  const number = normalizePhone(phone);
  return enviarPelaPista({
    instancia: instance,
    caminho: '/message/sendList',
    corpo: { number, title, description, buttonText, sections },
    descricao: `sendList → ${number}`,
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
  sendMediaBase64,
  sendAudio,
  sendReaction,
  sendButtons,
  sendList,
  normalizePhone,
  telefoneValido,
  numeroExiste,
};
