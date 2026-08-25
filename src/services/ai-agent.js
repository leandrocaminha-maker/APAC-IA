/**
 * src/services/ai-agent.js
 * Agente de IA usando Claude (Anthropic) com tool use.
 *
 * Fluxo:
 * 1. Carrega prompt do banco (wa_ai_prompts)
 * 2. Carrega histórico da conversa
 * 3. Decide quais módulos da base de conhecimento a conversa precisa
 * 4. Monta o system em 2 blocos (estável + volátil) e envia ao Claude
 * 5. Processa tool calls em loop
 * 6. Retorna resposta final
 *
 * ## Onde o dinheiro é gasto
 *
 * Cada volta do loop de tools é uma chamada nova, e cada chamada reenvia o
 * prefixo inteiro. Medido com `count_tokens` em 24/08/2026, o prefixo era de
 * 61.694 tokens (prompt 21.741 + base 38.038 + tools 1.915), o que colocava
 * ~95% do custo de entrada num bloco que é idêntico em toda conversa de todo
 * cliente. Três coisas atacam isso, e as três estão neste arquivo:
 *
 * 1. **TTL de 1h no cache** (era 5 min). Ver `CACHE_TTL`.
 * 2. **Base modular** (`knowledge.js`): o núcleo vai sempre, o resto por sinal.
 * 3. **Caminho enxuto de follow-up** (`gerarFollowup`): sem base e sem tools.
 *
 * O que sobra é medido chamada a chamada em `wa_ai_usage` (`ai-usage.js`).
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { toolDeclarations, executeTool } from './ai-tools.js';
import { detectarModulos, montarKnowledge, invalidarKnowledge } from './knowledge.js';
import { aiUsage } from './ai-usage.js';

const MODEL = 'claude-opus-5';

// Curto de propósito: mensagem de WhatsApp é curta, e no Opus 5 o
// max_tokens limita thinking + resposta somados.
const MAX_TOKENS = 2048;

// Teto de idas e voltas de tool num mesmo turno.
const MAX_TOOL_ITERATIONS = 5;

/**
 * TTL do cache de prompt.
 *
 * Era o padrão de 5 minutos, e com tráfego de WhatsApp isso estava
 * ENCARECENDO o sistema em vez de baratear: escrever o cache custa 1,25x o
 * preço de entrada, contra 1x de não ter cache nenhum. Só compensa se a
 * entrada for lida depois — e uma conversa em que o cliente responde 20
 * minutos depois nunca lia.
 *
 * Com 1h a escrita sobe para 2x, mas passa a cobrir o intervalo real entre
 * mensagens. E como o prefixo é o MESMO para todos os clientes, qualquer
 * conversa mantém o cache quente para todas as outras: o custo da escrita é
 * dividido pelo movimento do dia inteiro, não por uma conversa.
 *
 * Se este valor mudar, `ESCRITA_MULTIPLICADOR` em `ai-usage.js` muda junto.
 */
const CACHE_TTL = '1h';

const FALLBACK_TEXT = 'Desculpe, não consegui processar sua solicitação no momento.';

// A academia é uma só e fica em São Paulo. O servidor roda em UTC, então sem
// isto a data e a hora que o agente enxerga ficariam 3 horas à frente — e à
// meia-noite ele erraria o dia da semana inteiro, que é o dado que a grade usa.
const TIMEZONE = 'America/Sao_Paulo';

// O SDK já reenvia sozinho em 429 e 5xx — era exatamente o que faltava
// quando um 503 transitório do provedor derrubava o atendimento.
const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FOLLOWUP_PROMPT_PATH = join(__dirname, '..', 'prompts', 'followup.md');
const CAMPANHA_PROMPT_PATH = join(__dirname, '..', 'prompts', 'campanha.md');

// ──────────────────────────────────────────────
// Cache local (disco/banco → memória)
// ──────────────────────────────────────────────

let cachedPrompt = null;
let cachedFollowupPrompt = null;
let cachedCampanhaPrompt = null;
let promptLoadedAt = 0;
let followupLoadedAt = 0;
let campanhaLoadedAt = 0;
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
 * Carrega o prompt enxuto de follow-up do disco.
 *
 * O corte em "Você é a Leia" descarta o cabeçalho de edição do .md — mesma
 * convenção do `scripts/publicar-prompt.js`. O cabeçalho é instrução para
 * humano, e mandá-lo ao modelo seria pagar por ele em toda retomada.
 */
