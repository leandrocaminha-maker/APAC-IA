/**
 * src/services/evo-sync.js
 * A ponte entre o funil (nosso banco) e o EVO (sistema da academia).
 *
 * Tudo o que ESCREVE no EVO passa por aqui, e cada escrita deixa três
 * marcas: o campo correspondente em `crm_leads`, uma linha em
 * `crm_lead_events` com o autor, e o retorno cru do EVO no payload do
 * evento. A terceira parece exagero até o dia em que o EVO muda o formato
 * da resposta e é preciso descobrir o que ele devolvia antes.
 *
 * ⚠️ Estas funções escrevem em PRODUÇÃO. Não há filial de testes na conta.
 * Para ensaiar o fluxo sem sujar nada, ligue EVO_DRY_RUN=true no .env:
 * o client devolve { dryRun: true } e nada sai para o EVO, mas o funil
 * anda igual.
 */
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { evoClient, EvoApiError } from './evo-client.js';
import {
  registrarEvento, mudarEtapa, leadPorProspect, leadPorMembro,
} from './funil.js';

/** Autor de uma ação, no formato que crm_lead_events espera. */
function autor(usuario) {
  return {
    actor: usuario ? `user:${usuario.id}` : 'sistema',
    actorUserId: usuario?.id || null,
  };
}

/** Marca o resultado da sincronização na linha do lead. */
async function marcarSync(leadId, campos) {
  const { data } = await supabase
    .from('crm_leads')
    .update(campos)
    .eq('id', leadId)
    .select()
    .single();
  return data;
}

// ──────────────────────────────────────────────
// 1. Cadastro de prospect
// ──────────────────────────────────────────────

/**
 * Cadastra o lead como prospect no EVO.
 *
 * Idempotente por dois caminhos: se o lead já tem `evo_id_prospect`,
 * devolve o que existe; se não tem, procura pelo celular antes de criar.
 * O segundo caminho importa porque o cliente pode já estar cadastrado de
 * uma visita anterior, e prospect duplicado no EVO estraga o relatório de
 * origem e confunde o consultor.
 *
 * @returns {Promise<{idProspect:number, criado:boolean, dryRun?:boolean}>}
 */
