/**
 * src/services/ai-agent.js
 * Agente de IA usando Claude (Anthropic) com tool use.
 *
 * Fluxo:
 * 1. Carrega prompt do banco (wa_ai_prompts)
 * 2. Carrega knowledge files da pasta prompts/knowledge/
 * 3. Monta histórico da conversa
 * 4. Envia ao Claude com as tools
 * 5. Processa tool calls em loop
 * 6. Retorna resposta final
 */
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { toolDeclarations, executeTool } from './ai-tools.js';

const MODEL = 'claude-opus-5';

// Curto de propósito: mensagem de WhatsApp é curta, e no Opus 5 o
// max_tokens limita thinking + resposta somados.
const MAX_TOKENS = 2048;

// Teto de idas e voltas de tool num mesmo turno.
const MAX_TOOL_ITERATIONS = 5;

const FALLBACK_TEXT = 'Desculpe, não consegui processar sua solicitação no momento.';

// O SDK já reenvia sozinho em 429 e 5xx — era exatamente o que faltava
// quando um 503 transitório do provedor derrubava o atendimento.
const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

/**
 * Registra o aproveitamento do cache de prompt.
 * Se cache_read ficar sempre em zero, algo está invalidando o prefixo
 * (o mais provável: conteúdo variável entrando antes do breakpoint).
 */
function logCacheUsage(usage) {
  if (!usage) return;
  logger.debug(
    `[ai-agent] tokens: entrada=${usage.input_tokens} ` +
    `cache_escrita=${usage.cache_creation_input_tokens ?? 0} ` +
    `cache_leitura=${usage.cache_read_input_tokens ?? 0} ` +
    `saida=${usage.output_tokens}`
  );
}

// Caminho para os knowledge files
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const KNOWLEDGE_DIR = join(__dirname, '..', 'prompts', 'knowledge');

// ──────────────────────────────────────────────
// Cache
// ──────────────────────────────────────────────

let cachedPrompt = null;
let cachedKnowledge = null;
let promptLoadedAt = 0;
let knowledgeLoadedAt = 0;
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Carrega o prompt ativo do banco de dados.
 * @param {string} slug - Slug do prompt (default: 'vendas')
 */
async function loadPrompt(slug = 'vendas') {
  const now = Date.now();
  if (cachedPrompt && (now - promptLoadedAt) < CACHE_MS) {
    return cachedPrompt;
  }

  const { data, error } = await supabase
    .from('wa_ai_prompts')
    .select('system_prompt')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (error || !data) {
    logger.warn(`[ai-agent] Prompt "${slug}" não encontrado, usando fallback`);
    return 'Você é um assistente da AP Academia. Responda de forma breve e educada.';
  }

  cachedPrompt = data.system_prompt;
  promptLoadedAt = now;
  return cachedPrompt;
}

/**
 * Bloco usado quando a base de conhecimento não pôde ser carregada.
 * Sem ele o modelo ficaria sem nenhuma instrução sobre preços/horários e
 * tenderia a inventar valores.
 */
const NO_KNOWLEDGE_GUARD = '\n\n## BASE DE CONHECIMENTO\n' +
  'A base de conhecimento não pôde ser carregada nesta conversa. Você NÃO tem ' +
  'nenhum dado de planos, valores ou grade horária. É proibido inventar ou ' +
  'estimar qualquer informação desse tipo — use transferir_para_humano.';

/**
 * Carrega todos os knowledge files (.md) da pasta prompts/knowledge/.
 * Estes arquivos contêm informações estáticas editáveis sem deploy:
 * planos, valores, grade horária, FAQ, regras de negócio.
 *
 * @returns {Promise<string>} Conteúdo concatenado de todos os arquivos
 */
