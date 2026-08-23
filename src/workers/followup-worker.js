/**
 * src/workers/followup-worker.js
 * Envia os follow-ups de venda que venceram.
 *
 * O agente só roda quando chega mensagem — é um `messages.create` por
 * mensagem recebida. Consequência: **quem some, some em silêncio**, e
 * nenhuma regra de prompt recupera essa conversa, porque não existe turno
 * em que o modelo possa agir. Este worker é o turno que faltava.
 *
 * Cada envio segue três passos que não podem trocar de ordem:
 *
 *   1. **Reconferir o mundo.** O lead pode ter convertido, sido perdido ou
 *      respondido desde que o follow-up foi agendado. Mandar assim mesmo é
 *      o erro mais visível que um follow-up automático comete.
 *   2. **Consultar o EVO** quando o assunto depende de um fato de lá —
 *      hoje, se a pessoa compareceu à aula.
 *   3. **Gerar o texto na hora**, com esse contexto, em vez de disparar
 *      uma frase guardada.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { followup } from '../services/followup.js';
import { evoClient } from '../services/evo-client.js';
import { aiAgent } from '../services/ai-agent.js';
import { funil } from '../services/funil.js';
import { saveMessage } from '../services/contacts.js';
import { sendText } from '../services/evolution.js';

let rodando = false;

/** Etapas em que um follow-up de venda deixou de fazer sentido. */
const ETAPAS_MORTAS = new Set(['ganho', 'perdido']);

// ──────────────────────────────────────────────
// A instrução que vai para a Leia
// ──────────────────────────────────────────────

/**
 * Monta a instrução interna que orienta a mensagem.
 *
 * Vai como turno de usuário marcado — e **não é gravada no histórico**.
 * Só a resposta gerada é salva. Assim a instrução orienta este turno sem
 * virar uma fala falsa do cliente nas conversas seguintes.
 */
function instrucao(tipo, { lead, presenca, contexto }) {
  const atividade = contexto?.atividade || lead.experimental_activity || 'a aula';
  const quando = contexto?.aula
    ? new Date(contexto.aula).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit',
        month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : null;

  const cabeca =
    '[INSTRUÇÃO INTERNA DO SISTEMA — isto NÃO é mensagem do cliente. ' +
    'Escreva a próxima mensagem que VOCÊ vai enviar, começando a conversa. ' +
    'Não cumprimente como se fosse o primeiro contato: vocês já se falaram, ' +
    'e o histórico acima é a conversa de vocês.]\n\n';

  const roteiros = {
    ae_lembrete_24h:
      `Lembre a pessoa da aula experimental de ${atividade}${quando ? `, ${quando}` : ''}. ` +
      'Objetivo: confirmar que ela vem, e reforçar em uma linha o que ela ganha indo. ' +
      'Peça uma confirmação simples. Diga o que levar. Curto — duas ou três linhas.',

    ae_pos_aula_presente:
      `Ela FOI à aula de ${atividade}. Pergunte como foi, de forma genuína e específica ` +
      '— não "o que achou?" genérico. Puxe o que ela te contou antes sobre o objetivo dela ' +
      'e conecte com a experiência. Objetivo desta mensagem: colher a impressão, não fechar venda. ' +
      'Uma pergunta só.',

    ae_pos_aula_falta:
      `Ela NÃO compareceu à aula de ${atividade}${quando ? ` (${quando})` : ''}. ` +
      'NÃO cobre e NÃO faça a pessoa se justificar. Trate como algo normal que acontece. ' +
      'Ofereça remarcar, sem pressão, e pergunte que horário seria melhor para ela. ' +
      'Curto e leve.',

    ae_pos_aula_desconhecida:
      `A aula de ${atividade} já passou, mas o sistema não registrou a presença — ` +
      'você NÃO sabe se ela foi. **Não afirme nem sugira que ela faltou.** ' +
      'Pergunte de forma aberta se ela conseguiu vir, de um jeito que funcione nas duas respostas.',

    sondagem_1:
      'Retomada de venda. A pessoa passou pela experiência e ainda não fechou. ' +
      'NÃO reapresente planos e NÃO repita valores que ela já ouviu. ' +
      'A pergunta é outra: **o que falta para ela decidir?** Se ficou algo combinado com o ' +
      'consultor, retome esse ponto pelo nome. Ofereça-se para resolver a dúvida concreta ' +
      'que estiver no caminho. Uma pergunta, tom de quem quer ajudar a decidir, não de quem cobra.',

    sondagem_2:
      'Última retomada. Não insista no que já foi dito e não pressione. ' +
      'Reconheça que ela pode estar sem tempo ou ter mudado de ideia — e diga que tudo bem. ' +
      'Deixe a porta aberta de forma concreta: se quiser experimentar outro horário ou ' +
      'outra modalidade, é só falar. Curto. Se ela não responder, você não escreve de novo.',
  };

  const chave = tipo === 'ae_pos_aula'
    ? (presenca === 'presente' ? 'ae_pos_aula_presente'
      : presenca === 'falta' ? 'ae_pos_aula_falta'
      : presenca === 'falta_justificada' ? 'ae_pos_aula_falta'
      : 'ae_pos_aula_desconhecida')
    : tipo;

  return cabeca + (roteiros[chave] || roteiros.sondagem_1);
}