export async function cadastrarProspect(lead, { usuario = null, dados = {} } = {}) {
  // Vínculo de ensaio (id negativo, ver mais abaixo) não vale como cadastro
  // quando o dry-run é desligado: aí o prospect precisa ser criado de
  // verdade, e o id falso é substituído pelo real.
  const vinculoDeEnsaio = lead.evo_id_prospect != null && lead.evo_id_prospect < 0;

  if (lead.evo_id_prospect && !(vinculoDeEnsaio && !config.evo.dryRun)) {
    return { idProspect: lead.evo_id_prospect, criado: false, lead };
  }

  const nomeCompleto = dados.nomeCompleto || lead.full_name;
  const telefone = dados.telefone || lead.phone;

  if (!nomeCompleto || !String(nomeCompleto).trim().includes(' ')) {
    throw new Error('O EVO precisa de nome e sobrenome para abrir a oportunidade.');
  }
  if (!telefone) {
    throw new Error('Sem telefone não dá para cadastrar o prospect no EVO.');
  }

  // Já existe lá? Vincula em vez de duplicar.
  let existente = null;
  try {
    existente = await evoClient.buscarProspectPorTelefone(telefone);
  } catch (err) {
    logger.warn(`[evo-sync] Busca por telefone falhou, seguindo para o cadastro: ${err.message}`);
  }

  if (existente?.idProspect) {
    const atualizado = await marcarSync(lead.id, {
      evo_id_prospect: existente.idProspect,
      evo_id_member: existente.idMember || null,
      evo_sync: 'sincronizado',
      evo_sync_error: null,
      evo_synced_at: new Date().toISOString(),
    });
    await registrarEvento(lead.id, {
      type: 'evo_prospect_vinculado',
      ...autor(usuario),
      summary: `Prospect ${existente.idProspect} já existia no EVO e foi vinculado`,
      payload: { idProspect: existente.idProspect },
    });
    return { idProspect: existente.idProspect, criado: false, lead: atualizado || lead };
  }

  try {
    const { idProspect, dryRun, raw } = await evoClient.criarProspect({
      nomeCompleto,
      telefone,
      email: dados.email || lead.email,
      dataNascimento: dados.dataNascimento || lead.birth_date,
      genero: dados.genero,
      observacoes: dados.observacoes
        || `Lead do WhatsApp (Leia). Interesse: ${lead.interest || 'não informado'}.`,
      interesses: dados.interesses || lead.evo_interests || [],
    });

    // Em ensaio o EVO não devolve id nenhum. Guardar `null` faria o lead
    // continuar "não cadastrado", e cada ação seguinte do consultor
    // tentaria criar o prospect de novo — o ensaio encheria o razão de
    // cadastros repetidos e o agendamento sairia sem `idProspect`, que é
    // justamente o campo que se queria conferir.
    //
    // Então o ensaio guarda um id NEGATIVO, derivado do próprio lead. Os
    // ids do EVO são positivos, então um negativo nunca se confunde com
    // um real, e `cadastrarProspect` o trata como ausente assim que o
    // dry-run é desligado.
    const idGuardado = dryRun ? -lead.id : idProspect;

    const atualizado = await marcarSync(lead.id, {
      evo_id_prospect: idGuardado,
      evo_sync: dryRun ? 'pendente' : 'sincronizado',
      evo_sync_error: null,
      evo_synced_at: dryRun ? null : new Date().toISOString(),
      full_name: nomeCompleto,
      phone: lead.phone || telefone,
      email: dados.email || lead.email || null,
      birth_date: dados.dataNascimento || lead.birth_date || null,
    });

    await registrarEvento(lead.id, {
      type: 'evo_prospect_criado',
      ...autor(usuario),
      summary: dryRun
        ? `DRY-RUN: cadastro de prospect simulado (id de ensaio ${idGuardado}, nada foi enviado ao EVO)`
        : `Prospect ${idProspect} criado no EVO`,
      payload: { idProspect: idGuardado, dryRun: !!dryRun, raw },
    });

    logger.info(`[evo-sync] Lead ${lead.id} → prospect ${idGuardado}${dryRun ? ' (dry-run)' : ''}`);
    return { idProspect: idGuardado, criado: true, dryRun, lead: atualizado || lead };
  } catch (err) {
    await marcarSync(lead.id, { evo_sync: 'erro', evo_sync_error: err.message.slice(0, 500) });
    await registrarEvento(lead.id, {
      type: 'evo_erro',
      ...autor(usuario),
      summary: `Falha ao cadastrar no EVO: ${err.message.slice(0, 200)}`,
      payload: { status: err instanceof EvoApiError ? err.status : null },
    });
    throw err;
  }
}

// ──────────────────────────────────────────────
// 2. Aula experimental
// ──────────────────────────────────────────────

/**
 * O serviço que autoriza a aula experimental, com cache.
 *
 * É procurado pela flag `experimentalClass`, não pelo id fixo: alguém
 * recriar o serviço no EVO mudaria o número, e o agendamento passaria a
 * falhar por um motivo que ninguém ligaria ao id.
 */
let cacheServicoExperimental = { valor: null, em: 0 };
const CACHE_SERVICO_MS = 30 * 60 * 1000;

async function servicoExperimental() {
  if (cacheServicoExperimental.valor && Date.now() - cacheServicoExperimental.em < CACHE_SERVICO_MS) {
    return cacheServicoExperimental.valor;
  }
  const servico = await evoClient.buscarServicoExperimental();
  if (servico) cacheServicoExperimental = { valor: servico, em: Date.now() };
  return servico;
}