async function loadFollowupPrompt() {
  const now = Date.now();
  if (cachedFollowupPrompt && (now - followupLoadedAt) < CACHE_MS) {
    return cachedFollowupPrompt;
  }

  try {
    const bruto = await readFile(FOLLOWUP_PROMPT_PATH, 'utf-8');
    const inicio = bruto.indexOf('Você é a Leia');
    cachedFollowupPrompt = (inicio < 0 ? bruto : bruto.slice(inicio)).trim();
    followupLoadedAt = now;
    return cachedFollowupPrompt;
  } catch (err) {
    logger.error('[ai-agent] Erro ao ler followup.md:', err.message);
    // Sem o arquivo, o mínimo que impede o pior: retomar sem afirmar fato.
    return 'Você é a Leia, consultora virtual da AP Academia. Você está retomando ' +
      'uma conversa que já existe — não cumprimente como primeiro contato. ' +
      'Escreva de duas a quatro linhas, uma pergunta só, sem pressão. ' +
      'Você NÃO tem a base de conhecimento carregada: não afirme preço, valor, ' +
      'horário, prazo ou regra de contrato. Devolva apenas o texto da mensagem.';
  }
}

/**
 * Carrega o prompt enxuto de campanha do disco. Mesma convenção de corte
 * do `loadFollowupPrompt`.
 */
async function loadCampanhaPrompt() {
  const now = Date.now();
  if (cachedCampanhaPrompt && (now - campanhaLoadedAt) < CACHE_MS) {
    return cachedCampanhaPrompt;
  }

  try {
    const bruto = await readFile(CAMPANHA_PROMPT_PATH, 'utf-8');
    const inicio = bruto.indexOf('Você é a Leia');
    cachedCampanhaPrompt = (inicio < 0 ? bruto : bruto.slice(inicio)).trim();
    campanhaLoadedAt = now;
    return cachedCampanhaPrompt;
  } catch (err) {
    // Diferente do follow-up, aqui NÃO há texto de emergência: sem o
    // arquivo não se escreve primeira abordagem a contato frio. Melhor a
    // campanha não sair do que sair sem as regras que a seguram.
    logger.error('[ai-agent] Erro ao ler campanha.md:', err.message);
    throw new Error('prompt de campanha indisponível — nada foi gerado');
  }
}

// ──────────────────────────────────────────────
// Módulos da base fixados na conversa
// ──────────────────────────────────────────────

/**
 * Lê os módulos que já foram travados nesta conversa.
 *
 * Isso existe para o caso em que o modelo pediu um módulo com
 * `carregar_base`: a chamada de tool não vira mensagem em `wa_messages`, e
 * portanto some do histórico no turno seguinte. Sem gravar em algum lugar, o
 * módulo teria de ser pedido de novo a cada mensagem — uma chamada de API
 * extra por turno, que é exatamente o que se está tentando evitar.
 */
async function modulosFixados(conversationId) {
  if (!conversationId) return [];

  const { data, error } = await supabase
    .from('wa_conversations')
    .select('context')
    .eq('id', conversationId)
    .single();

  if (error || !data) return [];
  const lista = data.context?.knowledge;
  return Array.isArray(lista) ? lista : [];
}

/** Trava um módulo na conversa, preservando o resto do `context`. */
async function fixarModulo(conversationId, modulo) {
  if (!conversationId) return;

  const { data } = await supabase
    .from('wa_conversations')
    .select('context')
    .eq('id', conversationId)
    .single();

  const context = data?.context ?? {};
  const atuais = Array.isArray(context.knowledge) ? context.knowledge : [];
  if (atuais.includes(modulo)) return;

  const { error } = await supabase
    .from('wa_conversations')
    .update({ context: { ...context, knowledge: [...atuais, modulo] } })
    .eq('id', conversationId);

  if (error) logger.warn(`[ai-agent] Não fixou o módulo "${modulo}":`, error.message);
}

// ──────────────────────────────────────────────
// Histórico
// ──────────────────────────────────────────────