/**
 * Resumo para o consultor, com sugestão do que fazer.
 *
 * Não abre handoff nem pausa a Leia de propósito: o lead segue em conversa
 * automática, e o consultor entra se quiser. Um handoff aqui encheria a
 * fila de casos que ainda não pedem gente.
 */
async function sugerirAoConsultor(lead, { presenca, conversa }) {
  const dica = presenca === 'presente'
    ? 'A pessoa compareceu (confirmado: a sessão foi fechada à mão antes das 22h) — ' +
      'é o melhor momento para entrar com proposta fechada.'
    : presenca === 'falta' || presenca === 'falta_justificada'
      ? 'A pessoa faltou, e alguém marcou isso na sessão. ' +
        'Antes de vender, entender o motivo: horário, insegurança ou desistência.'
      : '⚠️ Presença NÃO confirmada — o EVO traz "presente" por padrão, e esta sessão não foi ' +
        'fechada à mão a tempo. Não dá para saber se ela veio: confirme com a recepção ou com o ' +
        'professor antes de abordar.';

  await funil.registrarEvento(lead.id, {
    type: 'sugestao_consultor',
    actor: 'leia',
    summary: `Pós-experimental (${presenca}). ${dica}`,
    payload: { presenca, conversa },
  });

  await supabase
    .from('crm_leads')
    .update({
      next_action_at: followup.dentroDaJanela(new Date(Date.now() + 24 * 60 * 60 * 1000)).toISOString(),
      next_action_note: `Pós-experimental (${presenca}) — ${dica}`,
    })
    .eq('id', lead.id);
}

// ──────────────────────────────────────────────
// Envio
// ──────────────────────────────────────────────

