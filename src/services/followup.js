/**
 * src/services/followup.js
 * Follow-up de venda: agendar, cancelar e decidir a próxima rodada.
 *
 * O que este módulo NÃO faz é escrever a mensagem — isso é do worker, no
 * momento do envio. A razão está na régua: o follow-up de depois da aula
 * precisa saber se a pessoa **compareceu**, e isso só se sabe depois da
 * aula. Guardar a frase pronta no agendamento produziria "como foi a
 * aula?" para quem faltou, que é pior do que não mandar nada.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { registrarEvento } from './funil.js';

/**
 * Janela de contato ativo: 9h00 às 20h30, horário de São Paulo.
 *
 * Vale para toda mensagem que **parte** da academia. Responder quem
 * escreveu é outra coisa e vale a qualquer hora.
 */
export const JANELA = { inicioMin: 9 * 60, fimMin: 20 * 60 + 30 };

// O Brasil aboliu o horário de verão em 2019, então São Paulo é UTC-3 o
// ano todo. Se algum dia voltar, esta constante vira uma conversão por
// Intl — e é por isso que ela está isolada aqui.
const OFFSET_SP_MS = -3 * 60 * 60 * 1000;

/** Partes locais de São Paulo (ano, mês, dia, hora, minuto) de um Date. */
function partesSP(data) {
  const deslocado = new Date(data.getTime() + OFFSET_SP_MS);
  return {
    ano: deslocado.getUTCFullYear(),
    mes: deslocado.getUTCMonth(),
    dia: deslocado.getUTCDate(),
    hora: deslocado.getUTCHours(),
    minuto: deslocado.getUTCMinutes(),
    diaSemana: deslocado.getUTCDay(),   // 0 = domingo
  };
}

/** Monta um Date a partir de uma hora local de São Paulo. */
function deSP({ ano, mes, dia, hora, minuto = 0 }) {
  return new Date(Date.UTC(ano, mes, dia, hora, minuto) - OFFSET_SP_MS);
}

/**
 * Empurra um horário para dentro da janela de contato ativo.
 *
 * Antes das 9h → 9h do mesmo dia. Depois das 20h30 → 9h do dia seguinte.
 * Domingo é dia normal para mensagem: a academia não abre, mas mandar
 * WhatsApp no domingo de manhã não incomoda ninguém e o lead responde.
 */
export function dentroDaJanela(data) {
  const p = partesSP(data);
  const minutos = p.hora * 60 + p.minuto;

  if (minutos < JANELA.inicioMin) {
    return deSP({ ...p, hora: 9, minuto: 0 });
  }
  if (minutos > JANELA.fimMin) {
    const amanha = new Date(data.getTime() + 24 * 60 * 60 * 1000);
    const pa = partesSP(amanha);
    return deSP({ ...pa, hora: 9, minuto: 0 });
  }
  return data;
}

/**
 * Agenda um follow-up.
 *
 * Idempotente pela UNIQUE parcial `(lead_id, tipo) WHERE pendente`: chamar
 * duas vezes não gera duas cobranças. Reagendamento explícito atualiza a
 * data em vez de duplicar.
 */
export async function agendar(leadId, tipo, quando, contexto = {}) {
  const alvo = dentroDaJanela(quando instanceof Date ? quando : new Date(quando));

  const { data, error } = await supabase
    .from('crm_followups')
    .insert({
      lead_id: leadId,
      tipo,
      scheduled_for: alvo.toISOString(),
      contexto,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      // Já existe um pendente deste tipo: atualiza a data.
      const { data: atualizado } = await supabase
        .from('crm_followups')
        .update({ scheduled_for: alvo.toISOString(), contexto })
        .eq('lead_id', leadId)
        .eq('tipo', tipo)
        .eq('status', 'pendente')
        .select()
        .single();

      logger.info(`[followup] Lead ${leadId}: ${tipo} reagendado para ${alvo.toISOString()}`);
      return atualizado;
    }
    logger.error(`[followup] Falha ao agendar ${tipo}:`, error.message);
    return null;
  }

  logger.info(`[followup] Lead ${leadId}: ${tipo} agendado para ${alvo.toISOString()}`);
  return data;
}

/** Cancela follow-ups pendentes de um lead. `tipos` vazio = todos. */
export async function cancelar(leadId, tipos = [], motivo = 'cancelado') {
  let q = supabase
    .from('crm_followups')
    .update({ status: 'cancelado', erro: motivo })
    .eq('lead_id', leadId)
    .eq('status', 'pendente');

  if (tipos.length) q = q.in('tipo', tipos);

  const { data, error } = await q.select('id, tipo');
  if (error) {
    logger.error('[followup] Falha ao cancelar:', error.message);
    return 0;
  }

  if (data?.length) {
    logger.info(`[followup] Lead ${leadId}: ${data.length} follow-up(s) cancelado(s) — ${motivo}`);
  }
  return data?.length || 0;
}