async function loadKnowledgeFiles() {
  const now = Date.now();
  if (cachedKnowledge && (now - knowledgeLoadedAt) < CACHE_MS) {
    return cachedKnowledge;
  }

  try {
    const files = await readdir(KNOWLEDGE_DIR);
    const mdFiles = files
      .filter(f => extname(f) === '.md' && f !== 'README.md')
      .sort();

    if (mdFiles.length === 0) {
      logger.warn('[ai-agent] Nenhum knowledge file encontrado');
      cachedKnowledge = NO_KNOWLEDGE_GUARD;
      knowledgeLoadedAt = now;
      return cachedKnowledge;
    }

    const sections = [];
    for (const file of mdFiles) {
      const content = await readFile(join(KNOWLEDGE_DIR, file), 'utf-8');
      sections.push(`\n--- Arquivo: ${file} ---\n${content.trim()}`);
    }

    cachedKnowledge = '\n\n## BASE DE CONHECIMENTO (arquivos locais)\n' +
      'As informações abaixo são a ÚNICA fonte de verdade sobre planos, valores, ' +
      'modalidades, grade horária e regras da academia. Não existe consulta a ' +
      'sistema externo para esses dados.\n' +
      'REGRA CRÍTICA: se a informação que o cliente pediu não estiver abaixo, ou ' +
      'estiver marcada como "PENDENTE", "_preencha_", "Exemplo", "XXX" ou ' +
      '"descreva aqui", esse dado AINDA NÃO ESTÁ DISPONÍVEL. Nesse caso é ' +
      'proibido inventar, estimar ou aproximar: ' +
      'diga que vai confirmar a informação exata com um consultor e use a ' +
      'ferramenta transferir_para_humano.\n' +
      sections.join('\n');

    knowledgeLoadedAt = now;
    logger.info(`[ai-agent] ${mdFiles.length} knowledge file(s) carregado(s): ${mdFiles.join(', ')}`);
    return cachedKnowledge;
  } catch (err) {
    logger.error('[ai-agent] Erro ao carregar knowledge files:', err.message);
    cachedKnowledge = NO_KNOWLEDGE_GUARD;
    knowledgeLoadedAt = now;
    return cachedKnowledge;
  }
}

/**
 * Busca as últimas N mensagens de uma conversa para contexto.
 *
 * @param {number} conversationId
 * @param {object} [opts]
 * @param {number} [opts.limit] - Quantas mensagens trazer
 * @param {number} [opts.excludeMessageId] - Mensagem a ignorar. A mensagem que
 *   está sendo respondida agora já foi gravada pelo webhook antes de chegar
 *   aqui; sem excluí-la ela entraria no histórico E seria enviada de novo
 *   como mensagem atual, chegando duplicada ao modelo.
 */
async function loadConversationHistory(conversationId, { limit = 20, excludeMessageId = null } = {}) {
  if (!conversationId) return [];

  // Ordena DESC para pegar as mensagens mais RECENTES (com ASC pegaríamos as
  // primeiras da conversa, e a memória do bot congelaria no início dela).
  let query = supabase
    .from('wa_messages')
    .select('id, direction, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (excludeMessageId) query = query.neq('id', excludeMessageId);

  const { data, error } = await query;
  if (error || !data) return [];

  const history = data
    .reverse() // volta à ordem cronológica
    .filter(msg => msg.content)
    .map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant',
      content: msg.content,
    }));

  // A janela das últimas N pode começar no meio da conversa, numa fala do bot.
  // A API exige que a conversa comece com role 'user'.
  while (history.length > 0 && history[0].role !== 'user') history.shift();

  return history;
}

/**
 * Processa uma mensagem do usuário com o agente IA.
 *
 * O prompt é composto por 3 camadas:
 * 1. Prompt do banco (editável no admin, define persona e regras)
 * 2. Knowledge files (editáveis na pasta, dados da academia)
 * 3. Contexto do contato (dinâmico, dados da conversa atual)
 *
 * @param {object} params
 * @param {string} params.message - Texto da mensagem recebida
 * @param {number} [params.conversationId] - ID da conversa (para contexto)
 * @param {number} [params.excludeMessageId] - ID da mensagem atual já gravada,
 *   para não duplicá-la no histórico
 * @param {object} [params.contactInfo] - Dados do contato (nome, tags, etc.)
 * @param {string} [params.promptSlug] - Slug do prompt a usar
 *
 * @returns {Promise<{text: string, action?: string, toolResults?: object[]}>}
 */
