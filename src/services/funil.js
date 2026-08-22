/**
 * src/services/funil.js
 * O funil de vendas: leads, etapas e o razão de eventos.
 *
 * A ideia central: **etapa é consequência, não campo.** Ninguém "marca"
 * que o lead está em conversa — ele está porque chegou mensagem. Ninguém
 * marca experimental agendada — ela está porque o EVO aceitou o
 * agendamento. Cada avanço passa por `mudarEtapa`, que grava um evento
 * dizendo quem causou e por quê.
 *
 * Isso importa porque a alternativa (consultor arrastando cartão) é
 * exatamente o que já não funciona no EVO desta academia: `currentStep`
 * está null em 100% dos 50 prospects mais recentes.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from './evolution.js';

/**
 * Ordem do funil. É a mesma ordem do ENUM no banco — o Postgres ordena
 * enum pela posição de declaração, então `ORDER BY stage` sai certo sem
 * CASE WHEN.
 */
export const ETAPAS = [
  'novo',
  'em_conversa',
  'aguardando_consultor',
  'com_consultor',
  'experimental_agendada',
  'experimental_realizada',
  'ganho',
  'perdido',
];

export const ETAPAS_ROTULO = {
  novo: 'Novo',
  em_conversa: 'Em conversa',
  aguardando_consultor: 'Aguardando consultor',
  com_consultor: 'Com consultor',
  experimental_agendada: 'Experimental agendada',
  experimental_realizada: 'Experimental realizada',
  ganho: 'Ganho',
  perdido: 'Perdido',
};

/** Etapas que encerram o lead. Nada avança automaticamente a partir delas. */
const ETAPAS_FINAIS = new Set(['ganho', 'perdido']);

function posicao(etapa) {
  const i = ETAPAS.indexOf(etapa);
  return i === -1 ? 0 : i;
}

// ──────────────────────────────────────────────
// Eventos
// ──────────────────────────────────────────────

/**
 * Grava um evento no razão do lead.
 * Nunca lança: um evento que falha não pode derrubar a ação que o gerou
 * (a venda foi feita no EVO; perder a linha de log é ruim, perder a
 * resposta HTTP depois de escrever em produção é pior).
 */
export async function registrarEvento(leadId, {
  type, stageFrom = null, stageTo = null, actor = 'sistema',
  actorUserId = null, summary = null, payload = {},
}) {
  const { data, error } = await supabase
    .from('crm_lead_events')
    .insert({
      lead_id: leadId,
      type,
      stage_from: stageFrom,
      stage_to: stageTo,
      actor,
      actor_user_id: actorUserId,
      summary,
      payload,
    })
    .select()
    .single();

  if (error) logger.error('[funil] Falha ao gravar evento:', error.message);
  return data;
}

// ──────────────────────────────────────────────
// Leads
// ──────────────────────────────────────────────

