/**
 * src/services/numero-alternativo.js
 * O segundo número da academia: conexão, envio e o livro do que passou por ele.
 *
 * ## Por que existe
 *
 * Tudo aqui saía por um número só, o principal — e a restrição de 31/08/2026
 * mostrou o custo: disparo ativo arrisca o canal por onde a academia atende.
 * O número alternativo carrega o que é em massa e não é atendimento (a
 * pesquisa de satisfação é o primeiro uso). Se a Meta o derrubar, cai a
 * pesquisa; o atendimento não percebe.
 *
 * ## O que o separa do principal, por construção
 *
 *   - **Outra instância** na Evolution (`EVOLUTION_INSTANCE_ALT`). Sem a
 *     variável nada aqui funciona, e nada do resto muda.
 *   - **Outro livro.** O que sai e o que chega fica em `wa_alt_mensagens`, e
 *     não em `wa_messages`: não entra no teto do número principal, não cria
 *     contato nem conversa no painel, não vira "nossa fala" para o follow-up
 *     e não aparece no histórico que a Leia lê.
 *   - **Outra pista na fila**, com teto e ritmo próprios (`queue-processor`,
 *     `limiteEnvio.cotaAlternativo`).
 *   - **Ninguém atende.** O webhook entrega as mensagens dele a
 *     `pesquisa.js`, que responde com texto fixo. A Leia não fala por aqui.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { getConnectionStatus, normalizePhone, sendText } from './evolution.js';

/** O nome da instância, ou null quando não há número alternativo. */
export const instancia = () => config.evolution.instanciaAlt || null;
export const configurado = () => Boolean(instancia());

/**
 * O evento do webhook é do número alternativo?
 *
 * A Evolution manda o nome da instância em `instance`, no topo do evento, e
 * o webhook dela é global: as duas instâncias batem na mesma rota. Quem não
 * for reconhecido aqui segue o caminho do número principal, como sempre.
 */
export function ehDaInstancia(evento) {
  if (!configurado()) return false;
  const nome = evento?.instance || evento?.instanceName || evento?.data?.instanceName;
  return nome === instancia();
}

// ──────────────────────────────────────────────
// Conexão
// ──────────────────────────────────────────────

let conexao = { em: 0, estado: 'desconhecido' };

/**
 * O estado da sessão, lido da Evolution no máximo uma vez por minuto.
 *
 * Não há faixa vermelha no painel para este número: ele fora do ar não cala
 * a academia. Quem pergunta é quem vai enviar — a pista da fila e o
 * agendamento da campanha —, e os dois param enquanto não for 'open'.
 */
export async function estadoDaConexao({ maxIdadeMs = 60_000 } = {}) {
  if (!configurado()) return 'nao_configurado';
  if (Date.now() - conexao.em < maxIdadeMs) return conexao.estado;

  let estado;
  try {
    const r = await getConnectionStatus(instancia());
    estado = r?.instance?.state || r?.state || 'desconhecido';
  } catch (err) {
    estado = 'desconhecido';
    logger.debug(`[alt] Não deu para ler a sessão: ${err.message}`);
  }

  if (estado !== conexao.estado) {
    const texto = `[alt] Sessão do número alternativo: "${estado}" (era "${conexao.estado}")`;
    if (estado === 'open') logger.info(texto);
    else logger.warn(texto);
  }
  conexao = { em: Date.now(), estado };
  return estado;
}

export async function conectado() {
  return (await estadoDaConexao()) === 'open';
}

/** O estado que a própria Evolution avisou pelo webhook (`connection.update`). */
export function anotarConexao(estado) {
  if (!estado || estado === conexao.estado) return;
  const texto = `[alt] Sessão do número alternativo: "${estado}" (era "${conexao.estado}")`;
  if (estado === 'open') logger.info(texto);
  else logger.warn(texto);
  conexao = { em: Date.now(), estado };
}

// ──────────────────────────────────────────────
// O livro
// ──────────────────────────────────────────────

/** Grava uma mensagem no livro. Falha de gravação não derruba quem chamou. */
export async function registrar({
  phone, direction, tipo, origem = null, content, evolutionMsgId = null, status = 'sent',
}) {
  const { error } = await supabase.from('wa_alt_mensagens').insert({
    instancia: instancia(),
    phone: normalizePhone(phone),
    direction,
    tipo,
    origem,
    content,
    evolution_msg_id: evolutionMsgId,
    status,
  });
  if (error) logger.error('[alt] Falha ao gravar no livro:', error.message);
  return !error;
}

/**
 * Envia pelo número alternativo e grava no livro.
 *
 * @param {string} phone
 * @param {string} texto
 * @param {object} p
 * @param {'abertura'|'link'|'auto'} p.tipo
 * @param {string} p.origem - `alt:campanha:<slug>`, `alt:link:<slug>` ou `alt:auto`
 */
export async function enviar(phone, texto, { tipo, origem }) {
  if (!configurado()) throw new Error('número alternativo não configurado (EVOLUTION_INSTANCE_ALT)');

  const resposta = await sendText(phone, texto, { instancia: instancia() });
  await registrar({
    phone, direction: 'outbound', tipo, origem, content: texto,
    evolutionMsgId: resposta?.key?.id || null,
  });
  return resposta;
}

/**
 * Esta mensagem já está no livro? A Evolution reentrega evento, e a segunda
 * entrega de um "sim" não pode mandar o link de novo.
 */
export async function jaRegistrada(evolutionMsgId) {
  if (!evolutionMsgId) return false;
  const { data } = await supabase
    .from('wa_alt_mensagens')
    .select('id')
    .eq('evolution_msg_id', evolutionMsgId)
    .limit(1);
  return Boolean(data?.length);
}

/** Já mandamos uma resposta fixa a este telefone nas últimas `horas`? */
export async function respondeuHaPouco(phone, horas = 24) {
  const desde = new Date(Date.now() - horas * 3_600_000).toISOString();
  const { data } = await supabase
    .from('wa_alt_mensagens')
    .select('id')
    .eq('phone', normalizePhone(phone))
    .eq('direction', 'outbound')
    .eq('tipo', 'auto')
    .gte('created_at', desde)
    .limit(1);
  return Boolean(data?.length);
}

/** Entregue e lida, vindos do webhook — é a leitura de que a mensagem chegou. */
export async function atualizarStatus(evolutionMsgId, status) {
  await supabase
    .from('wa_alt_mensagens')
    .update({ status })
    .eq('evolution_msg_id', evolutionMsgId);
}

export const numeroAlternativo = {
  instancia, configurado, ehDaInstancia,
  estadoDaConexao, conectado, anotarConexao,
  registrar, enviar, jaRegistrada, respondeuHaPouco, atualizarStatus,
};