export async function processMessage({
  message,
  conversationId,
  excludeMessageId = null,
  contactInfo = {},
  promptSlug = 'vendas',
}) {
  // Camada 1: Prompt base do banco
  const systemPrompt = await loadPrompt(promptSlug);

  // Camada 2: Knowledge files (planos, horários, FAQ)
  const knowledge = await loadKnowledgeFiles();

  // Camada 3: Contexto do contato atual
  const contactContext = contactInfo.name
    ? `\n\n## CONTATO ATUAL\n- Nome: ${contactInfo.name}\n- Telefone: ${contactInfo.phone || 'N/A'}\n- É prospect: ${contactInfo.is_prospect ? 'Sim' : 'Não (já é aluno)'}\n- Tags: ${(contactInfo.tags || []).join(', ') || 'nenhuma'}`
    : '';

  // O system vai em DOIS blocos por causa do prompt caching.
  //
  // As camadas 1 e 2 são byte-a-byte idênticas em toda mensagem de todo
  // cliente — elas levam o breakpoint de cache e passam a custar ~10% na
  // leitura. O contexto do contato muda a cada conversa, então fica DEPOIS
  // do breakpoint: se viesse antes, invalidaria o cache a cada contato
  // diferente e nunca haveria acerto.
  const system = [
    {
      type: 'text',
      text: systemPrompt + knowledge,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (contactContext) {
    system.push({ type: 'text', text: contactContext });
  }

  // Carrega histórico e acrescenta a mensagem atual
  const history = await loadConversationHistory(conversationId, { excludeMessageId });
  const messages = [...history, { role: 'user', content: message }];
  const toolResults = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Thinking fica LIGADO (padrão do Opus 5). Desligar reduziria latência,
      // mas nesse modo o modelo ocasionalmente escreve a chamada de tool como
      // texto comum: o turno termina sem erro e a tool nunca executa — aqui
      // isso seria um handoff pedido pelo cliente que ninguém recebe.
      // Latência e custo são controlados pelo effort, não desligando thinking.
      output_config: { effort: 'low' },
      // Se os classificadores recusarem, a API repete o pedido em outro
      // modelo em vez de devolver a recusa.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      tools: toolDeclarations,
      messages,
    });

    // Precisa vir antes de ler content: numa recusa o array vem vazio.
    if (response.stop_reason === 'refusal') {
      logger.warn(`[ai-agent] Recusa (${response.stop_details?.category || 'sem categoria'})`);
      return {
        text: 'Essa eu prefiro que um consultor te responda 😊 Já estou chamando alguém.',
        action: 'handoff',
        handoffReason: 'Recusa do modelo',
        toolResults,
      };
    }

    const toolUses = response.content.filter(block => block.type === 'tool_use');

    // Sem tool call = resposta final
    if (toolUses.length === 0) {
      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();

      logCacheUsage(response.usage);
      return { text: text || FALLBACK_TEXT, toolResults };
    }

    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const toolUse of toolUses) {
      logger.info(`[ai-agent] Tool call: ${toolUse.name}`);

      const result = await executeTool(toolUse.name, toolUse.input || {});
      toolResults.push({ tool: toolUse.name, args: toolUse.input, result });

      // Handoff encerra o turno: o bot para e um humano assume.
      if (result.action === 'handoff') {
        return {
          text: result.mensagem,
          action: 'handoff',
          handoffReason: result.motivo,
          toolResults,
        };
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: results });
  }

  logger.warn(`[ai-agent] Limite de ${MAX_TOOL_ITERATIONS} iterações atingido`);
  return { text: FALLBACK_TEXT, toolResults };
}

/**
 * Invalida todos os caches (prompt + knowledge files).
 * Útil quando o admin edita o prompt ou os knowledge files são atualizados.
 */
export function invalidatePromptCache() {
  cachedPrompt = null;
  cachedKnowledge = null;
  promptLoadedAt = 0;
  knowledgeLoadedAt = 0;
  logger.info('[ai-agent] Cache de prompt e knowledge invalidado');
}

export const aiAgent = {
  processMessage,
  invalidatePromptCache,
};
