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
import { config } from '../config.js';
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
  'finalizado',
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
  finalizado: 'Finalizado',
};

/** Etapas que encerram o lead. Nada avança automaticamente a partir delas. */
const ETAPAS_FINAIS = new Set(['ganho', 'perdido', 'finalizado']);

/**
 * Etapas que só existem porque houve um fato de VENDA — experimental
 * marcada, venda fechada, venda perdida.
 *
 * Uma linha que chegou a qualquer uma delas não é mais reclassificável
 * para fora da venda: o fato aconteceu, e é o funil que precisa dele.
 */
const ETAPAS_COM_FATO_DE_VENDA = new Set([
  'experimental_agendada', 'experimental_realizada', 'ganho', 'perdido',
]);

/**
 * As etapas fechadas, no formato que o PostgREST quer no `.not('stage','in',…)`.
 *
 * Existe para haver UMA definição de "atendimento encerrado". Ela estava
 * copiada em quatro consultas como `'(ganho,perdido)'`, e quando entrou
 * `finalizado` cada cópia esquecida virava um lead fechado que continua
 * aparecendo como aberto — na varredura de follow-up, inclusive.
 */
export const FILTRO_ETAPAS_FECHADAS = `(${[...ETAPAS_FINAIS].join(',')})`;

// ──────────────────────────────────────────────
// As duas trilhas
//
// Todo contato que escreve no WhatsApp abre uma linha em `crm_leads` — é o
// número principal da academia, então quem escreve é tanto quem quer
// comprar quanto o aluno perguntando o horário da natação, o convênio, o
// fornecedor de toalha e o vendedor de software. Até 31/08/2026 todos
// entravam no MESMO funil de venda, e o efeito é que a leitura do painel
// deixava de valer: "leads abertos" contava aluno matriculado, "parados"
// contava fornecedor que nunca teve o que responder, e a conversão saía
// diluída por gente que nunca esteve comprando.
//
// A trilha é a ramificação. `lead` é o funil de venda, com experimental,
// venda e perda. `relacionamento` é o atendimento que não é venda, e tem
// só três paradas — CONVERSAS → COM CONSULTOR → FINALIZADAS.
//
// A trilha NÃO é uma etapa nem um filtro de tela: é o que separa as duas
// contagens e o que decide quem a régua de follow-up pode cutucar.
// ──────────────────────────────────────────────

export const TRILHAS = ['lead', 'relacionamento'];

/**
 * O que a Leia (ou o consultor) diz que este contato é.
 *
 * O tipo é o fato observado; a trilha é a consequência dele. Guardar os
 * dois é o que permite ler "quantos atendimentos de convênio tivemos" sem
 * perder a pergunta mais simples ("isto é venda ou não?").
 */
export const TIPOS_CONTATO = {
  lead:       { rotulo: 'Lead',                  trilha: 'lead' },
  aluno:      { rotulo: 'Aluno matriculado',     trilha: 'relacionamento' },
  convenio:   { rotulo: 'Convênio / agregador',  trilha: 'relacionamento' },
  fornecedor: { rotulo: 'Fornecedor / vendedor', trilha: 'relacionamento' },
  outro:      { rotulo: 'Outro contato',         trilha: 'relacionamento' },
};

export function trilhaDoTipo(tipo) {
  return TIPOS_CONTATO[tipo]?.trilha || 'lead';
}

/**
 * As etapas que cada trilha usa.
 *
 * As três primeiras são compartilhadas de propósito: chegar mensagem,
 * abrir handoff e o consultor assumir acontecem igual nas duas, e são os
 * mesmos gatilhos que as movem. O que muda é o fim da linha — venda de um
 * lado, atendimento encerrado do outro.
 */
