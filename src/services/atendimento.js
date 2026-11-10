/**
 * src/services/atendimento.js
 * As duas pendências que o painel precisa gritar.
 *
 * O handoff sempre teve um buraco no meio: a Leia desiste, grava o
 * briefing, cala o bot — e ninguém é avisado. O lead entra em
 * `aguardando_consultor` e fica lá até alguém abrir a aba certa. Estas
 * duas contas existem para o painel poder mudar de cor quando isso
 * acontece.
 *
 * **As duas pendências PARTICIONAM a fila, não se sobrepõem:**
 *
 *   aguardandoConsultor → handoff aberto, ninguém assumiu
 *   aguardandoResposta  → alguém assumiu, e o cliente falou por último
 *
 * A mesma conversa cair nas duas faria o consultor contar duas vezes o
 * mesmo problema. Por isso a segunda conta ignora quem ainda está na
 * primeira: são estágios diferentes do mesmo atendimento, e cada cartão
 * responde uma pergunta diferente ("quem ninguém pegou?" e "quem estou
 * deixando no vácuo?").
 *
 * Por que a segunda não sai de `wa_conversations.status`: `human` só diz
 * que o bot está calado, não quem falou por último. Quem responde isso é
 * a direção da última mensagem — daí a leitura de `wa_messages`.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { PREFIXO, textoDoRepasse, situacaoDosRepasses } from './repasse-regras.js';

/** Conversas do simulador não são atendimento — ficam fora das contas. */
const CANAL_SIMULADOR = 'web-test';

/** Teto de conversas examinadas por chamada. A fila real é muito menor. */
const TETO_CONVERSAS = 200;

/** Teto de mensagens lidas para descobrir a última de cada conversa. */
const TETO_MENSAGENS = 1000;

/** Folga na janela de leitura, para absorver diferença de relógio. */
const MARGEM_MS = 5 * 60 * 1000;

/**
 * Handoff ou repasse mais velho que isso sai das filas sem ser resolvido:
 * duas semanas sem ninguém é caso para o funil, não para o alarme.
 */
const JANELA_DIAS = 14;

function trecho(texto, max = 90) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Fila de handoff: leads em `aguardando_consultor`.
 *
 * Ordenado por `stage_since` crescente — quem espera há mais tempo vem
 * primeiro, que é a ordem em que a fila deveria ser atendida.
 *
 * Devolve também `contatos`, os `contact_id` da fila inteira (não só os
 * exibidos): é com essa lista que `aguardandoResposta` se mantém
 * disjunta.
 */
export async function filaDeConsultor({ limite = 12 } = {}) {
  const { data, count, error } = await supabase
    .from('crm_leads')
    .select(
      'id, full_name, phone, stage_since, contact_id, trilha, tipo_contato, ' +
      'contato:wa_contacts ( id, name, phone )',
      { count: 'exact' },
    )
    .eq('stage', 'aguardando_consultor')
    .order('stage_since', { ascending: true })
    .limit(TETO_CONVERSAS);

  if (error) throw new Error(`falha ao ler a fila de consultor: ${error.message}`);

  const leads = data || [];
  const porEtapa = leads.map(l => ({
    leadId: l.id,
    contatoId: l.contact_id,
    nome: l.full_name || l.contato?.name || null,
    telefone: l.phone || l.contato?.phone || null,
    desde: l.stage_since,
    tipo: l.tipo_contato || 'lead',
    trilha: l.trilha || 'lead',
  }));

  // O handoff de quem já passou desta etapa não muda a etapa. Lido à parte;
  // se a leitura falhar, a fila segue como era.
  let semConsultor = [];
  try {
    semConsultor = await handoffsSemConsultor({ ignorarContatos: porEtapa.map(i => i.contatoId) });
  } catch (err) {
    logger.error('[atendimento] Handoffs fora da etapa "aguardando consultor":', err.message);
  }

  const todos = [...porEtapa, ...semConsultor].sort((a, b) => new Date(a.desde) - new Date(b.desde));

  return {
    total: (count ?? leads.length) + semConsultor.length,
    maisAntigoEm: todos[0]?.desde || null,
    contatos: todos.map(i => i.contatoId).filter(Boolean),
    // `tipo` vai junto porque a fila é uma só e as duas trilhas caem nela:
    // o handoff do fornecedor espera na mesma lista que o lead quente. Quem
    // vai atender decide melhor a ordem sabendo qual é qual.
    itens: todos.slice(0, limite).map(({ contatoId, ...i }) => i),
  };
}