/**
 * Agenda a aula experimental no EVO e move o lead de etapa.
 *
 * Cadastra o prospect antes se ainda não existir: o endpoint do EVO exige
 * `idProspect`, e pedir ao consultor que faça duas ações em sequência para
 * um passo só é o tipo de atrito que faz o painel ser abandonado.
 *
 * @param {object} dados
 * @param {string} dados.dataHora  - 'YYYY-MM-DD HH:mm'
 * @param {string} [dados.atividade]
 * @param {string} [dados.servico]
 */
export async function agendarExperimental(lead, dados, { usuario = null } = {}) {
  if (!dados?.dataHora) throw new Error('Informe a data e a hora da aula experimental.');

  const { idProspect, lead: leadAtual } = await cadastrarProspect(lead, { usuario });
  const base = leadAtual || lead;

  // O endpoint do EVO exige um serviço que autorize a experimental. Em vez
  // de pedir isso ao consultor — que não tem por que saber id de serviço —
  // achamos sozinhos o que está marcado com `experimentalClass: true`
  // (hoje "AULA EXPERIMENTAL", R$ 0). Se o EVO não tiver nenhum, seguimos
  // sem: o erro que ele devolver é mais informativo do que um nosso.
  let idService = dados.idService;
  if (!idService && !dados.servico) {
    try {
      const servico = await servicoExperimental();
      if (servico) idService = servico.idService;
    } catch (err) {
      logger.warn(`[evo-sync] Não consegui achar o serviço de experimental: ${err.message}`);
    }
  }

  try {
    const raw = await evoClient.agendarAulaExperimental({
      idProspect,
      dataHora: dados.dataHora,
      atividade: dados.atividade,
      servico: dados.servico,
      idActivity: dados.idActivity,
      idService,
      atividadeExiste: dados.atividadeExiste,
    });

    const dryRun = raw?.dryRun === true;
    const quando = new Date(String(dados.dataHora).replace(' ', 'T')).toISOString();

    const atualizado = await mudarEtapa(base, 'experimental_agendada', {
      ...autor(usuario),
      motivo: `Experimental de ${dados.atividade || 'atividade'} em ${dados.dataHora}`,
      campos: {
        experimental_at: quando,
        experimental_status: 'agendada',
        experimental_activity: dados.atividade || null,
      },
      payload: { raw, dryRun },
    });

    await registrarEvento(base.id, {
      type: 'experimental_agendada',
      ...autor(usuario),
      summary: dryRun
        ? `DRY-RUN: experimental simulada para ${dados.dataHora}`
        : `Aula experimental marcada para ${dados.dataHora}`,
      payload: { idProspect, dados, raw, dryRun },
    });

    logger.info(`[evo-sync] Lead ${base.id}: experimental em ${dados.dataHora}${dryRun ? ' (dry-run)' : ''}`);
    return { ok: true, dryRun, lead: atualizado, raw };
  } catch (err) {
    await registrarEvento(base.id, {
      type: 'evo_erro',
      ...autor(usuario),
      summary: `Falha ao agendar experimental: ${err.message.slice(0, 200)}`,
      payload: { dados },
    });
    throw err;
  }
}

// ──────────────────────────────────────────────
// 3. Venda
// ──────────────────────────────────────────────

/**
 * Registra a venda no EVO e fecha o lead como ganho.
 *
 * Ordem importante: o EVO primeiro, o funil depois. Se invertesse, uma
 * falha na API deixaria o lead marcado como ganho sem venda nenhuma —
 * e o erro só apareceria no fechamento do mês.
 */
