/**
 * src/services/whatsapp-oficial-regras.js
 * A parte da API oficial do WhatsApp (Cloud API, da Meta) que não toca a
 * rede: montar o corpo de um envio, conferir a assinatura de um aviso e ler
 * o que o aviso traz. É o que tem teste.
 *
 * Ensaio de 27/11/2026 (PLANO_API_OFICIAL.md, Fase 4, primeiro passo): nada
 * do atendimento chama isto.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Só os dígitos, com o 55 na frente quando vier DDD + número. */
export function telefoneParaApi(bruto) {
  const digitos = String(bruto || '').replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

/**
 * O corpo de um envio de MODELO — o único jeito de abrir conversa fora da
 * janela de 24 h.
 *
 * @param {string} telefone
 * @param {string} nome - Como está aprovado na Meta (`hello_world` no ensaio).
 * @param {string} idioma - O código do modelo (`en_US`, `pt_BR`).
 * @param {string[]} [campos] - Os valores de {{1}}, {{2}}… do corpo, em ordem.
 */
export function corpoDoModelo(telefone, nome, idioma, campos = []) {
  const template = { name: nome, language: { code: idioma } };
  if (campos.length) {
    template.components = [{
      type: 'body',
      parameters: campos.map(texto => ({ type: 'text', text: String(texto) })),
    }];
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefoneParaApi(telefone),
    type: 'template',
    template,
  };
}

/** O corpo de um texto livre. A Meta só o aceita dentro da janela de 24 h. */
export function corpoDoTexto(telefone, texto) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: telefoneParaApi(telefone),
    type: 'text',
    text: { body: String(texto), preview_url: false },
  };
}

/**
 * A assinatura do aviso confere?
 *
 * A Meta assina o corpo CRU com o segredo do app (HMAC-SHA256) e manda em
 * `X-Hub-Signature-256: sha256=<hex>`. Tem de ser o corpo como chegou: o
 * JSON remontado pode diferir em escape e espaço, e a conta não fecha.
 *
 * @param {Buffer|string} corpoCru
 * @param {string} cabecalho
 * @param {string} segredo
 */
export function assinaturaConfere(corpoCru, cabecalho, segredo) {
  if (!corpoCru || !cabecalho || !segredo) return false;
  const [algoritmo, recebida] = String(cabecalho).split('=');
  if (algoritmo !== 'sha256' || !/^[0-9a-f]{64}$/i.test(recebida || '')) return false;
  const esperada = createHmac('sha256', segredo).update(corpoCru).digest();
  return timingSafeEqual(esperada, Buffer.from(recebida, 'hex'));
}

/** O texto de uma mensagem recebida, ou uma etiqueta do tipo dela. */
function conteudoDe(m) {
  switch (m.type) {
    case 'text': return m.text?.body || '';
    case 'button': return m.button?.text || '';
    case 'interactive':
      return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '[interativo]';
    case 'image': case 'video': case 'document':
      return m[m.type]?.caption ? `[${m.type}] ${m[m.type].caption}` : `[${m.type}]`;
    case 'reaction': return `[reação] ${m.reaction?.emoji || ''}`.trim();
    default: return `[${m.type || 'desconhecido'}]`;
  }
}

const instante = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString() : null);

/**
 * Lê um aviso da Meta e devolve a lista do que ele traz, em ordem.
 *
 * Um aviso pode trazer várias entradas, e cada uma mensagens recebidas e/ou
 * status de mensagens enviadas. O que não for do WhatsApp é ignorado.
 *
 * - `mensagem`: alguém escreveu para o número.
 * - `status`: `sent`, `delivered`, `read` ou `failed` de algo que enviamos.
 *   O preço vem aqui (`cobrada`, `categoria`), e o erro também.
 */
export function lerAviso(payload) {
  const itens = [];
  if (payload?.object !== 'whatsapp_business_account') return itens;

  for (const entrada of payload.entry || []) {
    for (const mudanca of entrada.changes || []) {
      if (mudanca.field !== 'messages') continue;
      const v = mudanca.value || {};
      const numeroId = v.metadata?.phone_number_id || null;
      const nomes = new Map((v.contacts || []).map(c => [c.wa_id, c.profile?.name || null]));

      for (const m of v.messages || []) {
        itens.push({
          tipo: 'mensagem',
          numeroId,
          id: m.id,
          de: m.from,
          nome: nomes.get(m.from) || null,
          formato: m.type,
          conteudo: conteudoDe(m),
          midiaId: m[m.type]?.id || null,
          respondeA: m.context?.id || null,
          em: instante(m.timestamp),
        });
      }

      for (const s of v.statuses || []) {
        const erro = s.errors?.[0];
        itens.push({
          tipo: 'status',
          numeroId,
          id: s.id,
          para: s.recipient_id,
          status: s.status,
          cobrada: s.pricing ? s.pricing.billable !== false : null,
          categoria: s.pricing?.category || null,
          modeloDePreco: s.pricing?.pricing_model || null,
          erro: erro
            ? { codigo: erro.code, texto: erro.error_data?.details || erro.message || erro.title || '' }
            : null,
          em: instante(s.timestamp),
        });
      }
    }
  }
  return itens;
}