/**
 * Busca as últimas N mensagens de uma conversa para contexto.
 *
 * @param {number} conversationId
 * @param {object} [opts]
 * @param {number} [opts.limit] - Quantas mensagens trazer
 * @param {number[]} [opts.excludeMessageIds] - Mensagens a ignorar. As
 *   mensagens que estão sendo respondidas agora já foram gravadas pelo
 *   webhook antes de chegar aqui; sem excluí-las elas entrariam no histórico
 *   E seriam enviadas de novo como mensagem atual, chegando duplicadas ao
 *   modelo. São VÁRIAS desde que o webhook passou a agrupar mensagens
 *   picotadas antes de responder.
 */
async function loadConversationHistory(conversationId, { limit = 20, excludeMessageIds = [] } = {}) {
  if (!conversationId) return [];

  // Ordena DESC para pegar as mensagens mais RECENTES (com ASC pegaríamos as
  // primeiras da conversa, e a memória do bot congelaria no início dela).
  let query = supabase
    .from('wa_messages')
    .select('id, direction, content, sent_by, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  const ignorar = excludeMessageIds.filter(Boolean);
  if (ignorar.length === 1) query = query.neq('id', ignorar[0]);
  else if (ignorar.length > 1) query = query.not('id', 'in', `(${ignorar.join(',')})`);

  const { data, error } = await query;
  if (error || !data) return [];

  const history = data
    .reverse() // volta à ordem cronológica
    .filter(msg => msg.content)
    .map(msg => ({
      role: msg.direction === 'inbound' ? 'user' : 'assistant',
      // Nem toda mensagem que saiu daqui foi escrita pelo agente: desde
      // 20/08/2026 o webhook também grava o que o consultor humano digita
      // direto no WhatsApp. Elas entram como `assistant` porque vieram do nosso
      // lado da conversa, mas precisam vir marcadas — sem isso o modelo lê a
      // fala do consultor como se fosse dele, e passa a se achar dono de
      // combinações que não fez.
      content: msg.sent_by?.startsWith('human')
        ? `[mensagem escrita por um consultor humano, não por você] ${msg.content}`
        : msg.content,
    }));

  // A janela das últimas N pode começar no meio da conversa, numa fala do bot.
  // A API exige que a conversa comece com role 'user'.
  while (history.length > 0 && history[0].role !== 'user') history.shift();

  return history;
}

/**
 * Monta a camada 3 do system: a data/hora de agora e o contato da conversa.
 *
 * **Data e hora.** Sem isto o modelo não tem relógio nenhum, e a grade horária
 * inteira está no contexto: ele não responde "tem natação hoje à noite?" nem
 * "amanhã de manhã", não sabe se a academia está aberta agora, e chega a
 * sugerir uma aula experimental "hoje" sem saber que hoje é domingo. Não
 * calculamos aqui se está aberto — o horário de funcionamento vive na base de
 * conhecimento, e duplicá-lo em código criaria mais uma fonte para divergir.
 *
 * **Por que o bloco é montado sempre.** A versão anterior era
 * `contactInfo.name ? bloco : ''`: sem nome, o bloco inteiro sumia e levava
 * junto o `is_prospect`, que é o que distingue lead de aluno. Na página
 * `/teste` o contato nasce com `name: null`, então boa parte das conversas de
 * teste rodou sem contexto de contato algum.
 */
function buildDynamicContext(contactInfo = {}) {
  const agora = new Date();
  const formatar = (opcoes) =>
    new Intl.DateTimeFormat('pt-BR', { timeZone: TIMEZONE, ...opcoes }).format(agora);

  const linhas = [
    '## AGORA',
    `- Data: ${formatar({ day: '2-digit', month: '2-digit', year: 'numeric' })}`,
    `- Dia da semana: ${formatar({ weekday: 'long' })}`,
    `- Hora: ${formatar({ hour: '2-digit', minute: '2-digit' })} (horário de Brasília)`,
    '',
    'Use isto para "hoje", "amanhã", "hoje à noite" e para saber se a academia',
    'está aberta neste momento — o horário de funcionamento está na base de',
    'conhecimento. Nunca sugira uma aula em dia ou horário em que a academia',
    'não abre.',
    '',
    '## CONTATO ATUAL',
    contactInfo.name
      ? `- Nome: ${contactInfo.name}`
      : '- Nome: ainda não informado — pergunte quando fizer sentido',
    `- Telefone: ${contactInfo.phone || 'N/A'}`,
    `- Tags: ${(contactInfo.tags || []).join(', ') || 'nenhuma'}`,
  ];

  // `is_prospect` NÃO é dado verificado. Nasce TRUE por padrão em `contacts.js`
  // e em `teste.js`, e nada no sistema o coloca em false — nem o
  // `evo_member_id`, que existe no schema com índice e que nenhum código
  // preenche (0 de 11 contatos em 20/08/2026). Ou seja: hoje não há sinal
  // algum separando lead de aluno matriculado.
  //
  // Por isso só o `false` vira afirmação. Reportar "Sim" como fato faria o
  // agente abrir toda conversa em modo venda — inclusive com aluno matriculado,
  // que é a maioria do volume esperado no número principal da academia.
  if (contactInfo.is_prospect === false) {
    linhas.push('- É prospect: Não — já é aluno matriculado (confirmado)');
  } else {
    linhas.push(
      '- É prospect: NÃO CONFIRMADO. O sistema marca todo contato novo como ' +
      'prospect por padrão, então isto não quer dizer que a pessoa seja um ' +
      'lead — pode ser um aluno matriculado. Descubra na conversa.',
    );
  }

  return `\n\n${linhas.join('\n')}`;
}

/**
 * Monta o `system` da requisição.
 *
 * Vai em DOIS blocos por causa do prompt caching.
 *
 * O primeiro bloco (prompt do banco + base de conhecimento) é byte-a-byte
 * idêntico para todo cliente que estiver com os MESMOS módulos carregados —
 * ele leva o breakpoint e passa a custar ~10% na leitura. O segundo muda a
 * cada conversa E a cada minuto, então fica DEPOIS do breakpoint: se a hora
 * viesse antes, invalidaria o cache a cada minuto e nunca haveria acerto.
 *
 * O conjunto de módulos é, na prática, o nome da entrada de cache. Por isso
 * `montarKnowledge` os concatena sempre na mesma ordem: "nucleo+adulto" tem
 * que gerar os mesmos bytes na conversa de agora e na de daqui a uma hora.
 */
async function buildSystem(systemPrompt, modulos, dynamicContext) {
  const knowledge = await montarKnowledge(modulos);
  return [
    {
      type: 'text',
      text: systemPrompt + knowledge,
      cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
    },
    { type: 'text', text: dynamicContext },
  ];
}

/**
 * Processa uma mensagem do usuário com o agente IA.
 *
 * O prompt é composto por 3 camadas:
 * 1. Prompt do banco (editável no admin, define persona e regras)
 * 2. Base de conhecimento, nos módulos que esta conversa precisa
 * 3. Contexto do contato (dinâmico, dados da conversa atual)
 *
 * @param {object} params
 * @param {string} params.message - Texto da mensagem recebida
 * @param {number} [params.conversationId] - ID da conversa (para contexto)
 * @param {number|number[]} [params.excludeMessageId] - ID(s) da(s) mensagem(ns)
 *   atual(is) já gravada(s), para não duplicá-la(s) no histórico
 * @param {object} [params.contactInfo] - Dados do contato (nome, tags, etc.)
 * @param {string} [params.promptSlug] - Slug do prompt a usar
 * @param {string} [params.origem] - Rótulo para a telemetria
 *
 * @returns {Promise<{text: string, action?: string, toolResults?: object[]}>}
 */
export async function processMessage({
  message,
  conversationId,
  excludeMessageId = null,
  contactInfo = {},
  promptSlug = 'vendas',
  origem = 'webhook',
}) {
  // Camada 1: Prompt base do banco
  const systemPrompt = await loadPrompt(promptSlug);

  // Histórico vem antes do system porque é ele que diz quais módulos da base
  // esta conversa precisa: quem falou do filho de 4 anos na segunda mensagem
  // continua precisando do módulo infantil na décima.
  const excludeMessageIds = Array.isArray(excludeMessageId)
    ? excludeMessageId
    : (excludeMessageId ? [excludeMessageId] : []);
  const history = await loadConversationHistory(conversationId, { excludeMessageIds });

  const fixados = await modulosFixados(conversationId);
  let modulos = detectarModulos({
    textos: [...history.map(m => m.content), message],
    isProspect: contactInfo.is_prospect,
    fixados,
  });

  // Camada 3: o que muda a cada mensagem — agora e contato.
  const dynamicContext = buildDynamicContext(contactInfo);

  // Camadas 1 + 2, com o breakpoint de cache.
  let system = await buildSystem(systemPrompt, modulos, dynamicContext);

  const messages = [...history, { role: 'user', content: message }];
  const toolResults = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const inicio = Date.now();
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

    // Toda chamada é contabilizada, não só a última do turno. Um turno com
    // três tools são quatro chamadas pagando o prefixo inteiro cada uma, e
    // medir só a última é o que fazia o custo parecer 4x menor do que é.
    aiUsage.registrar({
      usage: response.usage,
      modelo: MODEL,
      conversationId,
      origem,
      iteracao: iteration,
      modulos,
      stopReason: response.stop_reason,
      duracaoMs: Date.now() - inicio,
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

      return { text: text || FALLBACK_TEXT, toolResults };
    }

    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    let recarregarBase = false;

    for (const toolUse of toolUses) {
      logger.info(`[ai-agent] Tool call: ${toolUse.name}`);

      // O contexto da conversa vai junto: as tools de cadastro e agendamento
      // precisam saber de quem é a conversa para ligar o prospect criado no
      // EVO ao lead do funil. Sem ele, o painel mostraria "não cadastrado"
      // para alguém que acabou de ser cadastrado.
      const result = await executeTool(toolUse.name, toolUse.input || {}, {
        contactId: contactInfo.id ?? null,
        conversationId,
        phone: contactInfo.phone ?? null,
        tags: contactInfo.tags ?? [],
        modulosCarregados: modulos,
      });
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

      // O modelo percebeu que precisa de um módulo que não está carregado.
      // O texto NÃO volta como tool_result de propósito: ali ele ficaria
      // fora do cache, a preço cheio, em toda chamada seguinte da conversa.
      // Em vez disso o módulo entra no `system` e passa a ser cacheado como
      // qualquer outra variante.
      if (result.action === 'carregar_modulo') {
        if (!modulos.includes(result.modulo)) {
          modulos = [...modulos, result.modulo];
          recarregarBase = true;
          await fixarModulo(conversationId, result.modulo);
          logger.info(`[ai-agent] Módulo "${result.modulo}" carregado a pedido do modelo`);
        }
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: results });

    if (recarregarBase) {
      modulos = [...new Set(modulos)];
      system = await buildSystem(systemPrompt, modulos, dynamicContext);
    }
  }

  logger.warn(`[ai-agent] Limite de ${MAX_TOOL_ITERATIONS} iterações atingido`);
  return { text: FALLBACK_TEXT, toolResults };
}

/**
 * Gera uma mensagem de retomada (follow-up).
 *
 * Caminho deliberadamente enxuto: prompt curto de `prompts/followup.md`,
 * histórico da conversa, e **nada mais**. Sem base de conhecimento e sem
 * tools.
 *
 * Antes disso o worker chamava `processMessage`, o que carregava os ~61.700
 * tokens do atendimento completo para escrever duas linhas — o trabalho mais
 * simples do sistema pelo caminho mais caro. Aqui o prefixo fica na casa de
 * 1.000 tokens, com o mesmo TTL de 1h.
 *
 * A contrapartida está escrita no próprio prompt: sem a base, o agente é
 * proibido de afirmar preço, horário ou regra. Os roteiros de follow-up
 * fazem perguntas, não afirmações, então isso não tira nada do que ele
 * precisa — mas se um roteiro novo precisar de um dado da academia, ele tem
 * que voltar para `processMessage`.
 *
 * @param {object} params
 * @param {string} params.instrucao - Roteiro do follow-up (o que escrever)
 * @param {number} [params.conversationId]
 * @param {object} [params.contactInfo]
 * @returns {Promise<{text: string}>}
 */
export async function gerarFollowup({ instrucao, conversationId, contactInfo = {} }) {
  const systemPrompt = await loadFollowupPrompt();
  const history = await loadConversationHistory(conversationId);

  const system = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
    },
    { type: 'text', text: buildDynamicContext(contactInfo) },
  ];

  // Sem histórico não há conversa a retomar — e a API exige que a lista
  // comece com 'user' de qualquer jeito.
  const messages = [...history, { role: 'user', content: instrucao }];

  const inicio = Date.now();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages,
  });

  aiUsage.registrar({
    usage: response.usage,
    modelo: MODEL,
    conversationId,
    origem: 'followup',
    iteracao: 0,
    modulos: [],
    stopReason: response.stop_reason,
    duracaoMs: Date.now() - inicio,
  });

  if (response.stop_reason === 'refusal') {
    logger.warn(`[ai-agent] Recusa no follow-up (${response.stop_details?.category || 'sem categoria'})`);
    return { text: '' };
  }

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  return { text };
}