export async function registrarVenda(lead, dados, { usuario = null } = {}) {
  if (!dados?.idMembership && !dados?.idService) {
    throw new Error('Escolha um plano (idMembership) ou um serviço (idService) para a venda.');
  }

  let idProspect = lead.evo_id_prospect;
  let base = lead;

  // Venda para quem ainda é oportunidade precisa do prospect no EVO.
  if (!lead.evo_id_member) {
    const r = await cadastrarProspect(lead, { usuario });
    idProspect = r.idProspect;
    base = r.lead || lead;
  }

  try {
    const { idSale, dryRun, raw } = await evoClient.criarVenda({
      idProspect: lead.evo_id_member ? undefined : idProspect,
      idMember: lead.evo_id_member || undefined,
      idMembership: dados.idMembership,
      idService: dados.idService,
      valor: dados.valor,
      formaPagamento: dados.formaPagamento,
      parcelas: dados.parcelas,
      voucher: dados.voucher,
      inicioPlano: dados.inicioPlano,
    });

    const atualizado = await mudarEtapa(base, 'ganho', {
      ...autor(usuario),
      motivo: `Venda registrada${dados.valor ? ` — R$ ${Number(dados.valor).toFixed(2)}` : ''}`,
      campos: {
        sale_at: new Date().toISOString(),
        sale_value: dados.valor ?? null,
        evo_id_sale: idSale,
      },
      payload: { idSale, dryRun },
    });

    await registrarEvento(base.id, {
      type: 'venda',
      ...autor(usuario),
      summary: dryRun
        ? 'DRY-RUN: venda simulada (nada foi enviado ao EVO)'
        : `Venda ${idSale ?? ''} registrada no EVO`,
      payload: { idSale, dados, raw, dryRun },
    });

    logger.info(`[evo-sync] Lead ${base.id}: venda ${idSale}${dryRun ? ' (dry-run)' : ''}`);
    return { ok: true, idSale, dryRun, lead: atualizado, raw };
  } catch (err) {
    await registrarEvento(base.id, {
      type: 'evo_erro',
      ...autor(usuario),
      summary: `Falha ao registrar venda: ${err.message.slice(0, 200)}`,
      payload: { dados },
    });
    throw err;
  }
}

// ──────────────────────────────────────────────
// 4. Follow-up no EVO
// ──────────────────────────────────────────────

/**
 * Lança um follow-up na ficha do EVO.
 *
 * Isto é recado INTERNO: aparece para o consultor dentro do EVO, não vai
 * para o cliente. Mensagem para o cliente é outra coisa e sai pela fila do
 * WhatsApp (wa_message_queue).
 */
export async function lancarFollowUp(lead, mensagem, { usuario = null, proximaAcao = null } = {}) {
  if (!mensagem?.trim()) throw new Error('Escreva o texto do follow-up.');

  let alvo = { tipo: null, id: null };
  if (lead.evo_id_member) alvo = { tipo: 'membro', id: lead.evo_id_member };
  else if (lead.evo_id_prospect) alvo = { tipo: 'prospect', id: lead.evo_id_prospect };
  else {
    const r = await cadastrarProspect(lead, { usuario });
    alvo = { tipo: 'prospect', id: r.idProspect };
  }

  const raw = alvo.tipo === 'membro'
    ? await evoClient.lancarFollowUpMembro(alvo.id, mensagem)
    : await evoClient.lancarFollowUpProspect(alvo.id, mensagem);

  const campos = { last_activity_at: new Date().toISOString() };
  if (proximaAcao) {
    campos.next_action_at = proximaAcao.quando || null;
    campos.next_action_note = proximaAcao.nota || mensagem.slice(0, 200);
  }
  await supabase.from('crm_leads').update(campos).eq('id', lead.id);

  await registrarEvento(lead.id, {
    type: 'followup',
    ...autor(usuario),
    summary: raw?.dryRun
      ? `DRY-RUN: follow-up simulado — ${mensagem.slice(0, 120)}`
      : `Follow-up lançado no EVO (${alvo.tipo} ${alvo.id})`,
    payload: { mensagem, alvo, proximaAcao, raw },
  });

  return { ok: true, alvo, dryRun: raw?.dryRun === true };
}

// ──────────────────────────────────────────────
// 5. Webhooks do EVO
// ──────────────────────────────────────────────

/**
 * Guarda o envelope recebido. Retorna null se for reentrega já conhecida.
 *
 * O EVO reenvia em caso de timeout, e a UNIQUE parcial
 * (event_type, id_record, id_branch) transforma isso em no-op em vez de
 * um segundo evento processado.
 */
