/**
 * src/services/ai-usage.js
 * Contabilidade de consumo da API da Anthropic.
 *
 * Uma linha em `wa_ai_usage` por CHAMADA à API — não por turno de conversa.
 * Um turno com três tools são quatro chamadas, e cada uma paga o prefixo
 * inteiro de novo; medir só a última esconde exatamente o que custa caro.
 *
 * ## Nunca derruba o atendimento
 *
 * Gravar telemetria é observação, não caminho crítico. Todo o registro é
 * disparado sem `await` e com o erro engolido: se o Supabase engasgar, o
 * cliente ainda recebe a resposta. Mesmo princípio do `moverFunil` no
 * webhook.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

/**
 * Preço por milhão de tokens, em dólar.
 *
 * Fonte: tabela pública da Anthropic, conferida em 24/08/2026. Os
 * multiplicadores de cache são os documentados pela API:
 *   leitura              0,1x  da entrada
 *   escrita (TTL 5 min)  1,25x da entrada
 *   escrita (TTL 1h)     2,0x  da entrada
 *
 * A escrita com TTL de 1h custa 2x, contra 1x de não usar cache nenhum.
 * Ou seja: um prefixo que é escrito e nunca lido sai MAIS CARO do que não
 * ter cache. É esse o número que a `taxa_cache` da view vigia.
 *
 * `escritaMultiplicador` acompanha o TTL usado em `ai-agent.js`. Se um dia
 * o TTL voltar para 5 minutos, este número tem que voltar para 1.25 junto,
 * senão o custo gravado passa a ser ficção.
 */
const PRECOS = {
  'claude-opus-5':   { entrada: 5.00, saida: 25.00 },
  'claude-opus-4-8': { entrada: 5.00, saida: 25.00 },
  'claude-sonnet-5': { entrada: 3.00, saida: 15.00 },
  'claude-haiku-4-5': { entrada: 1.00, saida: 5.00 },
};

const LEITURA_MULTIPLICADOR = 0.1;
const ESCRITA_MULTIPLICADOR = 2.0; // TTL de 1h

/**
 * Custo em dólar de uma chamada, a partir do bloco `usage` da resposta.
 *
 * @param {string} modelo
 * @param {object} usage
 * @returns {number}
 */
export function calcularCusto(modelo, usage = {}) {
  const preco = PRECOS[modelo];
  if (!preco) return 0;

  const entrada = (usage.input_tokens ?? 0) * preco.entrada;
  const escrita = (usage.cache_creation_input_tokens ?? 0) * preco.entrada * ESCRITA_MULTIPLICADOR;
  const leitura = (usage.cache_read_input_tokens ?? 0) * preco.entrada * LEITURA_MULTIPLICADOR;
  const saida = (usage.output_tokens ?? 0) * preco.saida;

  return (entrada + escrita + leitura + saida) / 1_000_000;
}

/**
 * Registra uma chamada. Dispara e esquece — não devolve promise para
 * aguardar de propósito.
 *
 * @param {object} params
 * @param {object} params.usage        - `response.usage` cru.
 * @param {string} params.modelo
 * @param {number} [params.conversationId]
 * @param {string} [params.origem]     - webhook | teste | crm | followup
 * @param {number} [params.iteracao]   - volta do loop de tools (0 = primeira)
 * @param {string[]} [params.modulos]  - módulos da base nesta chamada
 * @param {string} [params.stopReason]
 * @param {number} [params.duracaoMs]
 */
export function registrar({
  usage,
  modelo,
  conversationId = null,
  origem = 'webhook',
  iteracao = 0,
  modulos = [],
  stopReason = null,
  duracaoMs = null,
}) {
  if (!usage) return;

  const custo = calcularCusto(modelo, usage);
  const entrada = (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);

  // Continua no log, agora em `info` e em toda iteração — o `debug` não
  // aparecia em produção, e o nível é justamente o que se quer ver quando o
  // custo sobe sem explicação.
  logger.info(
    `[ai-usage] ${origem} it=${iteracao} [${modulos.join('+') || '-'}] ` +
    `prompt=${entrada} (novo=${usage.input_tokens ?? 0} ` +
    `escrita=${usage.cache_creation_input_tokens ?? 0} ` +
    `leitura=${usage.cache_read_input_tokens ?? 0}) ` +
    `saida=${usage.output_tokens ?? 0} custo=$${custo.toFixed(4)}`
  );

  supabase
    .from('wa_ai_usage')
    .insert({
      conversation_id: conversationId,
      origem,
      modelo,
      iteracao,
      modulos,
      input_tokens: usage.input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      custo_usd: Number(custo.toFixed(6)),
      stop_reason: stopReason,
      duracao_ms: duracaoMs,
    })
    .then(({ error }) => {
      if (error) logger.warn('[ai-usage] Não gravou a telemetria:', error.message);
    });
}

export const aiUsage = { registrar, calcularCusto };