/** Busca o lead ABERTO de um contato do WhatsApp. */
export async function leadAbertoPorContato(contactId) {
  const { data } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('contact_id', contactId)
    .not('stage', 'in', '(ganho,perdido)')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/** Busca lead pelo prospect do EVO. */
export async function leadPorProspect(idProspect) {
  const { data } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('evo_id_prospect', idProspect)
    .maybeSingle();
  return data || null;
}

/** Busca lead pelo membro do EVO (depois da conversão). */
export async function leadPorMembro(idMember) {
  const { data } = await supabase
    .from('crm_leads')
    .select('*')
    .eq('evo_id_member', idMember)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/**
 * Garante que existe um lead aberto para este contato do WhatsApp.
 *
 * Chamado no caminho da mensagem recebida, então precisa ser barato e não
 * pode explodir: se o funil falhar, o atendimento continua.
 */
export async function garantirLeadDoContato(contato, { source = 'whatsapp' } = {}) {
  if (!contato?.id) return null;

  const existente = await leadAbertoPorContato(contato.id);
  if (existente) return existente;

  const { data, error } = await supabase
    .from('crm_leads')
    .insert({
      contact_id: contato.id,
      full_name: contato.name || null,
      phone: contato.phone || null,
      evo_id_member: contato.evo_member_id || null,
      stage: 'novo',
      source,
      last_activity_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    // A UNIQUE parcial de contato aberto pode ter perdido a corrida com
    // outra mensagem do mesmo contato. Nesse caso o lead existe: releia.
    if (error.code === '23505') return leadAbertoPorContato(contato.id);
    logger.error('[funil] Falha ao criar lead:', error.message);
    return null;
  }

  logger.info(`[funil] Lead ${data.id} criado para contato ${contato.id}`);
  await registrarEvento(data.id, {
    type: 'lead_criado',
    stageTo: 'novo',
    actor: source === 'whatsapp' ? 'leia' : 'sistema',
    summary: `Lead aberto via ${source}`,
  });
  return data;
}

/** Cria um lead direto no painel (quem chegou na recepção, sem WhatsApp). */
export async function criarLeadManual(dados, usuario) {
  const phone = dados.telefone ? normalizePhone(dados.telefone) : null;

  const { data, error } = await supabase
    .from('crm_leads')
    .insert({
      full_name: dados.nomeCompleto || null,
      birth_date: dados.dataNascimento || null,
      email: dados.email || null,
      phone,
      interest: dados.interesse || null,
      evo_interests: dados.interesses || [],
      notes: dados.observacoes || null,
      source: dados.origem || 'painel',
      stage: 'com_consultor',
      owner_user_id: usuario?.id || null,
      last_activity_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw new Error(`não foi possível criar o lead: ${error.message}`);

  await registrarEvento(data.id, {
    type: 'lead_criado',
    stageTo: 'com_consultor',
    actor: usuario ? `user:${usuario.id}` : 'sistema',
    actorUserId: usuario?.id || null,
    summary: `Lead cadastrado no painel por ${usuario?.nome || 'sistema'}`,
  });

  return data;
}

// ──────────────────────────────────────────────
// Etapas
// ──────────────────────────────────────────────

/**
 * Move o lead de etapa e registra o evento.
 *
 * @param {number|object} lead - id ou a linha já carregada
 * @param {string} novaEtapa
 * @param {object} opcoes
 * @param {boolean} [opcoes.somenteAvanco=false] - não retroceder. Usado pelos
 *   gatilhos automáticos: a chegada de uma mensagem não pode puxar de volta
 *   para 'em_conversa' um lead que já está em 'experimental_agendada'.
 * @param {object} [opcoes.campos] - colunas extras a atualizar junto
 */
export async function mudarEtapa(lead, novaEtapa, {
  actor = 'sistema', actorUserId = null, motivo = null,
  somenteAvanco = false, campos = {}, payload = {},
} = {}) {
  const atual = typeof lead === 'object' && lead !== null
    ? lead
    : (await supabase.from('crm_leads').select('*').eq('id', lead).maybeSingle()).data;

  if (!atual) {
    logger.warn(`[funil] mudarEtapa: lead ${lead} não encontrado`);
    return null;
  }

  if (!ETAPAS.includes(novaEtapa)) {
    throw new Error(`etapa desconhecida: ${novaEtapa}`);
  }

  const mesmaEtapa = atual.stage === novaEtapa;
  const retrocesso = posicao(novaEtapa) < posicao(atual.stage);
  const jaFechado = ETAPAS_FINAIS.has(atual.stage);

  // Gatilho automático nunca retrocede nem reabre lead fechado. Consultor
  // pode: é ele quem sabe que a pessoa desistiu depois de agendar.
  const bloquear = somenteAvanco && (mesmaEtapa || retrocesso || jaFechado);

  const update = { ...campos, last_activity_at: new Date().toISOString() };
  if (!bloquear) update.stage = novaEtapa;

  const { data, error } = await supabase
    .from('crm_leads')
    .update(update)
    .eq('id', atual.id)
    .select()
    .single();

  if (error) {
    logger.error('[funil] Falha ao mudar etapa:', error.message);
    return atual;
  }

  if (!bloquear && !mesmaEtapa) {
    await registrarEvento(atual.id, {
      type: 'stage_change',
      stageFrom: atual.stage,
      stageTo: novaEtapa,
      actor,
      actorUserId,
      summary: motivo || `${ETAPAS_ROTULO[atual.stage]} → ${ETAPAS_ROTULO[novaEtapa]}`,
      payload,
    });
    logger.info(`[funil] Lead ${atual.id}: ${atual.stage} → ${novaEtapa} (${actor})`);
  }

  return data;
}

/** Só encosta em last_activity_at, sem mexer na etapa. */
export async function tocarAtividade(leadId) {
  await supabase
    .from('crm_leads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', leadId);
}

// ──────────────────────────────────────────────
// Gatilhos automáticos (chamados pelo fluxo do WhatsApp)
// ──────────────────────────────────────────────

/**
 * Mensagem recebida de um contato → o lead está em conversa.
 * Envolvido em try/catch por quem chama: o funil nunca derruba o atendimento.
 */
export async function aoReceberMensagem(contato) {
  const lead = await garantirLeadDoContato(contato);
  if (!lead) return null;
  return mudarEtapa(lead, 'em_conversa', {
    actor: 'leia',
    somenteAvanco: true,
    motivo: 'Cliente respondeu no WhatsApp',
  });
}

/** Handoff aberto → entra na fila do consultor. */
export async function aoAbrirHandoff(contato, motivo) {
  const lead = await garantirLeadDoContato(contato);
  if (!lead) return null;
  return mudarEtapa(lead, 'aguardando_consultor', {
    actor: 'leia',
    somenteAvanco: true,
    motivo: motivo ? `Handoff: ${motivo}` : 'Handoff aberto pela Leia',
  });
}

/** Consultor respondeu pelo WhatsApp ou assumiu no painel. */
export async function aoConsultorAssumir(contato, { usuario = null, via = 'whatsapp' } = {}) {
  const lead = await garantirLeadDoContato(contato);
  if (!lead) return null;
  return mudarEtapa(lead, 'com_consultor', {
    actor: usuario ? `user:${usuario.id}` : 'consultor',
    actorUserId: usuario?.id || null,
    somenteAvanco: true,
    motivo: `Consultor assumiu (${via})`,
    campos: usuario && !lead.owner_user_id ? { owner_user_id: usuario.id } : {},
  });
}

// ──────────────────────────────────────────────
// A tabela do funil
// ──────────────────────────────────────────────

/**
 * Lista o funil com filtros. É a consulta da tela principal do painel.
 *
 * Um SELECT só, sem N+1: os dados que a tabela mostra estão todos em
 * crm_leads (é o motivo de ela ser desnormalizada), e o join traz apenas
 * o nome do dono e o telefone do contato.
 */
export async function listarFunil(filtros = {}) {
  const {
    etapas, dono, origem, busca, desde, ate,
    ordenar = 'last_activity_at', direcao = 'desc',
    limite = 200, offset = 0, incluirFechados = false,
  } = filtros;

  let q = supabase
    .from('crm_leads')
    .select(`
      id, full_name, phone, email, birth_date,
      stage, stage_since, source, interest,
      evo_id_prospect, evo_id_member, evo_sync, evo_sync_error,
      experimental_at, experimental_status, experimental_activity,
      sale_at, sale_value, evo_id_sale,
      last_activity_at, next_action_at, next_action_note,
      lost_reason, notes, created_at,
      owner:crm_users ( id, name ),
      contato:wa_contacts ( id, phone, name, tags )
    `, { count: 'exact' });

  if (Array.isArray(etapas) && etapas.length) q = q.in('stage', etapas);
  else if (!incluirFechados) q = q.not('stage', 'in', '(ganho,perdido)');

  if (dono === 'sem_dono') q = q.is('owner_user_id', null);
  else if (dono) q = q.eq('owner_user_id', dono);

  if (origem) q = q.eq('source', origem);
  if (desde) q = q.gte('created_at', desde);
  if (ate) q = q.lte('created_at', ate);

  if (busca) {
    const t = String(busca).replace(/[%,()]/g, '').trim();
    if (t) q = q.or(`full_name.ilike.%${t}%,phone.ilike.%${t}%,email.ilike.%${t}%`);
  }

  const colunasOrdenaveis = new Set([
    'last_activity_at', 'created_at', 'stage', 'stage_since',
    'full_name', 'experimental_at', 'sale_at', 'sale_value', 'next_action_at',
  ]);
  const coluna = colunasOrdenaveis.has(ordenar) ? ordenar : 'last_activity_at';

  q = q.order(coluna, { ascending: direcao === 'asc', nullsFirst: false })
       .range(offset, offset + Math.min(limite, 500) - 1);

  const { data, error, count } = await q;
  if (error) throw new Error(`falha ao listar o funil: ${error.message}`);

  return { leads: data || [], total: count ?? 0 };
}

/**
 * Números do funil: quanto tem em cada etapa, o que está parado e a
 * conversão do período.
 *
 * "Parado" é o sinal que a tabela existe para dar: lead em
 * `aguardando_consultor` há dois dias é fila que ninguém olhou — o buraco
 * que o handoff tem desde o começo do projeto.
 */
export async function metricasFunil({ desde = null, diasParado = 2 } = {}) {
  let q = supabase.from('crm_leads').select('stage, stage_since, sale_value, sale_at, created_at, next_action_at');
  if (desde) q = q.gte('created_at', desde);

  const { data, error } = await q;
  if (error) throw new Error(`falha ao calcular métricas: ${error.message}`);

  const agora = Date.now();
  const limiteParado = diasParado * 24 * 60 * 60 * 1000;

  const porEtapa = Object.fromEntries(ETAPAS.map(e => [e, 0]));
  let parados = 0, vencidos = 0, receita = 0, ganhos = 0, perdidos = 0;

  for (const l of data || []) {
    porEtapa[l.stage] = (porEtapa[l.stage] || 0) + 1;

    if (l.stage === 'ganho') { ganhos++; receita += Number(l.sale_value || 0); }
    else if (l.stage === 'perdido') { perdidos++; }
    else {
      if (agora - new Date(l.stage_since).getTime() > limiteParado) parados++;
      if (l.next_action_at && new Date(l.next_action_at).getTime() < agora) vencidos++;
    }
  }

  const fechados = ganhos + perdidos;
  const abertos = (data || []).length - fechados;

  return {
    total: (data || []).length,
    abertos,
    porEtapa,
    ganhos,
    perdidos,
    receita,
    // Conversão sobre decididos, não sobre o total: contar quem ainda está
    // no meio do funil como "não convertido" faz a taxa cair sozinha só
    // porque entraram leads novos hoje.
    conversao: fechados ? Number(((ganhos / fechados) * 100).toFixed(1)) : null,
    parados,
    followupsVencidos: vencidos,
    diasParado,
  };
}

/** Histórico completo de um lead: a ficha, o razão e a conversa vinculada. */
export async function fichaDoLead(leadId) {
  const { data: lead, error } = await supabase
    .from('crm_leads')
    .select(`
      *,
      owner:crm_users ( id, name, email ),
      contato:wa_contacts ( id, phone, name, tags, is_prospect, evo_member_id )
    `)
    .eq('id', leadId)
    .maybeSingle();

  if (error) throw new Error(`falha ao ler o lead: ${error.message}`);
  if (!lead) return null;

  const { data: eventos } = await supabase
    .from('crm_lead_events')
    .select('id, type, stage_from, stage_to, actor, summary, payload, occurred_at')
    .eq('lead_id', leadId)
    .order('occurred_at', { ascending: false })
    .limit(200);

  let conversas = [];
  if (lead.contact_id) {
    const { data } = await supabase
      .from('wa_conversations')
      .select('id, status, channel, started_at, last_message, assigned_to')
      .eq('contact_id', lead.contact_id)
      .order('started_at', { ascending: false });
    conversas = data || [];
  }

  return { lead, eventos: eventos || [], conversas };
}

export const funil = {
  ETAPAS, ETAPAS_ROTULO,
  registrarEvento,
  leadAbertoPorContato, leadPorProspect, leadPorMembro,
  garantirLeadDoContato, criarLeadManual,
  mudarEtapa, tocarAtividade,
  aoReceberMensagem, aoAbrirHandoff, aoConsultorAssumir,
  listarFunil, metricasFunil, fichaDoLead,
};
