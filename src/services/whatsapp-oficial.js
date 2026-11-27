/**
 * src/services/whatsapp-oficial.js
 * Cliente da API oficial do WhatsApp (Cloud API, direto com a Meta).
 *
 * ENSAIO (27/11/2026). É o primeiro passo da Fase 4 do PLANO_API_OFICIAL.md:
 * enviar um modelo, responder dentro das 24 h e ler o que a Meta avisa, com
 * o número de teste que ela fornece. Nada do atendimento passa por aqui — a
 * Leia, o painel, a fila e o número alternativo seguem na Evolution. Sem as
 * variáveis `WA_OFICIAL_*` nada disto funciona, e nada do resto muda.
 *
 * Não há pista, portão nem "digitando": aqui o ritmo não é o risco, e o
 * ensaio envia uma mensagem por comando.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { corpoDoModelo, corpoDoTexto } from './whatsapp-oficial-regras.js';

const cfg = () => config.whatsappOficial;

/** Dá para ENVIAR? Precisa do token e do id do número. */
export const configurado = () => Boolean(cfg().token && cfg().numeroId);

async function graph(caminho, { method = 'GET', corpo } = {}) {
  if (!cfg().token) throw new Error('API oficial sem token (WA_OFICIAL_TOKEN)');

  const res = await fetch(`${cfg().graphUrl}/${cfg().versao}${caminho}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg().token}`,
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const dados = await res.json().catch(() => ({}));
  if (!res.ok) {
    // O erro da Meta vem estruturado, e o código é o que diz o que houve
    // (131047 = fora da janela de 24 h; 131030 = destinatário fora da lista
    // do número de teste; 190 = token vencido).
    const e = dados?.error || {};
    const detalhe = e.error_data?.details || e.message || `HTTP ${res.status}`;
    const erro = new Error(`Meta ${e.code ?? res.status}: ${detalhe}`);
    erro.codigo = e.code ?? null;
    erro.http = res.status;
    throw erro;
  }
  return dados;
}

async function enviar(corpo, descricao) {
  if (!configurado()) throw new Error('API oficial não configurada (WA_OFICIAL_TOKEN e WA_OFICIAL_PHONE_ID)');
  const r = await graph(`/${cfg().numeroId}/messages`, { method: 'POST', corpo });
  const id = r?.messages?.[0]?.id || null;
  logger.info(`[oficial] ${descricao} → ${corpo.to} (id ${id})`);
  // `waId` é como a Meta conhece o destinatário — em celular brasileiro pode
  // voltar sem o 9, e é por ele que os avisos de status chegam.
  return { id, waId: r?.contacts?.[0]?.wa_id || null, bruto: r };
}

/** Abre conversa com um modelo aprovado. */
export function enviarModelo(telefone, nome, idioma, campos = []) {
  return enviar(corpoDoModelo(telefone, nome, idioma, campos), `modelo "${nome}" (${idioma})`);
}

/** Texto livre: a Meta só aceita se a pessoa escreveu nas últimas 24 h. */
export function enviarTexto(telefone, texto) {
  return enviar(corpoDoTexto(telefone, texto), `texto (${String(texto).length} chars)`);
}

/** Como a Meta vê o número: nome de exibição, qualidade e limite. */
export function infoDoNumero() {
  if (!cfg().numeroId) throw new Error('falta WA_OFICIAL_PHONE_ID');
  const campos = 'display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier';
  return graph(`/${cfg().numeroId}?fields=${campos}`);
}

/** Os modelos da conta, com o estado e a categoria que a Meta deu a cada um. */
export async function listarModelos() {
  if (!cfg().contaId) throw new Error('falta WA_OFICIAL_WABA_ID');
  const r = await graph(`/${cfg().contaId}/message_templates?fields=name,status,category,language&limit=100`);
  return r?.data || [];
}

/**
 * Registra o número na Cloud API. É o passo que falta depois de adicionar e
 * verificar (SMS ou ligação) um número de verdade na conta: sem ele o número
 * fica "pendente" e não envia. O PIN de 6 dígitos passa a ser o da
 * verificação em duas etapas do número — é exigido para desfazer.
 */
export function registrarNumero(pin) {
  if (!cfg().numeroId) throw new Error('falta WA_OFICIAL_PHONE_ID');
  if (!/^\d{6}$/.test(String(pin || ''))) throw new Error('o PIN tem 6 dígitos');
  return graph(`/${cfg().numeroId}/register`, {
    method: 'POST',
    corpo: { messaging_product: 'whatsapp', pin: String(pin) },
  });
}

/**
 * Liga os avisos da CONTA ao app. A conta de teste já vem ligada; uma conta
 * nova, criada para o número de verdade, não — e aí o webhook fica mudo.
 */
export function assinarAvisos() {
  if (!cfg().contaId) throw new Error('falta WA_OFICIAL_WABA_ID');
  return graph(`/${cfg().contaId}/subscribed_apps`, { method: 'POST' });
}

export const whatsappOficial = {
  configurado, enviarModelo, enviarTexto, infoDoNumero, listarModelos, registrarNumero, assinarAvisos,
};
