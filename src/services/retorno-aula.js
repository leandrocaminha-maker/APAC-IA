/**
 * src/services/retorno-aula.js
 * O retorno da coordenação sobre a aula experimental: lê a mensagem, grava
 * no atendimento e avisa o consultor responsável.
 *
 * As decisões estão em `retorno-aula-regras.js`; aqui se chama o modelo, o
 * banco e o WhatsApp.
 *
 * ## O caminho
 *
 *  1. A coordenação (ou o gerente) escreve ao número da academia — em geral
 *     respondendo a um aviso de aula da Leia, mas pode ser do nada. Texto ou
 *     áudio: o áudio chega aqui já transcrito.
 *  2. O modelo diz de quais aulas recentes a mensagem fala e o que informa
 *     de cada uma (presença, satisfação, temperatura). Sem saber de qual aula
 *     é, a Leia pergunta em vez de chutar.
 *  3. O que ela disse é gravado como fato: a presença vale mais que a chamada
 *     do EVO (`registrarPresencaVista` não a desfaz), e a conversa pós-aula
 *     lê daqui (`followup-worker.js`).
 *  4. O consultor dono do atendimento recebe no WhatsApp a temperatura e o
 *     empurrão para fechar; sem dono, ou sem número cadastrado, vai ao
 *     gerente. A próxima ação do lead no painel leva o mesmo recado.
 *
 * O aviso ao consultor só sai na janela de contato (segunda a sexta até
 * 20h30, sábado até 13h). Fora dela fica `pendente` no próprio retorno, e o
 * worker da gerência manda na abertura — nada em memória, restart não perde.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { aiUsage } from './ai-usage.js';
import { gerencia, SENT_BY_GERENCIA } from './gerencia.js';
import { idadeNaData, quandoSP, telefoneDaEquipe } from './gerencia-regras.js';
import { mudarEtapa, registrarEvento } from './funil.js';
import { estaNaJanela } from './followup.js';
import {
  INSTRUCOES_DO_MODELO, PAPEIS_QUE_INFORMAM, JANELA_RETORNO_DIAS,
  podeSerRetorno, aulasCandidatas, montarPedido, lerResposta, mesclarRetorno, retornoDaAula,
  resumoDoRetorno, textoParaConsultor, notaParaConsultor, confirmacaoParaCoordenacao,
} from './retorno-aula-regras.js';

// O mesmo modelo do agente (ver `descricao-imagem.js`). São poucas mensagens
// por dia, e errar de aluno aqui manda o consultor atrás da pessoa errada.
const MODEL = 'claude-opus-5-5';
const TIMEOUT_MS = 30_000;

const DIA_MS = 24 * 60 * 60 * 1000;
const ENCERRADAS_SEM_AVISO = new Set(['ganho', 'finalizado']);
const TETO_TENTATIVAS_AVISO = 3;

const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 2 });

const CAMPOS_LEAD = 'id, full_name, phone, stage, trilha, owner_user_id, birth_date, ' +
  'experimental_at, experimental_status, experimental_activity, metadata, next_action_at';

// ──────────────────────────────────────────────
// Leitura
// ──────────────────────────────────────────────

async function nomesDosConsultores() {
  const { data } = await supabase.from('crm_users').select('id, name');
  return new Map((data || []).map(u => [u.id, u.name]));
}

const aulaDoLead = (l, consultores) => ({
  leadId: l.id,
  nome: l.full_name || 'Sem nome',
  telefone: l.phone,
  idade: idadeNaData(l.birth_date, l.experimental_at),
  atividade: l.experimental_activity,
  experimental_at: l.experimental_at,
  experimental_status: l.experimental_status,
  stage: l.stage,
  consultor: consultores.get(l.owner_user_id) || null,
});

/** As aulas dos últimos dias de que a coordenação pode estar falando. */
async function lerCandidatas(agora) {
  const { data, error } = await supabase
    .from('crm_leads')
    .select(CAMPOS_LEAD)
    .gte('experimental_at', new Date(agora.getTime() - JANELA_RETORNO_DIAS * DIA_MS).toISOString())
    .lte('experimental_at', agora.toISOString())
    .limit(200);
  if (error) throw new Error(`aulas recentes: ${error.message}`);

  const consultores = await nomesDosConsultores();
  const aulas = (data || []).filter(l => (l.trilha || 'lead') === 'lead').map(l => aulaDoLead(l, consultores));
  return { candidatas: aulasCandidatas(aulas, agora), consultores };
}

/** A mensagem que a coordenação citou, se for desta conversa. */
async function mensagemCitada(contactId, citada) {
  if (!citada) return null;
  const { data } = await supabase
    .from('wa_messages')
    .select('content, sent_by, direction')
    .eq('evolution_msg_id', citada).eq('contact_id', contactId)
    .limit(1);
  return data?.[0] || null;
}

