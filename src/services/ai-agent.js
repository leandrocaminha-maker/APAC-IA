/**
 * src/services/ai-agent.js
 * Agente de IA usando Google Gemini com function calling.
 *
 * Fluxo:
 * 1. Carrega prompt do banco (wa_ai_prompts)
 * 2. Carrega knowledge files da pasta prompts/knowledge/
 * 3. Monta histórico da conversa
 * 4. Envia ao Gemini com tools
 * 5. Processa tool calls em loop
 * 6. Retorna resposta final
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { toolDeclarations, executeTool } from './ai-tools.js';

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

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
      cachedKnowledge = '';
      knowledgeLoadedAt = now;
      return '';
    }

    const sections = [];
    for (const file of mdFiles) {
      const content = await readFile(join(KNOWLEDGE_DIR, file), 'utf-8');
      sections.push(`\n--- Arquivo: ${file} ---\n${content.trim()}`);
    }

    cachedKnowledge = '\n\n## BASE DE CONHECIMENTO (arquivos locais)\n' +
      'Use as informações abaixo como referência principal para responder sobre ' +
      'planos, valores, horários e informações da academia. ' +
      'Se os dados abaixo estiverem marcados como "Exemplo" ou "XXX", ' +
      'use as ferramentas (buscar_planos, buscar_horarios) para consultar dados em tempo real.\n' +
      sections.join('\n');

    knowledgeLoadedAt = now;
    logger.info(`[ai-agent] ${mdFiles.length} knowledge file(s) carregado(s): ${mdFiles.join(', ')}`);
    return cachedKnowledge;
  } catch (err) {
    logger.error('[ai-agent] Erro ao carregar knowledge files:', err.message);
    cachedKnowledge = '';
    knowledgeLoadedAt = now;
    return '';
  }
}

/**
 * Busca as últimas N mensagens de uma conversa para contexto.
 */
async function loadConversationHistory(conversationId, limit = 20) {
  if (!conversationId) return [];

  const { data, error } = await supabase
    .from('wa_messages')
    .select('direction, content, content_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error || !data) return [];

  return data.map(msg => ({
    role: msg.direction === 'inbound' ? 'user' : 'model',
    parts: [{ text: msg.content }],
  }));
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
 * @param {object} [params.contactInfo] - Dados do contato (nome, tags, etc.)
 * @param {string} [params.promptSlug] - Slug do prompt a usar
 *
 * @returns {Promise<{text: string, action?: string, toolResults?: object[]}>}
 */
export async function processMessage({
  message,
  conversationId,
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

  const fullSystemPrompt = systemPrompt + knowledge + contactContext;

  // Carrega histórico
  const history = await loadConversationHistory(conversationId);

  // Configura o modelo
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: fullSystemPrompt,
    tools: [{
      functionDeclarations: toolDeclarations,
    }],
  });

  // Cria chat com histórico
  const chat = model.startChat({ history });

  // Envia a mensagem do usuário
  let response = await chat.sendMessage(message);
  let result = response.response;
  const toolResults = [];

  // Loop de function calling (máx 5 iterações para segurança)
  let iterations = 0;
  while (iterations < 5) {
    const candidate = result.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    // Verifica se há function calls
    const functionCalls = parts.filter(p => p.functionCall);
    if (functionCalls.length === 0) break;

    // Executa cada function call
    const functionResponses = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      logger.info(`[ai-agent] Function call: ${name}`);

      const toolResult = await executeTool(name, args || {});
      toolResults.push({ tool: name, args, result: toolResult });

      functionResponses.push({
        functionResponse: {
          name,
          response: toolResult,
        },
      });

      // Se a tool sinalizou handoff, interrompe
      if (toolResult.action === 'handoff') {
        return {
          text: toolResult.mensagem,
          action: 'handoff',
          handoffReason: toolResult.motivo,
          toolResults,
        };
      }
    }

    // Envia resultados das tools de volta ao Gemini
    response = await chat.sendMessage(functionResponses);
    result = response.response;
    iterations++;
  }

  // Extrai o texto final da resposta
  const text = result.text() || 'Desculpe, não consegui processar sua solicitação no momento.';

  return { text, toolResults };
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