/**
 * Handoffs abertos que a etapa não mostra.
 *
 * `aoAbrirHandoff` só avança a etapa, nunca recua. Quem já está em "Com
 * consultor" ou com experimental marcada continua lá quando a Leia
 * transfere — e some da fila, que é pela etapa. De 10/09 a 10/11/2026
 * foram 35 handoffs assim só de quem tinha aula marcada (cancelar,
 * remarcar, "URGENTE, a aula é hoje"); 10 nunca tiveram resposta.
 *
 * Critério: handoff não resolvido, conversa ainda calada (`human`) e
 * nenhuma fala de consultor depois dele. O repasse de experimental tem o
 * seu próprio cartão e fica de fora.
 */
async function handoffsSemConsultor({ ignorarContatos = [] } = {}) {
  const desde = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('wa_human_handoffs')
    .select('id, conversation_id, contact_id, reason, created_at, conversa:wa_conversations ( status, channel ), contato:wa_contacts ( id, name, phone )')
    .eq('resolved', false)
    .gte('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(TETO_CONVERSAS);

  if (error) throw new Error(error.message);

  const ignorar = new Set(ignorarContatos);
  // Um por conversa: o mais antigo, que é há quanto tempo ela espera.
  const porConversa = new Map();
  for (const h of data || []) {
    if (h.conversa?.status !== 'human' || h.conversa?.channel === CANAL_SIMULADOR) continue;
    if (ignorar.has(h.contact_id) || /^\[(experimental|simulador|teste)/.test(h.reason || '')) continue;
    if (!porConversa.has(h.conversation_id)) porConversa.set(h.conversation_id, h);
  }
  const abertos = [...porConversa.values()];
  if (!abertos.length) return [];

  const [{ data: falas, error: e1 }, { data: leads, error: e2 }] = await Promise.all([
    supabase
      .from('wa_messages')
      .select('conversation_id, created_at')
      .in('conversation_id', abertos.map(h => h.conversation_id))
      .like('sent_by', 'human:%')
      .gte('created_at', new Date(new Date(abertos[0].created_at).getTime() - MARGEM_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(TETO_MENSAGENS),
    supabase
      .from('crm_leads')
      .select('id, contact_id, stage, full_name, phone, tipo_contato, trilha, created_at')
      .in('contact_id', abertos.map(h => h.contact_id))
      .order('created_at', { ascending: false }),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);

  const ultimaFala = new Map();
  for (const f of falas || []) if (!ultimaFala.has(f.conversation_id)) ultimaFala.set(f.conversation_id, new Date(f.created_at).getTime());
  const leadPorContato = new Map();
  for (const l of leads || []) if (!leadPorContato.has(l.contact_id)) leadPorContato.set(l.contact_id, l);

  return abertos
    .filter(h => !((ultimaFala.get(h.conversation_id) ?? -Infinity) > new Date(h.created_at).getTime()))
    .filter(h => !['ganho', 'perdido', 'finalizado'].includes(leadPorContato.get(h.contact_id)?.stage))
    .map(h => {
      const l = leadPorContato.get(h.contact_id);
      return {
        leadId: l?.id ?? null,
        conversaId: h.conversation_id,
        contatoId: h.contact_id,
        nome: l?.full_name || h.contato?.name || null,
        telefone: l?.phone || h.contato?.phone || null,
        desde: h.created_at,
        tipo: l?.tipo_contato || 'lead',
        trilha: l?.trilha || 'lead',
      };
    });
}

/**
 * Contatos com o consultor que estão esperando resposta.
 *
 * Critério: conversa com o bot calado (`status = 'human'`) cuja **última
 * mensagem é do cliente**. Se a última é nossa, a bola está com ele, não
 * conosco.
 *
 * A janela de leitura das mensagens começa na conversa parada há mais
 * tempo. `last_message` é gravado quando a mensagem do cliente chega
 * (getOrCreateConversation) e quando o consultor responde pelo painel,
 * então toda conversa candidata tem pelo menos uma mensagem dentro da
 * janela — é o que permite achar a última de cada uma em UMA consulta,
 * em vez de uma por conversa.
 */
export async function aguardandoResposta({ ignorarContatos = [], limite = 12 } = {}) {
  const { data: conversas, error } = await supabase
    .from('wa_conversations')
    .select('id, contact_id, assigned_to, last_message, started_at, contato:wa_contacts ( id, name, phone )')
    .eq('status', 'human')
    .neq('channel', CANAL_SIMULADOR)
    .order('last_message', { ascending: false })
    .limit(TETO_CONVERSAS);

  if (error) throw new Error(`falha ao ler conversas com consultor: ${error.message}`);

  const naFila = new Set(ignorarContatos);
  const candidatas = (conversas || []).filter(c => !naFila.has(c.contact_id));
  const vazio = { total: 0, maisAntigoEm: null, itens: [] };
  if (!candidatas.length) return vazio;

  const inicio = candidatas.reduce((menor, c) => {
    const t = new Date(c.last_message || c.started_at).getTime();
    return Number.isFinite(t) && t < menor ? t : menor;
  }, Date.now());

  const { data: mensagens } = await supabase
    .from('wa_messages')
    .select('conversation_id, direction, content, created_at')
    .in('conversation_id', candidatas.map(c => c.id))
    .gte('created_at', new Date(inicio - MARGEM_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(TETO_MENSAGENS);

  // Ordenado do mais novo para o mais antigo: a primeira ocorrência de
  // cada conversa é a última mensagem dela.
  const ultima = new Map();
  for (const m of mensagens || []) {
    if (!ultima.has(m.conversation_id)) ultima.set(m.conversation_id, m);
  }

  const itens = [];
  for (const c of candidatas) {
    const m = ultima.get(c.id);
    if (!m || m.direction !== 'inbound') continue;
    itens.push({
      conversaId: c.id,
      nome: c.contato?.name || null,
      telefone: c.contato?.phone || null,
      consultor: c.assigned_to || null,
      desde: m.created_at,
      previa: trecho(m.content),
    });
  }

  itens.sort((a, b) => new Date(a.desde) - new Date(b.desde));

  return {
    total: itens.length,
    maisAntigoEm: itens[0]?.desde || null,
    conversas: itens.map(i => i.conversaId),
    itens: itens.slice(0, limite),
  };
}

// ──────────────────────────────────────────────
// O repasse da experimental que a Leia marcou
// ──────────────────────────────────────────────

/**
 * Registra o repasse de uma aula que a Leia acabou de marcar. A conversa
 * NÃO muda de status: a Leia segue na cobertura (ver `repasse-regras.js`).
 *
 * Nunca lança: a aula já está marcada no EVO, e falhar aqui não pode
 * virar "não consegui agendar" na conversa.
 *
 * @returns {Promise<number|null>} o id do repasse
 */
export async function repassarExperimental({ conversationId, contactId, atividade, dataHora, resumo, dryRun = false }) {
  if (!conversationId || !contactId) {
    logger.warn('[atendimento] Repasse de experimental sem conversa — não registrado');
    return null;
  }

  try {
    // Aula remarcada: vale o repasse novo, com a data nova.
    await supabase
      .from('wa_human_handoffs')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('resolved', false)
      .like('reason', `${PREFIXO}%`);

    const { data, error } = await supabase
      .from('wa_human_handoffs')
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        reason: textoDoRepasse({ atividade, dataHora, resumo, dryRun }),
      })
      .select('id')
      .single();

    if (error) throw new Error(error.message);
    logger.info(`[atendimento] Repasse de experimental: conv=${conversationId}, aula ${dataHora}`);
    return data?.id ?? null;
  } catch (err) {
    logger.error('[atendimento] Aula marcada, mas o repasse ao consultor falhou:', err.message);
    return null;
  }
}

/**
 * Aulas que a Leia marcou e nenhum consultor confirmou ainda.
 *
 * Quem já saiu da fila (consultor falou, lead fechou, aula remarcada) é
 * marcado como resolvido aqui mesmo, para o briefing aparecer resolvido no
 * fio da conversa.
 */
export async function experimentaisParaConfirmar({ ignorarConversas = [], limite = 12 } = {}) {
  const vazio = { total: 0, maisAntigoEm: null, itens: [] };
  const desde = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('wa_human_handoffs')
    .select('id, conversation_id, contact_id, created_at, conversa:wa_conversations ( channel ), contato:wa_contacts ( id, name, phone )')
    .eq('resolved', false)
    .like('reason', `${PREFIXO}%`)
    .gte('created_at', desde)
    .order('created_at', { ascending: true })
    .limit(TETO_CONVERSAS);

  if (error) throw new Error(`falha ao ler os repasses de experimental: ${error.message}`);

  const repasses = (data || []).filter(r => r.conversa?.channel !== CANAL_SIMULADOR);
  if (!repasses.length) return vazio;

  const conversas = [...new Set(repasses.map(r => r.conversation_id))];
  const contatos = [...new Set(repasses.map(r => r.contact_id))];

  const [{ data: falas, error: e1 }, { data: leads, error: e2 }] = await Promise.all([
    supabase
      .from('wa_messages')
      .select('conversation_id, created_at')
      .in('conversation_id', conversas)
      .like('sent_by', 'human:%')
      .gte('created_at', new Date(new Date(repasses[0].created_at).getTime() - MARGEM_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(TETO_MENSAGENS),
    supabase
      .from('crm_leads')
      .select('id, contact_id, stage, full_name, phone, experimental_at, experimental_activity, created_at')
      .in('contact_id', contatos)
      .order('created_at', { ascending: false }),
  ]);
  // Sem saber se o consultor falou, a fila mostraria como pendente quem já
  // foi atendido. Melhor o cartão não mudar nesta volta.
  if (e1 || e2) throw new Error(`falha ao conferir os repasses: ${(e1 || e2).message}`);

  // O lead mais novo de cada contato (vêm do mais novo para o mais velho).
  const leadPorContato = new Map();
  for (const l of leads || []) if (!leadPorContato.has(l.contact_id)) leadPorContato.set(l.contact_id, l);

  const { pendentes, resolver } = situacaoDosRepasses({ repasses, falasHumanas: falas || [], leadPorContato });

  if (resolver.length) {
    const { error: e3 } = await supabase
      .from('wa_human_handoffs')
      .update({ resolved: true, resolved_at: new Date().toISOString() })
      .in('id', resolver);
    if (e3) logger.warn('[atendimento] Repasses atendidos não marcados como resolvidos:', e3.message);
  }

  const ignorar = new Set(ignorarConversas);
  const itens = pendentes
    .filter(r => !ignorar.has(r.conversation_id))
    .map(r => ({
      repasseId: r.id,
      conversaId: r.conversation_id,
      leadId: r.lead?.id ?? null,
      nome: r.lead?.full_name || r.contato?.name || null,
      telefone: r.lead?.phone || r.contato?.phone || null,
      desde: r.created_at,
      aula: r.lead?.experimental_at || null,
      atividade: r.lead?.experimental_activity || null,
    }));

  return {
    total: itens.length,
    maisAntigoEm: itens[0]?.desde || null,
    itens: itens.slice(0, limite),
  };
}

/** O consultor confirmou por outro canal (ligação, balcão) e tira da fila. */
export async function resolverRepasse(id) {
  const { data, error } = await supabase
    .from('wa_human_handoffs')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .like('reason', `${PREFIXO}%`)
    .select('id');
  if (error) throw new Error(`falha ao resolver o repasse: ${error.message}`);
  return (data || []).length > 0;
}

/**
 * As três contas, já disjuntas, do jeito que o painel consome.
 *
 * A aula para confirmar fica de fora quando a conversa já está em
 * "aguardando resposta": ali a Leia está calada e o cliente esperando, que
 * é o mais urgente dos dois.
 */
export async function pendencias({ limite = 12 } = {}) {
  const fila = await filaDeConsultor({ limite });
  const resposta = await aguardandoResposta({ ignorarContatos: fila.contatos, limite });

  // Fila de experimental fora do ar não derruba os outros dois cartões.
  let experimental = null;
  try {
    experimental = await experimentaisParaConfirmar({ ignorarConversas: resposta.conversas ?? [], limite });
  } catch (err) {
    logger.error('[atendimento] Fila de experimental para confirmar:', err.message);
  }

  const { contatos, ...semContatos } = fila;
  const { conversas, ...respostaSemConversas } = resposta;
  return {
    aguardandoConsultor: semContatos,
    aguardandoResposta: respostaSemConversas,
    experimentalParaConfirmar: experimental,
  };
}

export const atendimento = {
  filaDeConsultor, aguardandoResposta, pendencias,
  repassarExperimental, experimentaisParaConfirmar, resolverRepasse,
};