/** As últimas mensagens desta conversa (12 h), para a resposta a uma pergunta da Leia fazer sentido. */
async function conversaRecente(contactId, { ignorarId = null, agora }) {
  const { data } = await supabase
    .from('wa_messages')
    .select('id, direction, sent_by, content, created_at')
    .eq('contact_id', contactId)
    .gte('created_at', new Date(agora.getTime() - 12 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(7);
  return (data || [])
    .filter(m => m.id !== ignorarId && (m.direction === 'inbound' || m.sent_by === SENT_BY_GERENCIA))
    .reverse()
    .map(m => ({ de: m.direction === 'inbound' ? 'coordenacao' : 'leia', texto: m.content }));
}

// ──────────────────────────────────────────────
// O modelo
// ──────────────────────────────────────────────

/** @returns {Promise<string|null>} o texto da resposta, ou `null` se o modelo não respondeu */
async function interpretar(pedido, { conversationId = null } = {}) {
  if (!config.anthropic.apiKey) return null;
  const inicio = Date.now();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1500,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: INSTRUCOES_DO_MODELO,
      messages: [{ role: 'user', content: pedido }],
    }, { timeout: TIMEOUT_MS });

    aiUsage.registrar({
      usage: response.usage,
      modelo: MODEL,
      conversationId,
      origem: 'retorno_aula',
      iteracao: 0,
      modulos: [],
      stopReason: response.stop_reason,
      duracaoMs: Date.now() - inicio,
    });

    return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || null;
  } catch (err) {
    logger.warn(`[retorno-aula] O modelo não leu a mensagem em ${Date.now() - inicio}ms: ${err.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────
// Gravar
// ──────────────────────────────────────────────

/**
 * Atualiza só o `retorno_aula` do lead, relendo o `metadata` antes: ele é
 * de uso geral, e uma escrita cega apagaria o que outro caminho pôs lá.
 */
async function ajustarRetorno(leadId, ajuste) {
  const { data: lead } = await supabase.from('crm_leads').select('metadata').eq('id', leadId).maybeSingle();
  const atual = lead?.metadata?.retorno_aula;
  if (!atual) return null;
  const retorno = { ...atual, ...ajuste };
  await supabase.from('crm_leads')
    .update({ metadata: { ...(lead.metadata || {}), retorno_aula: retorno } }).eq('id', leadId);
  return retorno;
}

/**
 * Grava o que a coordenação contou de uma aula.
 *
 *  - `veio` → etapa "Experimental realizada" e o evento
 *    `experimental_realizada`, como a presença do EVO.
 *  - `faltou` → `experimental_status = 'faltou'` e o evento
 *    `experimental_falta` — inclusive por cima de uma presença do EVO: quem
 *    estava na aula sabe mais que a chamada. A etapa não volta.
 *  - Havendo novidade, a próxima ação do consultor vira o recado (sem passar
 *    por cima de uma que ele mesmo marcou para o futuro) e o aviso a ele fica
 *    `pendente`.
 *
 * @returns {Promise<{ lead: object, retorno: object, mudou: boolean }|null>}
 */
export async function registrar(leadId, item, { por = null, agora = new Date() } = {}) {
  const { data: lead } = await supabase.from('crm_leads').select('*').eq('id', leadId).maybeSingle();
  if (!lead?.experimental_at) return null;

  const { retorno, mudou } = mesclarRetorno(lead.metadata?.retorno_aula, item, { aula: lead.experimental_at, por, agora });
  const campos = { metadata: { ...(lead.metadata || {}), retorno_aula: retorno } };
  const quando = quandoSP(lead.experimental_at);

  const aberto = !['ganho', 'perdido', 'finalizado'].includes(lead.stage);
  const proxima = Date.parse(lead.next_action_at || '');
  const ocupada = Number.isFinite(proxima) && proxima > agora.getTime();
  if (mudou && aberto && !ocupada) {
    campos.next_action_at = agora.toISOString();
    campos.next_action_note = notaParaConsultor(retorno);
  }

  let atualizado = null;
  if (item.presenca === 'veio' && lead.experimental_status !== 'realizada') {
    atualizado = await mudarEtapa(lead, 'experimental_realizada', {
      actor: 'coordenacao',
      somenteAvanco: true,
      motivo: 'A coordenação confirmou a presença na aula experimental',
      campos: { ...campos, experimental_status: 'realizada' },
    });
    await registrarEvento(lead.id, {
      type: 'experimental_realizada',
      actor: 'coordenacao',
      summary: `Presença na aula de ${quando} confirmada pela coordenação`,
      payload: { aula: lead.experimental_at, por },
    });
  } else {
    const faltou = item.presenca === 'faltou' && lead.experimental_status !== 'faltou';
    const { data, error } = await supabase.from('crm_leads')
      .update({ ...campos, ...(faltou ? { experimental_status: 'faltou' } : {}) })
      .eq('id', lead.id).select().single();
    if (error) throw new Error(`lead ${lead.id}: ${error.message}`);
    atualizado = data;
    if (faltou) {
      await registrarEvento(lead.id, {
        type: 'experimental_falta',
        actor: 'coordenacao',
        summary: `Falta na aula de ${quando} confirmada pela coordenação`,
        payload: { aula: lead.experimental_at, por, presencaAnterior: lead.experimental_status },
      });
    }
  }

  if (mudou) {
    await registrarEvento(lead.id, {
      type: 'retorno_coordenacao',
      actor: 'coordenacao',
      summary: `Retorno da coordenação sobre a aula de ${quando}: ${resumoDoRetorno(retorno)}`,
      payload: { retorno, por },
    });
  }
  logger.info(`[retorno-aula] Lead ${lead.id}: ${resumoDoRetorno(retorno)}${mudou ? '' : ' (sem novidade)'}`);
  return { lead: atualizado || { ...lead, ...campos }, retorno, mudou };
}

// ──────────────────────────────────────────────
// O aviso ao consultor
// ──────────────────────────────────────────────

/**
 * Para quem vai o aviso deste lead: o consultor dono, se tem WhatsApp
 * cadastrado; senão o gerente. Quem acabou de dar o retorno não é avisado
 * do que ele mesmo contou.
 *
 * @returns {{ telefones: string[], consultor: string|null, dono: string|null, destino: string|null }}
 *   `destino`: o nome do consultor, 'gerente', ou `null` (fica só no painel)
 */
function destinoDoAviso(lead, retorno, cfg, consultores) {
  const dono = consultores.get(lead.owner_user_id) || null;
  if (!cfg.avisos.ligado) return { telefones: [], consultor: null, dono, destino: null };

  const doDono = cfg.avisos.consultores[lead.owner_user_id];
  if (doDono && doDono !== retorno.por) return { telefones: [doDono], consultor: dono, dono, destino: dono || 'consultor' };

  const gerentes = cfg.avisos.gerente.filter(t => t !== retorno.por);
  return { telefones: gerentes, consultor: null, dono, destino: gerentes.length ? 'gerente' : null };
}

/**
 * Manda (ou deixa para a abertura da janela) o aviso de um retorno pendente.
 *
 * @returns {Promise<{ destino: string|null, estado: 'enviado'|'adiado'|'painel'|'dispensado'|'falhou'|'sem_pendencia' }>}
 */
async function avisarConsultor(lead, { cfg, consultores, agora = new Date() }) {
  const retorno = retornoDaAula(lead);
  if (!retorno || retorno.aviso_consultor !== 'pendente') return { destino: null, estado: 'sem_pendencia' };

  if (ENCERRADAS_SEM_AVISO.has(lead.stage)) {
    await ajustarRetorno(lead.id, { aviso_consultor: 'dispensado' });
    return { destino: null, estado: 'dispensado' };
  }

  const d = destinoDoAviso(lead, retorno, cfg, consultores);
  if (!d.telefones.length) {
    await ajustarRetorno(lead.id, { aviso_consultor: 'painel' });
    return { destino: null, estado: 'painel' };
  }
  if (!estaNaJanela(agora)) return { destino: d.destino, estado: 'adiado' };

  const texto = textoParaConsultor({
    aula: aulaDoLead(lead, consultores), retorno, consultor: d.consultor, dono: d.dono,
  });
  let saiu = false;
  for (const tel of d.telefones) {
    try {
      await gerencia.enviarParaEquipe(tel, texto);
      saiu = true;
    } catch (err) {
      logger.error(`[retorno-aula] Aviso do lead ${lead.id} para ${tel} falhou: ${err.message}`);
    }
  }

  if (!saiu) {
    const tentativas = (retorno.aviso_tentativas || 0) + 1;
    const desistiu = tentativas >= TETO_TENTATIVAS_AVISO;
    await ajustarRetorno(lead.id, { aviso_tentativas: tentativas, ...(desistiu ? { aviso_consultor: 'falhou' } : {}) });
    return { destino: d.destino, estado: 'falhou' };
  }

  await ajustarRetorno(lead.id, {
    aviso_consultor: 'enviado', avisado_em: agora.toISOString(), avisado_para: d.destino,
  });
  logger.info(`[retorno-aula] Lead ${lead.id}: aviso do retorno enviado a ${d.destino}`);
  return { destino: d.destino, estado: 'enviado' };
}

/**
 * Os avisos que ficaram para depois — retorno dado fora da janela de
 * contato, ou envio que falhou. Chamado pelo worker da gerência.
 */
export async function avisarConsultoresPendentes({ agora = new Date() } = {}) {
  if (!estaNaJanela(agora)) return { enviados: 0 };

  const { data, error } = await supabase
    .from('crm_leads')
    .select(CAMPOS_LEAD)
    .eq('metadata->retorno_aula->>aviso_consultor', 'pendente')
    .gte('experimental_at', new Date(agora.getTime() - (JANELA_RETORNO_DIAS + 3) * DIA_MS).toISOString())
    .limit(20);
  if (error) throw new Error(`retornos pendentes: ${error.message}`);
  if (!data?.length) return { enviados: 0 };

  const [cfg, consultores] = await Promise.all([gerencia.carregarConfig({ fresca: true }), nomesDosConsultores()]);
  let enviados = 0;
  for (const lead of data) {
    const r = await avisarConsultor(lead, { cfg, consultores, agora });
    if (r.estado === 'enviado') enviados++;
  }
  return { enviados };
}

// ──────────────────────────────────────────────
// A porta no webhook
// ──────────────────────────────────────────────

/**
 * A mensagem da coordenação é um retorno de aula? Se for, registra, avisa o
 * consultor e responde a ela com o que foi anotado.
 *
 * Devolve `false` para tudo o que não é daqui — o webhook segue para a
 * porta da equipe do acompanhamento e para o registro de sempre.
 *
 * @param {object} p
 * @param {string} p.phone
 * @param {object} p.contact
 * @param {object} p.conversation
 * @param {string} p.content       o texto (o áudio já transcrito)
 * @param {string|null} p.citada   id da mensagem citada
 * @param {number|null} p.mensagemId  id da mensagem recém-gravada
 * @param {(texto: string) => Promise<void>} p.responder
 * @returns {Promise<boolean>}
 */
export async function tratarMensagemDaEquipe({
  phone, contact, conversation, content, citada = null, mensagemId = null, responder, agora = new Date(),
}) {
  const papel = await gerencia.papelDoNumero(phone);
  if (!PAPEIS_QUE_INFORMAM.includes(papel)) return false;
  if (!podeSerRetorno(content)) return false;

  // Citando o que não é aviso da gerência (o briefing do acompanhamento, um
  // repasse da ponte), a mensagem é de lá.
  const origem = await mensagemCitada(contact.id, citada);
  if (origem && origem.sent_by !== SENT_BY_GERENCIA) return false;

  const { candidatas, consultores } = await lerCandidatas(agora);
  if (!candidatas.length) return false;

  const conversa = await conversaRecente(contact.id, { ignorarId: mensagemId, agora });
  const pedido = montarPedido({ candidatas, conversa, citada: origem?.content || null, mensagem: content });
  const saida = await interpretar(pedido, { conversationId: conversation?.id ?? null });

  if (!saida) {
    // Sem o modelo não se sabe se era retorno. Respondendo a um aviso da
    // Leia, quase certamente era: a coordenação precisa saber que não ficou.
    if (origem) {
      await responder('⚠️ Não consegui registrar agora. Pode mandar de novo daqui a alguns minutos?');
      return true;
    }
    return false;
  }

  const lido = lerResposta(saida, candidatas);
  if (!lido.ehRetorno) return false;

  if (lido.duvida) {
    await responder(lido.duvida);
    logger.info(`[retorno-aula] ${phone} (${papel}): retorno sem aula identificada — a Leia perguntou`);
    return true;
  }

  const cfg = await gerencia.carregarConfig();
  const telefoneDeQuem = telefoneDaEquipe(phone) || phone;
  const registrados = [];
  for (const item of lido.itens) {
    try {
      const r = await registrar(item.leadId, item, { por: telefoneDeQuem, agora });
      if (!r) continue;
      const aviso = await avisarConsultor(r.lead, { cfg, consultores, agora });
      const retorno = retornoDaAula(r.lead) || r.retorno;
      registrados.push({
        aula: aulaDoLead(r.lead, consultores),
        retorno,
        // Sem novidade o aviso já tinha saído: a confirmação diz para quem.
        destino: aviso.estado === 'sem_pendencia' ? (retorno.avisado_para || null) : aviso.destino,
      });
    } catch (err) {
      logger.error(`[retorno-aula] Lead ${item.leadId}: retorno não gravado: ${err.message}`);
    }
  }

  if (!registrados.length) {
    await responder('⚠️ Entendi o retorno, mas não consegui gravar. Pode mandar de novo daqui a alguns minutos?');
    return true;
  }

  await responder(confirmacaoParaCoordenacao(registrados));
  logger.info(`[retorno-aula] ${phone} (${papel}): ${registrados.length} retorno(s) de aula registrado(s)`);
  return true;
}

export const retornoAula = { tratarMensagemDaEquipe, registrar, avisarConsultoresPendentes };