export async function guardarEventoWebhook(envelope) {
  const linha = {
    event_type: envelope.EventType || envelope.eventType || 'desconhecido',
    id_w12: envelope.IdW12 ?? envelope.idW12 ?? null,
    id_branch: envelope.IdBranch ?? envelope.idBranch ?? null,
    id_record: envelope.IdRecord ?? envelope.idRecord ?? null,
    api_callback: envelope.ApiCallback ?? envelope.apiCallback ?? null,
    payload: envelope,
  };

  const { data, error } = await supabase
    .from('crm_evo_webhook_events')
    .insert(linha)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      logger.debug(`[evo-sync] Webhook ${linha.event_type}/${linha.id_record} já recebido — ignorado`);
      return null;
    }
    logger.error('[evo-sync] Falha ao guardar webhook:', error.message);
    return null;
  }
  return data;
}

/**
 * Interpreta um evento já guardado e move o funil.
 *
 * Cobertura honesta do que dá para saber por webhook:
 *   NewSale / RecurrentSale → alguém comprou. Fecha o lead como ganho.
 *   CreateMember            → prospect virou aluno. Vincula o idMember.
 *   CreateMembership        → contrato criado. Fecha como ganho.
 *   ActivityEnroll          → matrícula em aula, que é como a experimental
 *                             agendada pelo consultor aparece.
 *
 * ⚠️ O que NÃO dá: mudança de etapa/status do prospect. O EVO não emite
 * evento para isso — quem cobre é o poller em `sincronizarProspects`.
 */
export async function processarEventoWebhook(evento) {
  const tipo = evento.event_type;
  let lead = null;
  let detalhe = null;

  try {
    // O envelope traz só ids. O dado real está atrás do ApiCallback.
    if (evento.api_callback) {
      detalhe = await buscarDetalhe(evento).catch(err => {
        logger.warn(`[evo-sync] ApiCallback de ${tipo} falhou: ${err.message}`);
        return null;
      });
    }

    switch (tipo) {
      case 'NewSale':
      case 'RecurrentSale':
      case 'CreateMembership': {
        const idMember = detalhe?.idMember ?? detalhe?.IdMember ?? null;
        lead = idMember ? await leadPorMembro(idMember) : null;
        if (!lead && detalhe?.idProspect) lead = await leadPorProspect(detalhe.idProspect);
        if (lead && lead.stage !== 'ganho') {
          const valor = detalhe?.saleValue ?? detalhe?.value ?? null;
          await mudarEtapa(lead, 'ganho', {
            actor: 'evo-webhook',
            motivo: `${tipo} recebido do EVO`,
            campos: {
              sale_at: new Date().toISOString(),
              sale_value: valor,
              evo_id_sale: evento.id_record,
              evo_id_member: idMember || lead.evo_id_member,
            },
            payload: { tipo, detalhe },
          });
        }
        break;
      }

      case 'CreateMember': {
        const idMember = evento.id_record;
        const doc = detalhe?.document || detalhe?.cellphone;
        lead = await leadPorMembro(idMember);
        if (!lead && detalhe?.idProspect) lead = await leadPorProspect(detalhe.idProspect);
        if (lead) {
          await supabase
            .from('crm_leads')
            .update({ evo_id_member: idMember, evo_sync: 'sincronizado' })
            .eq('id', lead.id);
          await registrarEvento(lead.id, {
            type: 'evo_convertido',
            actor: 'evo-webhook',
            summary: `Oportunidade virou aluno no EVO (membro ${idMember})`,
            payload: { idMember, doc },
          });
        }
        break;
      }

      case 'ActivityEnroll': {
        const idProspect = detalhe?.idProspect ?? null;
        const idMember = detalhe?.idMember ?? null;
        lead = idProspect ? await leadPorProspect(idProspect)
             : idMember ? await leadPorMembro(idMember) : null;
        if (lead) {
          const quando = detalhe?.activityDate || detalhe?.date || null;
          await mudarEtapa(lead, 'experimental_agendada', {
            actor: 'evo-webhook',
            somenteAvanco: true,
            motivo: 'Matrícula em aula registrada no EVO',
            campos: quando ? { experimental_at: quando, experimental_status: 'agendada' } : {},
            payload: { detalhe },
          });
        }
        break;
      }

      default:
        logger.debug(`[evo-sync] Evento ${tipo} guardado sem regra de funil`);
    }

    await supabase
      .from('crm_evo_webhook_events')
      .update({
        processed_at: new Date().toISOString(),
        detail: detalhe,
        lead_id: lead?.id || null,
        error: null,
      })
      .eq('id', evento.id);

    return { ok: true, leadId: lead?.id || null };
  } catch (err) {
    logger.error(`[evo-sync] Falha ao processar webhook ${evento.id} (${tipo}):`, err.message);
    await supabase
      .from('crm_evo_webhook_events')
      .update({ error: err.message.slice(0, 500), attempts: (evento.attempts || 0) + 1 })
      .eq('id', evento.id);
    return { ok: false, erro: err.message };
  }
}