export const ETAPAS_POR_TRILHA = {
  lead: [
    'novo', 'em_conversa', 'aguardando_consultor', 'com_consultor',
    'experimental_agendada', 'experimental_realizada', 'ganho', 'perdido',
  ],
  relacionamento: [
    'novo', 'em_conversa', 'aguardando_consultor', 'com_consultor', 'finalizado',
  ],
};

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
    .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
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

  // A trilha nasce do que já se sabe do CONTATO, não da linha nova.
  //
  // Quem foi classificado uma vez continua classificado: o aluno que
  // pergunta o horário hoje e volta a perguntar mês que vem não deve
  // entrar como lead de venda outra vez só porque o atendimento anterior
  // foi finalizado. Sem tipo gravado, o padrão é `lead` — é o que ele era
  // antes de existir ramificação, e a Leia corrige na primeira mensagem em
  // que der para saber.
  const tipo = TIPOS_CONTATO[contato.tipo_contato] ? contato.tipo_contato : 'lead';

  const { data, error } = await supabase
    .from('crm_leads')
    .insert({
      contact_id: contato.id,
      full_name: contato.name || null,
      phone: contato.phone || null,
      evo_id_member: contato.evo_member_id || null,
      stage: 'novo',
      tipo_contato: tipo,
      trilha: trilhaDoTipo(tipo),
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
// Ramificação
// ──────────────────────────────────────────────

/**
 * Define o que este contato é, e com isso em qual trilha ele corre.
 *
 * Quem chama é a Leia, pela tool `definir_tipo_atendimento`, assim que a
 * conversa deixa claro com quem ela está falando — e o consultor, pelo
 * painel, quando ela erra ou quando o atendimento nasceu no balcão.
 *
 * ## O tipo fica no CONTATO, a trilha fica na linha
 *
 * São perguntas diferentes. "Este número é de um aluno" é permanente e
 * vale para o próximo atendimento dele; "este atendimento é de venda" vale
 * para esta linha e pode mudar no meio (o aluno que resolve levar o filho
 * para a natação virou lead de novo, e o `mudarEtapa` trata disso).
 * Guardar só na linha faria o mesmo aluno voltar a nascer como lead toda
 * vez que abrisse uma conversa nova.
 *
 * ## Linha fechada não é reclassificada
 *
 * Um lead `ganho` continua `ganho` na trilha de venda para sempre, mesmo
 * depois de a pessoa virar aluna — senão a venda desaparece da conversão
 * no dia seguinte ao fechamento. A classificação nova vale para o contato
 * e para o próximo atendimento, não para o histórico já fechado.
 *
 * ## `forcar` é o botão do painel
 *
 * O gatilho automático não atropela fato de venda: se a varredura pergunta
 * ao EVO e descobre contrato ativo num lead que já marcou experimental, ela
 * grava o tipo no contato e deixa a linha onde está — reclassificar ali
 * apagaria o agendamento do funil e cancelaria o lembrete da aula.
 *
 * O consultor pode. Ele está vendo a conversa, e quando diz que aquilo não
 * é venda, é ele quem sabe. `forcar` move a linha mesmo assim, ajustando a
 * etapa quando ela não existe do outro lado.
 *
 * A única coisa que ninguém move é atendimento **encerrado**: histórico
 * reescrito não é histórico. Nesse caso a resposta diz isso em vez de
 * fingir que moveu.
 *
 * @param {number|object} lead   - id ou a linha já carregada
 * @param {string} tipo          - uma chave de `TIPOS_CONTATO`
 * @returns {Promise<{lead: object, movido: boolean, aviso: string|null}|null>}
 */
export async function definirTipoDeContato(lead, tipo, {
  actor = 'leia', actorUserId = null, motivo = null, forcar = false,
} = {}) {
  if (!TIPOS_CONTATO[tipo]) {
    throw new Error(`tipo de contato desconhecido: ${tipo}`);
  }

  const atual = typeof lead === 'object' && lead !== null
    ? lead
    : (await supabase.from('crm_leads').select('*').eq('id', lead).maybeSingle()).data;

  if (!atual) {
    logger.warn(`[funil] definirTipoDeContato: lead ${lead} não encontrado`);
    return null;
  }

  const trilha = trilhaDoTipo(tipo);

  // A memória vale mesmo quando a linha atual não muda: é ela que faz o
  // próximo atendimento nascer na trilha certa.
  if (atual.contact_id) {
    await supabase
      .from('wa_contacts')
      .update({ tipo_contato: tipo })
      .eq('id', atual.contact_id);
  }

  // Atendimento encerrado não se mexe, em nenhuma direção e por ninguém:
  // ele é histórico, e histórico reescrito não é histórico. O contato já
  // foi marcado acima, então o PRÓXIMO atendimento dele nasce na trilha
  // certa — que é o que dá para consertar sem mentir sobre o passado.
  if (ETAPAS_FINAIS.has(atual.stage)) {
    logger.info(
      `[funil] Contato ${atual.contact_id} marcado como "${tipo}" — ` +
      `lead ${atual.id} está em ${atual.stage} e fica como está`
    );
    return {
      lead: atual,
      movido: false,
      aviso: `Este atendimento está encerrado (${ETAPAS_ROTULO[atual.stage]}) e não muda de funil. ` +
        `O contato ficou marcado como "${TIPOS_CONTATO[tipo].rotulo}" e o próximo atendimento dele já nasce assim.`,
    };
  }

  // Fato de venda registrado só é atropelado por gente.
  //
  // Aluno de musculação que agenda uma aula de natação para experimentar
  // está numa ação de venda, e a varredura vai descobrir no EVO que ele tem
  // contrato ativo. Se o automático arrastasse a linha para o
  // relacionamento, o agendamento sumiria do funil e o lembrete da aula
  // seria cancelado junto — o cliente perderia a aula por causa de uma
  // reclassificação que ninguém pediu.
  if (trilha !== 'lead' && ETAPAS_COM_FATO_DE_VENDA.has(atual.stage) && !forcar) {
    logger.info(
      `[funil] Contato ${atual.contact_id} marcado como "${tipo}" — ` +
      `lead ${atual.id} tem ${atual.stage} e fica na trilha de venda`
    );
    return {
      lead: atual,
      movido: false,
      aviso: `O contato foi marcado como "${TIPOS_CONTATO[tipo].rotulo}", mas o atendimento ` +
        'tem experimental registrada e ficou na venda.',
    };
  }

  if (atual.tipo_contato === tipo && (atual.trilha || 'lead') === trilha) {
    return { lead: atual, movido: false, aviso: null };
  }

  const { data, error } = await supabase
    .from('crm_leads')
    .update({ tipo_contato: tipo, trilha, last_activity_at: new Date().toISOString() })
    .eq('id', atual.id)
    .select()
    .single();

  if (error) {
    logger.error('[funil] Falha ao definir o tipo do contato:', error.message);
    return { lead: atual, movido: false, aviso: `Não deu para gravar: ${error.message}` };
  }

  // Sair da venda desliga a régua de venda na hora, sem esperar a próxima
  // varredura. O que estava agendado foi agendado para um lead que não
  // existe mais: "o que falta para você decidir?" não se manda para o
  // fornecedor de toalha nem para quem já é aluno.
  if (trilha !== 'lead') {
    try {
      const { followup } = await import('./followup.js');
      await followup.cancelar(atual.id, [], `contato classificado como "${tipo}"`);
    } catch (err) {
      logger.error('[funil] Falha ao cancelar follow-ups na reclassificação:', err.message);
    }
  }

  await registrarEvento(atual.id, {
    type: 'tipo_definido',
    actor,
    actorUserId,
    summary: motivo
      ? `${TIPOS_CONTATO[tipo].rotulo}: ${motivo}`
      : `Classificado como ${TIPOS_CONTATO[tipo].rotulo}`,
    payload: { tipo, trilha, tipo_anterior: atual.tipo_contato || null },
  });

  logger.info(
    `[funil] Lead ${atual.id}: tipo "${tipo}" → trilha ${trilha} (${actor})`
  );

  // A etapa pode não existir do outro lado — só acontece no movimento
  // forçado, porque o automático nem chega aqui com experimental na linha.
  // O atendimento vai para a única parada da outra trilha que descreve o
  // que está acontecendo com ele: alguém cuidando.
  if (!ETAPAS_POR_TRILHA[trilha].includes(data.stage)) {
    const movido = await mudarEtapa(data, 'com_consultor', {
      actor,
      actorUserId,
      motivo: `"${ETAPAS_ROTULO[data.stage]}" não existe fora da venda`,
    });
    return {
      lead: movido || data,
      movido: true,
      aviso: `Movido para ${TIPOS_CONTATO[tipo].rotulo}. A etapa virou "Com consultor": ` +
        `"${ETAPAS_ROTULO[data.stage]}" só existe na venda.`,
    };
  }

  return { lead: data, movido: true, aviso: null };
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

  // Etapa de venda numa linha de relacionamento devolve a linha à venda.
  //
  // Quem move para `experimental_agendada` ou `ganho` é fato do EVO, não
  // opinião: o aluno que só perguntava horário marcou experimental de
  // outra modalidade, ou comprou um plano a mais. Recusar a etapa
  // esconderia uma venda de verdade do funil, e é o funil que precisa
  // dela. Então a linha volta para a trilha de venda — e volta com
  // evento, porque quem olhar o razão depois vai perguntar por quê.
  const trilhaAtual = atual.trilha || 'lead';
  const voltaParaVenda = !bloquear
    && trilhaAtual !== 'lead'
    && !ETAPAS_POR_TRILHA.relacionamento.includes(novaEtapa);
  if (voltaParaVenda) {
    update.trilha = 'lead';
    update.tipo_contato = 'lead';
  }

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

  // Atendimento encerrado não recebe follow-up de venda. Cancelar aqui, e
  // não em cada chamador, é o que garante que vale para todo caminho —
  // painel, webhook do EVO e poller.
  if (!bloquear && !mesmaEtapa && ETAPAS_FINAIS.has(novaEtapa)) {
    try {
      const { followup } = await import('./followup.js');
      await followup.cancelar(atual.id, [], `lead passou para "${novaEtapa}"`);
    } catch (err) {
      logger.error('[funil] Falha ao cancelar follow-ups:', err.message);
    }
  }

  // Vendeu: o número deixou de ser lead e passou a ser aluno.
  //
  // A linha ganha continua na trilha de venda (é ela que a conversão
  // conta), mas o CONTATO muda de natureza — e é ele que decide onde o
  // próximo atendimento nasce. Sem isto, quem comprou hoje volta amanhã
  // perguntando o horário da aula e reabre um lead de venda, que é
  // exatamente a distorção que a ramificação existe para tirar do painel.
  if (!bloquear && !mesmaEtapa && novaEtapa === 'ganho' && atual.contact_id) {
    await supabase
      .from('wa_contacts')
      .update({ tipo_contato: 'aluno' })
      .eq('id', atual.contact_id);
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

  if (voltaParaVenda) {
    await registrarEvento(atual.id, {
      type: 'trilha_alterada',
      actor,
      actorUserId,
      summary: `Voltou para a trilha de venda: ${ETAPAS_ROTULO[novaEtapa]} é etapa de venda`,
      payload: { de: trilhaAtual, para: 'lead' },
    });
    logger.info(`[funil] Lead ${atual.id}: trilha ${trilhaAtual} → lead (${novaEtapa})`);
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
    trilha = 'lead',
    ordenar = 'last_activity_at', direcao = 'desc',
    limite = 200, offset = 0, incluirFechados = false,
  } = filtros;

  let q = supabase
    .from('crm_leads')
    .select(`
      id, full_name, phone, email, birth_date,
      stage, stage_since, source, interest, trilha, tipo_contato,
      evo_id_prospect, evo_id_member, evo_sync, evo_sync_error,
      experimental_at, experimental_status, experimental_activity,
      sale_at, sale_value, evo_id_sale,
      last_activity_at, next_action_at, next_action_note,
      lost_reason, notes, created_at,
      owner:crm_users ( id, name ),
      contato:wa_contacts ( id, phone, name, tags, tipo_contato )
    `, { count: 'exact' });

  // Sem trilha pedida, a tela é a de VENDA. É o que "funil" quer dizer, e
  // ver as duas misturadas é justamente o que se está desfazendo aqui.
  // `todas` existe para busca — o consultor que procura um telefone não
  // sabe (nem deveria precisar saber) em que trilha ele está.
  if (TRILHAS.includes(trilha)) q = q.eq('trilha', trilha);

  if (Array.isArray(etapas) && etapas.length) q = q.in('stage', etapas);
  else if (!incluirFechados) q = q.not('stage', 'in', FILTRO_ETAPAS_FECHADAS);

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
 *
 * **Os números do topo são só da trilha de venda.** Contar aluno, convênio
 * e fornecedor junto era o que fazia "leads abertos" e "parados" não
 * quererem dizer nada: um fornecedor sem resposta há uma semana contava
 * como pipeline parado, e a conversão saía dividida por gente que nunca
 * esteve comprando. O relacionamento continua contado — em `relacionamento`,
 * do lado, onde ele responde outra pergunta ("quanto atendimento não-venda
 * este número absorve?").
 */
export async function metricasFunil({ desde = null, diasParado = 2 } = {}) {
  let q = supabase
    .from('crm_leads')
    .select('stage, stage_since, sale_value, sale_at, created_at, next_action_at, trilha, tipo_contato');
  if (desde) q = q.gte('created_at', desde);

  const { data, error } = await q;
  if (error) throw new Error(`falha ao calcular métricas: ${error.message}`);

  const agora = Date.now();
  const limiteParado = diasParado * 24 * 60 * 60 * 1000;

  const porEtapa = Object.fromEntries(ETAPAS.map(e => [e, 0]));
  let parados = 0, vencidos = 0, receita = 0, ganhos = 0, perdidos = 0, total = 0;

  const relacionamento = {
    total: 0,
    abertos: 0,
    finalizados: 0,
    porEtapa: Object.fromEntries(ETAPAS_POR_TRILHA.relacionamento.map(e => [e, 0])),
    porTipo: Object.fromEntries(Object.keys(TIPOS_CONTATO).map(t => [t, 0])),
  };

  for (const l of data || []) {
    // Linha sem trilha é linha de antes da migração: era tudo venda.
    if ((l.trilha || 'lead') !== 'lead') {
      relacionamento.total++;
      relacionamento.porEtapa[l.stage] = (relacionamento.porEtapa[l.stage] || 0) + 1;
      relacionamento.porTipo[l.tipo_contato] = (relacionamento.porTipo[l.tipo_contato] || 0) + 1;
      if (l.stage === 'finalizado') relacionamento.finalizados++;
      else relacionamento.abertos++;
      continue;
    }

    total++;
    porEtapa[l.stage] = (porEtapa[l.stage] || 0) + 1;

    if (l.stage === 'ganho') { ganhos++; receita += Number(l.sale_value || 0); }
    else if (l.stage === 'perdido') { perdidos++; }
    else {
      if (agora - new Date(l.stage_since).getTime() > limiteParado) parados++;
      if (l.next_action_at && new Date(l.next_action_at).getTime() < agora) vencidos++;
    }
  }

  const fechados = ganhos + perdidos;
  const abertos = total - fechados;

  return {
    total,
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
    relacionamento,
  };
}

/**
 * Encerra os atendimentos de relacionamento que já acabaram sozinhos.
 *
 * O atendimento que não é venda quase nunca tem um fim declarado: a pessoa
 * pergunta o horário da natação, agradece e vai treinar. Ninguém volta ao
 * painel para dizer que acabou — e sem isto a coluna CONVERSAS só cresce,
 * até o painel virar uma lista que ninguém olha porque nunca esvazia.
 *
 * Só encerra: não manda mensagem nenhuma, não avisa a pessoa. E só mexe na
 * trilha de relacionamento — lead parado é trabalho a fazer, e quem decide
 * que ele foi perdido é a régua de follow-up ou o consultor.
 *
 * Se a pessoa escrever de novo, `garantirLeadDoContato` abre um
 * atendimento novo (a linha finalizada não conta como aberta) — na mesma
 * trilha, porque o tipo mora no contato. Cada assunto vira um atendimento,
 * que é o que se quer contar.
 */
export async function encerrarRelacionamentosParados({ dias, limite = 200 } = {}) {
  const prazo = dias ?? config.crm.diasParaFinalizar;
  if (!prazo || prazo <= 0) return { finalizados: 0 };

  const corte = new Date(Date.now() - prazo * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('crm_leads')
    .select('id, stage, full_name, last_activity_at')
    .eq('trilha', 'relacionamento')
    .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
    .lt('last_activity_at', corte)
    .limit(limite);

  if (error) {
    logger.error('[funil] Falha ao varrer relacionamentos parados:', error.message);
    return { finalizados: 0 };
  }
  if (!data?.length) return { finalizados: 0 };

  let finalizados = 0;
  for (const lead of data) {
    const r = await mudarEtapa(lead, 'finalizado', {
      actor: 'sistema',
      motivo: `Sem atividade há ${prazo} dia(s) — atendimento encerrado`,
    });
    if (r?.stage === 'finalizado') finalizados++;
  }

  logger.info(`[funil] ${finalizados} atendimento(s) de relacionamento finalizado(s) por inatividade`);
  return { finalizados };
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
  ETAPAS, ETAPAS_ROTULO, FILTRO_ETAPAS_FECHADAS,
  TRILHAS, TIPOS_CONTATO, ETAPAS_POR_TRILHA, trilhaDoTipo,
  registrarEvento,
  leadAbertoPorContato, leadPorProspect, leadPorMembro,
  garantirLeadDoContato, criarLeadManual, definirTipoDeContato,
  mudarEtapa, tocarAtividade, encerrarRelacionamentosParados,
  aoReceberMensagem, aoAbrirHandoff, aoConsultorAssumir,
  listarFunil, metricasFunil, fichaDoLead,
};