/**
 * Chamado quando a aula experimental é agendada.
 *
 * Dois follow-ups nascem juntos porque nascem do mesmo fato:
 *
 *  - **24h antes**: confirmar presença e reforçar o valor de ir. É o
 *    momento em que a pessoa decide se vai mesmo, e um lembrete muda essa
 *    taxa mais do que qualquer argumento depois.
 *  - **4h depois**: consultar presença e conversar de acordo. Quatro horas
 *    dão tempo de a academia marcar a presença no sistema sem a conversa
 *    esfriar.
 */
export async function aoAgendarExperimental(lead, { dataHora, atividade }) {
  const aula = new Date(String(dataHora).replace(' ', 'T') + ':00-03:00');
  if (Number.isNaN(aula.getTime())) return;

  const contexto = { aula: aula.toISOString(), atividade: atividade || null };

  const lembrete = new Date(aula.getTime() - 24 * 60 * 60 * 1000);

  // Aula marcada para daqui a menos de 24h não recebe lembrete: ele
  // chegaria depois da aula, ou junto com a confirmação que a pessoa
  // acabou de receber.
  if (lembrete.getTime() > Date.now() + 30 * 60 * 1000) {
    await agendar(lead.id, 'ae_lembrete_24h', lembrete, contexto);
  } else {
    logger.info(`[followup] Lead ${lead.id}: aula em menos de 24h, sem lembrete`);
  }

  await agendar(lead.id, 'ae_pos_aula', new Date(aula.getTime() + 4 * 60 * 60 * 1000), contexto);
}

/**
 * Depois do follow-up pós-aula, decide se abre nova rodada de sondagem.
 *
 * Teto de duas rodadas, e depois o lead é dado como perdido de forma
 * explícita. Sem teto isto vira perseguição — e um "perdido" honesto vale
 * mais para o funil do que um lead eternamente "em conversa" que ninguém
 * mais vai atender.
 */
export async function proximaSondagem(lead) {
  const { data: feitas } = await supabase
    .from('crm_followups')
    .select('tipo')
    .eq('lead_id', lead.id)
    .in('tipo', ['sondagem_1', 'sondagem_2'])
    .in('status', ['enviado', 'pendente']);

  const jaFeitas = new Set((feitas || []).map(f => f.tipo));

  if (!jaFeitas.has('sondagem_1')) {
    return { tipo: 'sondagem_1', quando: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) };
  }
  if (!jaFeitas.has('sondagem_2')) {
    return { tipo: 'sondagem_2', quando: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000) };
  }
  return null;   // acabou: o chamador marca como perdido
}

/** Follow-ups vencidos, prontos para envio. */
export async function vencidos(limite = 20) {
  const { data, error } = await supabase
    .from('crm_followups')
    .select(`
      id, tipo, scheduled_for, contexto, tentativas,
      lead:crm_leads (
        id, full_name, phone, stage, contact_id, interest,
        evo_id_prospect, evo_id_member, experimental_at, experimental_activity
      )
    `)
    .eq('status', 'pendente')
    .lte('scheduled_for', new Date().toISOString())
    .lt('tentativas', 3)
    .order('scheduled_for', { ascending: true })
    .limit(limite);

  if (error) {
    logger.error('[followup] Falha ao buscar vencidos:', error.message);
    return [];
  }
  return data || [];
}

/** Marca o resultado do envio. */
export async function registrarEnvio(followupId, { mensagem, presenca, erro = null }) {
  await supabase
    .from('crm_followups')
    .update({
      status: erro ? 'falhou' : 'enviado',
      mensagem: mensagem || null,
      presenca: presenca || null,
      erro,
      sent_at: erro ? null : new Date().toISOString(),
      tentativas: undefined,
    })
    .eq('id', followupId);
}

/** Incrementa tentativas sem mudar o status (para nova tentativa depois). */
export async function registrarTentativa(followupId, tentativas, erro) {
  await supabase
    .from('crm_followups')
    .update({ tentativas: tentativas + 1, erro: String(erro).slice(0, 400) })
    .eq('id', followupId);
}

/** Anota o follow-up no razão do lead. */
export async function registrarNoFunil(leadId, tipo, resumo, payload = {}) {
  await registrarEvento(leadId, {
    type: 'followup_enviado',
    actor: 'leia',
    summary: resumo,
    payload: { tipo, ...payload },
  });
}

export const followup = {
  JANELA, dentroDaJanela,
  agendar, cancelar, aoAgendarExperimental, proximaSondagem,
  vencidos, registrarEnvio, registrarTentativa, registrarNoFunil,
};