/**
 * Busca o detalhe apontado pelo ApiCallback.
 *
 * O EVO manda a URL completa da própria API dele. Confirmamos que é mesmo
 * o host do EVO antes de chamar: seguir URL arbitrária vinda de um webhook
 * é SSRF, e este processo alcança a rede interna do Docker.
 */
async function buscarDetalhe(evento) {
  const url = new URL(evento.api_callback);
  const permitido = new URL(config.evo.baseUrl).host;

  if (url.host !== permitido) {
    throw new Error(`ApiCallback aponta para host inesperado (${url.host}) — ignorado`);
  }

  const auth = 'Basic ' + Buffer.from(`${config.evo.dns}:${config.evo.token}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`ApiCallback devolveu ${res.status}`);

  const dado = await res.json();
  return Array.isArray(dado) ? (dado[0] ?? null) : dado;
}

/** Reprocessa os webhooks que ficaram pendentes ou com erro. */
export async function reprocessarPendentes(limite = 50) {
  const { data } = await supabase
    .from('crm_evo_webhook_events')
    .select('*')
    .is('processed_at', null)
    .lt('attempts', 5)
    .order('created_at', { ascending: true })
    .limit(limite);

  let ok = 0, falhas = 0;
  for (const evento of data || []) {
    const r = await processarEventoWebhook(evento);
    r.ok ? ok++ : falhas++;
  }
  return { processados: ok, falhas, total: (data || []).length };
}

// ──────────────────────────────────────────────
// 6. Poller — o que o webhook não conta
// ──────────────────────────────────────────────

/**
 * Varre os prospects do EVO e reconcilia com o funil.
 *
 * Existe porque o EVO **não emite evento de mudança de prospect**. Sem
 * isto, o que o consultor faz dentro do EVO (converter, marcar aula na
 * recepção, mudar dado) é invisível para o painel.
 *
 * Não cria lead para prospect que nunca passou pelo WhatsApp — o funil é
 * do que a Leia e o painel tocam, não uma cópia da base inteira do EVO.
 */
export async function sincronizarProspects({ dias = 7 } = {}) {
  const inicio = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const resumo = { lidos: 0, atualizados: 0, convertidos: 0, erros: 0 };

  try {
    // Só olhamos leads que já têm vínculo com o EVO: são os únicos que
    // podem ter mudado lá e importar aqui.
    const { data: leads } = await supabase
      .from('crm_leads')
      .select('id, evo_id_prospect, evo_id_member, stage, full_name')
      .not('evo_id_prospect', 'is', null)
      .not('stage', 'in', '(ganho,perdido)')
      .limit(500);

    for (const lead of leads || []) {
      try {
        const p = await evoClient.buscarProspectPorId(lead.evo_id_prospect);
        resumo.lidos++;
        if (!p) continue;

        const virouMembro = p.idMember && !lead.evo_id_member;

        if (virouMembro) {
          await mudarEtapa(lead, 'ganho', {
            actor: 'evo-poll',
            motivo: 'Oportunidade convertida em aluno dentro do EVO',
            campos: {
              evo_id_member: p.idMember,
              evo_sync: 'sincronizado',
              sale_at: p.conversionDate || new Date().toISOString(),
            },
            payload: { idMember: p.idMember, conversionDate: p.conversionDate },
          });
          resumo.convertidos++;
          continue;
        }

        // currentStep/temperature: hoje vêm vazios em toda a base, mas se
        // a academia começar a preencher, o painel passa a mostrar sem
        // precisar de código novo.
        if (p.currentStep || p.temperature) {
          await supabase
            .from('crm_leads')
            .update({
              metadata: { evo_current_step: p.currentStep, evo_temperature: p.temperature },
              evo_sync: 'sincronizado',
            })
            .eq('id', lead.id);
          resumo.atualizados++;
        }
      } catch (err) {
        resumo.erros++;
        logger.warn(`[evo-sync] Poll do lead ${lead.id} falhou: ${err.message}`);
      }
    }

    await supabase.from('crm_evo_poll_state').upsert({
      resource: 'prospects',
      last_run_at: new Date().toISOString(),
      last_cursor: inicio,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('[evo-sync] Poll de prospects falhou:', err.message);
    await supabase.from('crm_evo_poll_state').upsert({
      resource: 'prospects',
      last_run_at: new Date().toISOString(),
      last_error: err.message.slice(0, 500),
      updated_at: new Date().toISOString(),
    });
  }

  logger.info(`[evo-sync] Poll de prospects: ${JSON.stringify(resumo)}`);
  return resumo;
}

// ──────────────────────────────────────────────
// 7. Registro dos webhooks na conta do EVO
// ──────────────────────────────────────────────

/**
 * Garante que os eventos que o funil usa estão assinados no EVO,
 * apontando para este serviço. Idempotente: não recadastra o que já existe.
 */
export async function registrarWebhooks({ urlBase = config.crm.urlPublica } = {}) {
  const url = `${urlBase.replace(/\/$/, '')}/webhook/evo`;
  const headers = config.crm.evoWebhookSecret
    ? [{ nome: 'X-Evo-Secret', valor: config.crm.evoWebhookSecret }]
    : [];

  if (!headers.length) {
    throw new Error('Defina EVO_WEBHOOK_SECRET antes de registrar os webhooks — sem ele o endpoint fica fechado.');
  }

  const existentes = await evoClient.listarWebhooks();
  const jaTem = new Set(
    existentes
      .filter(w => (w.urlCallback || w.UrlCallback) === url)
      .map(w => w.eventType || w.EventType)
  );

  const criados = [];
  const pulados = [];

  for (const evento of evoClient.EVENTOS_WEBHOOK) {
    if (jaTem.has(evento)) { pulados.push(evento); continue; }
    try {
      await evoClient.criarWebhook(evento, url, headers);
      criados.push(evento);
    } catch (err) {
      // 403 aqui não é dado inválido: é o token do EVO sem permissão de
      // escrita em webhook. Vale traduzir, porque "EVO API 403" manda o
      // consultor procurar o erro no lugar errado — e o GET da mesma
      // família funciona, o que torna o diagnóstico ainda menos óbvio.
      if (err?.status === 403) {
        throw new Error(
          'O EVO recusou o cadastro do webhook com 403 (sem permissão). ' +
          'A leitura funciona, então não é a credencial que está errada: é a ' +
          'permissão de webhook que falta no token. Peça à W12/EVO para liberar ' +
          'escrita de webhook para esta chave de integração. ' +
          `Nenhum evento foi registrado${criados.length ? ` além de: ${criados.join(', ')}` : ''}.`
        );
      }
      throw err;
    }
  }

  logger.info(`[evo-sync] Webhooks: ${criados.length} criados, ${pulados.length} já existiam`);
  return { url, criados, pulados, existentes: existentes.length };
}

export const evoSync = {
  cadastrarProspect, agendarExperimental, registrarVenda, lancarFollowUp,
  guardarEventoWebhook, processarEventoWebhook, reprocessarPendentes,
  sincronizarProspects, registrarWebhooks,
};