async function enviarUm(item) {
  const lead = item.lead;

  if (!lead) {
    await followup.registrarEnvio(item.id, { erro: 'lead inexistente' });
    return;
  }

  // 1. O mundo mudou desde o agendamento?
  if (ETAPAS_MORTAS.has(lead.stage)) {
    await followup.cancelar(lead.id, [item.tipo], `lead já está em "${lead.stage}"`);
    return;
  }

  if (!lead.phone || String(lead.phone).startsWith('teste')) {
    await followup.registrarEnvio(item.id, { erro: 'lead sem telefone real' });
    return;
  }

  // A conversa precisa existir e não estar com um humano — se o consultor
  // assumiu, quem fala é ele.
  const { data: conversa } = await supabase
    .from('wa_conversations')
    .select('id, status')
    .eq('contact_id', lead.contact_id)
    .in('status', ['active', 'human'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!conversa) {
    await followup.registrarEnvio(item.id, { erro: 'sem conversa aberta' });
    return;
  }

  if (conversa.status === 'human') {
    await followup.cancelar(lead.id, [item.tipo], 'conversa está com o consultor');
    return;
  }

  // 2. O fato que só o EVO sabe — e que ele conta mal.
  let presenca = null;
  let leitura = null;

  if (item.tipo === 'ae_pos_aula') {
    leitura = await evoClient.presencaNaAula({
      idProspect: lead.evo_id_prospect,
      idMember: lead.evo_id_member,
      data: item.contexto?.aula || lead.experimental_at,
    }).catch(() => ({ resultado: 'desconhecida', motivo: 'falha ao consultar o EVO' }));

    presenca = leitura.resultado;
    logger.info(`[followup] Lead ${lead.id}: presença "${presenca}" — ${leitura.motivo}`);

    // Sessão ainda aberta: adiar vale a pena, porque a presença costuma
    // ser fechada ao longo do dia. Mas só até as 22h — depois disso a
    // finalização é automática e deixa de significar presença.
    if (presenca === 'nao_finalizada' && item.tentativas < 3) {
      const novaHora = followup.dentroDaJanela(new Date(Date.now() + 3 * 60 * 60 * 1000));
      await supabase
        .from('crm_followups')
        .update({ scheduled_for: novaHora.toISOString(), tentativas: item.tentativas + 1 })
        .eq('id', item.id);
      logger.info(`[followup] Lead ${lead.id}: sessão ainda aberta, reconsultando às ${novaHora.toISOString()}`);
      return;
    }

    // Esgotou o prazo sem finalização humana: não dá para afirmar nada.
    if (presenca === 'nao_finalizada') presenca = 'desconhecida';
  }

  // 3. Gerar e enviar.
  const resposta = await aiAgent.processMessage({
    message: instrucao(item.tipo, { lead, presenca, contexto: item.contexto }),
    conversationId: conversa.id,
    contactInfo: {
      id: lead.contact_id,
      name: lead.full_name,
      phone: lead.phone,
      is_prospect: !lead.evo_id_member,
      tags: [],
    },
  });

  const texto = resposta?.text?.trim();
  if (!texto) {
    await followup.registrarEnvio(item.id, { presenca, erro: 'agente não gerou texto' });
    return;
  }

  await sendText(lead.phone, texto);

  await saveMessage({
    conversationId: conversa.id,
    contactId: lead.contact_id,
    direction: 'outbound',
    content: texto,
    sentBy: 'bot:followup',
    metadata: { followup: item.tipo, presenca },
    status: 'sent',
  });

  await followup.registrarEnvio(item.id, { mensagem: texto, presenca });
  await followup.registrarNoFunil(
    lead.id, item.tipo,
    `Follow-up "${item.tipo}" enviado${presenca ? ` (presença: ${presenca})` : ''}`,
    { texto: texto.slice(0, 400), leitura }
  );
  await funil.tocarAtividade(lead.id);

  logger.info(`[followup] Lead ${lead.id}: ${item.tipo} enviado`);

  // 4. O que vem depois.
  if (item.tipo === 'ae_pos_aula') {
    await sugerirAoConsultor(lead, { presenca, conversa: conversa.id });

    const proxima = await followup.proximaSondagem(lead);
    if (proxima) await followup.agendar(lead.id, proxima.tipo, proxima.quando, item.contexto);
  } else if (item.tipo.startsWith('sondagem')) {
    const proxima = await followup.proximaSondagem(lead);
    if (proxima) await followup.agendar(lead.id, proxima.tipo, proxima.quando, item.contexto);
  }
}

/**
 * Encerra leads que não responderam depois das duas rodadas.
 *
 * "Perdido" explícito vale mais para o funil do que um lead eternamente
 * "em conversa" que ninguém vai atender — e é o que faz a taxa de
 * conversão significar alguma coisa.
 */
async function encerrarSemResposta() {
  const limite = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabase
    .from('crm_followups')
    .select('lead_id, sent_at, lead:crm_leads ( id, stage, last_activity_at )')
    .eq('tipo', 'sondagem_2')
    .eq('status', 'enviado')
    .lte('sent_at', limite)
    .limit(50);

  for (const f of data || []) {
    const lead = f.lead;
    if (!lead || ETAPAS_MORTAS.has(lead.stage)) continue;

    // Respondeu depois da sondagem? Então não está perdido.
    if (lead.last_activity_at && new Date(lead.last_activity_at) > new Date(f.sent_at)) continue;

    await funil.mudarEtapa(lead.id, 'perdido', {
      actor: 'sistema',
      motivo: 'Sem resposta após duas rodadas de follow-up',
      campos: { lost_reason: 'Sem resposta após duas rodadas de follow-up' },
    });
    logger.info(`[followup] Lead ${lead.id} marcado como perdido (sem resposta)`);
  }
}

async function ciclo() {
  if (rodando) return;
  rodando = true;

  try {
    const fila = await followup.vencidos(20);
    for (const item of fila) {
      try {
        await enviarUm(item);
      } catch (err) {
        logger.error(`[followup] Falha no follow-up ${item.id}:`, err.message);
        await followup.registrarTentativa(item.id, item.tentativas || 0, err.message);
      }
    }
    await encerrarSemResposta();
  } catch (err) {
    logger.error('[followup] Ciclo falhou:', err.message);
  } finally {
    rodando = false;
  }
}

export async function startFollowupWorker() {
  const minutos = config.followup.minutos;

  if (!config.crm.habilitado || minutos <= 0) {
    logger.info('[followup] Worker desligado (FOLLOWUP_MINUTOS=0 ou CRM desabilitado)');
    return;
  }

  const { error } = await supabase.from('crm_followups').select('id').limit(1);
  if (error) {
    logger.warn('[followup] Não iniciado: crm_followups ainda não responde. ' +
      'Rode a migration 003 e reinicie o serviço.');
    return;
  }

  logger.info(`[followup] Worker iniciado (ciclo a cada ${minutos} min)`);
  setTimeout(ciclo, 90_000);
  setInterval(ciclo, minutos * 60_000);
}