/**
 * Gera a primeira mensagem de campanha para uma pessoa.
 *
 * Caminho ainda mais enxuto que o follow-up: aqui não há sequer histórico,
 * porque o contato é frio — a pessoa nunca escreveu para a academia. O
 * prefixo é só o `campanha.md` (~700 tokens), cacheado com TTL de 1h e
 * compartilhado por toda a campanha.
 *
 * **A oferta é o único fato permitido.** Ela vem escrita por uma pessoa em
 * `crm_campanhas.oferta` e é passada aqui como dado, não como instrução —
 * o modelo embrulha, não inventa. Sem base de conhecimento carregada, ele
 * não teria como conferir preço ou horário nenhum.
 *
 * @param {object} params
 * @param {object} params.alvo - Linha de `crm_campanha_alvos` (nome, contexto)
 * @param {string} params.oferta - O que a campanha está oferecendo
 * @param {string} [params.roteiro] - Ângulo/condução, opcional
 * @param {number} [params.conversationId] - Só para a telemetria
 * @returns {Promise<{text: string}>}
 */
export async function gerarMensagemCampanha({ alvo, oferta, roteiro = null, conversationId = null }) {
  const systemPrompt = await loadCampanhaPrompt();

  const contexto = alvo?.contexto ?? {};
  const linhas = [
    '## QUEM VAI RECEBER',
    `- Nome: ${alvo?.nome || 'não sabemos o nome — não invente um, escreva sem'}`,
    `- Segmento: ${contexto.segmento || 'não informado'}`,
  ];

  if (contexto.meses_inativo != null) {
    linhas.push(`- Está sem contrato há ${contexto.meses_inativo} meses (já foi aluno)`);
  }
  if (contexto.dias_desde_cadastro != null) {
    linhas.push(`- Pediu informação há ${contexto.dias_desde_cadastro} dias e não fechou`);
  }
  if (contexto.interesse) {
    linhas.push(`- Na época procurava: ${contexto.interesse}`);
  }

  linhas.push(
    '',
    '## OFERTA — o ÚNICO fato que você pode afirmar',
    'Escrita por um consultor humano. Reescreva com naturalidade, mas não',
    'acrescente nenhum número, prazo, condição ou benefício que não esteja aqui:',
    '',
    oferta,
  );

  if (roteiro) {
    linhas.push('', '## COMO CONDUZIR', roteiro);
  }

  const system = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
    },
  ];

  const inicio = Date.now();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: linhas.join('\n') }],
  });

  aiUsage.registrar({
    usage: response.usage,
    modelo: MODEL,
    conversationId,
    origem: 'campanha',
    iteracao: 0,
    modulos: [],
    stopReason: response.stop_reason,
    duracaoMs: Date.now() - inicio,
  });

  if (response.stop_reason === 'refusal') {
    logger.warn(`[ai-agent] Recusa na campanha (${response.stop_details?.category || 'sem categoria'})`);
    return { text: '' };
  }

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  return { text };
}

/**
 * Invalida todos os caches (prompt do banco + base de conhecimento).
 * Útil quando o admin edita o prompt ou os knowledge files são atualizados.
 */
export function invalidatePromptCache() {
  cachedPrompt = null;
  cachedFollowupPrompt = null;
  cachedCampanhaPrompt = null;
  promptLoadedAt = 0;
  followupLoadedAt = 0;
  campanhaLoadedAt = 0;
  invalidarKnowledge();
  logger.info('[ai-agent] Cache de prompt e knowledge invalidado');
}

export const aiAgent = {
  processMessage,
  gerarFollowup,
  gerarMensagemCampanha,
  invalidatePromptCache,
};
