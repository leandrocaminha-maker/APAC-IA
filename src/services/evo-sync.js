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
  registrarEvento, mudarEtapa, leadPorProspect, leadPorMembro, leadsDaPessoa,
  FILTRO_ETAPAS_FECHADAS,
} from './funil.js';
import { planoDaVenda, telefonesDoMembro } from './vendas-regras.js';
import { registrarVendaDoEvo, vincularVendaAoLead } from './vendas.js';
import { normalizePhone } from './evolution.js';
import {
  escolherSessao, vinculoDoProspect, proximoPassoDaAulaVendida, instanteDaVenda, diaSP,
  NOTA_SEM_RESERVA,
} from './aula-regras.js';

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
      // `|| lead.evo_id_member` porque um ex-aluno reativado já teve o
      // vínculo gravado por `buscar_cadastro`, e o prospect do EVO não
      // conhece esse laço — sem isto o vínculo seria apagado aqui.
      evo_id_member: existente.idMember || lead.evo_id_member || null,
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
 * 'AAAA-MM-DD HH:mm' (horário da academia) → ISO em UTC.
 *
 * O offset vai fixo em -03:00 porque o Brasil aboliu o horário de verão em
 * 2019. Deixar implícito faria o resultado depender do fuso do processo — e
 * o container roda em UTC, o que já gravou aula das 15h15 como 12h15.
 */
function paraISO(dataHora) {
  return new Date(`${String(dataHora).trim().replace(' ', 'T')}:00-03:00`).toISOString();
}

/**
 * Acha na grade a sessão que corresponde à data/hora (e ao nome, se dado).
 *
 * Devolve `null` quando não existe — e é esse `null` que evita criar
 * sessão fantasma. A comparação de horário é exata: a grade da academia é
 * de meia em meia hora, e "por volta das 9h" tem de virar um horário da
 * grade antes de chegar aqui.
 */
async function encontrarSessaoNaGrade(dataHora, atividade) {
  const [data, hora] = String(dataHora).trim().split(/[ T]/);
  if (!data || !hora) return null;

  const grade = await evoClient.buscarGrade({ date: data });
  const alvo = hora.slice(0, 5);

  const candidatas = grade.filter(s => String(s.startTime || '').slice(0, 5) === alvo);
  if (!candidatas.length) return null;

  if (!atividade) return candidatas[0];

  // Comparação frouxa de propósito: a Leia escreve "Musculação" e a grade
  // pode ter "Musculação Livre". Acento e caixa não podem separar as duas.
  const normalizar = t => String(t || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
  const busca = normalizar(atividade);

  return candidatas.find(s => {
    const nome = normalizar(s.name);
    return nome === busca || nome.includes(busca) || busca.includes(nome);
  }) || null;
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

  // ⚠️ O serviço é OBRIGATÓRIO. Sem ele o EVO responde "Serviço não
  // encontrado" — testado em 22/08/2026. Não adianta omitir para evitar
  // vender duas vezes a quem já comprou: o endpoint recusa.
  let idService = dados.idService;
  if (!idService && !dados.servico) {
    const servico = await servicoExperimental();
    if (servico) idService = servico.idService;
  }

  // ⚠️ Achar a sessão na grade ANTES de escrever é o que impede o efeito
  // mais caro deste endpoint.
  //
  // Chamado com o nome da atividade, ou com `idActivity` sem
  // `activityExist`, o EVO **cria uma sessão nova e paralela** em vez de
  // colocar a pessoa na aula que já existe. Medido: três chamadas geraram
  // as sessões 199608, 199609 e 199610, invisíveis na grade e impossíveis
  // de abrir depois. Só `idActivity` + `activityExist=true` reaproveitou a
  // sessão real.
  //
  // De quebra, resolver pela grade valida o horário antes de gravar
  // qualquer coisa — em vez de descobrir que não existe depois de já ter
  // criado prospect e venda.
  const sessao = await encontrarSessaoNaGrade(dados.dataHora, dados.atividade);

  if (!sessao) {
    throw new Error(
      `Não há ${dados.atividade || 'essa atividade'} em ${dados.dataHora} na grade. ` +
      'Escolha um horário que exista.'
    );
  }

  // Já tem aula reservada nesse dia? Então não reserve outra.
  //
  // Esta checagem é a defesa principal contra o efeito de 22/08/2026: a
  // Leia reconfirmou um agendamento, leu o 400 do EVO como recusa e foi
  // oferecendo horários seguintes — o cliente terminou com três aulas na
  // mesma terça. Perguntar antes é mais barato do que desfazer depois,
  // porque o EVO não tem rota de exclusão de reserva.
  const dia = String(dados.dataHora).slice(0, 10);
  const jaReservadas = await evoClient
    .sessoesDoProspect(idProspect, { de: dia, ate: dia })
    .catch(() => []);

  if (jaReservadas.length) {
    const s0 = jaReservadas[0];
    logger.info(`[evo-sync] Lead ${base.id}: já tem aula em ${dia} às ${s0.startTime} — não reservando de novo`);
    return {
      ok: true,
      jaEstava: true,
      lead: base,
      raw: s0,
      mensagem: `Já existe aula marcada para ${dia} às ${s0.startTime} (${s0.activitieName || 'atividade'}).`,
    };
  }

  // Quem já comprou a aula experimental não pode comprá-la de novo.
  //
  // É o caso do ex-aluno que fechou o serviço pelo cadastro de cliente: o
  // `experimental-class` sempre vende (o serviço é obrigatório nele), então
  // usá-lo aqui geraria uma segunda venda do mesmo item. O
  // `/api/v2/activities/booking` só reserva — e aceita prospect.
  const jaComprou = base.evo_id_member
    ? await evoClient.membroJaTemExperimental(base.evo_id_member).catch(() => false)
    : false;

  try {
    const raw = jaComprou
      ? await evoClient.reservarEmSessao({
          idProspect,
          idConfiguration: sessao.idConfiguration,
          data: dados.dataHora,
        })
      : await evoClient.agendarAulaExperimental({
          idProspect,
          dataHora: dados.dataHora,
          idActivity: sessao.idActivity,
          idService,
          // Sempre true: a pessoa entra numa aula que já está na grade.
          atividadeExiste: true,
        });

    if (jaComprou) {
      logger.info(`[evo-sync] Lead ${base.id}: reservado sem revender (serviço já comprado)`);
    }

    const dryRun = raw?.dryRun === true;
    // ⚠️ O fuso PRECISA ser explícito. `new Date('2026-08-25T15:15')` sem
    // offset é lido como hora local do processo — e o container roda em UTC,
    // então a aula das 15h15 virava 12h15 em São Paulo. O painel mostrava a
    // hora errada ao consultor, e o cliente seria avisado do horário errado.
    const quando = paraISO(dados.dataHora);

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

    // A régua de follow-up nasce aqui, do mesmo fato: lembrete 24h antes e
    // conversa 4h depois. Em try/catch porque falhar em agendar o
    // follow-up não pode desfazer uma aula que já foi marcada no EVO.
    try {
      const { followup } = await import('./followup.js');
      await followup.aoAgendarExperimental(atualizado || base, dados);
    } catch (err) {
      logger.error('[evo-sync] Aula marcada, mas o follow-up não foi agendado:', err.message);
    }

    logger.info(`[evo-sync] Lead ${base.id}: experimental em ${dados.dataHora}${dryRun ? ' (dry-run)' : ''}`);
    return { ok: true, dryRun, lead: atualizado, raw };
  } catch (err) {
    // "Já está na aula" chega como 400, mas é o estado que queríamos.
    // Tratar como erro foi o que fez a Leia multiplicar agendamentos.
    if (evoClient.ehJaAgendado(err)) {
      logger.info(`[evo-sync] Lead ${base.id}: o EVO diz que já está na aula — considerando agendado`);

      const atualizado = await mudarEtapa(base, 'experimental_agendada', {
        ...autor(usuario),
        somenteAvanco: true,
        motivo: `Experimental já constava agendada para ${dados.dataHora}`,
        campos: {
          experimental_at: paraISO(dados.dataHora),
          experimental_status: 'agendada',
          experimental_activity: dados.atividade || null,
        },
      });

      return { ok: true, jaEstava: true, lead: atualizado || base, raw: { jaEstavaNaAula: true } };
    }

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
 *   NewSale                 → alguém comprou. Venda de plano pago entra no
 *                             registro de vendas e fecha o atendimento
 *                             (vendas.js); aula experimental move para
 *                             experimental agendada; o resto não muda nada.
 *   RecurrentSale           → mensalidade de quem já é aluno. Não fecha nada.
 *   CreateMember            → aluno novo. Liga o número de aluno ao
 *                             atendimento aberto, pelo celular.
 *   CreateMembership        → plano criado no catálogo do EVO. Não fecha nada.
 *   ActivityEnroll          → matrícula em aula, que é como a experimental
 *                             agendada pelo consultor aparece.
 *   crm.automation.*        → automações do CRM (`processarAutomacaoDoCrm`):
 *                             aula experimental realizada e cadastro de
 *                             oportunidade.
 *
 * ⚠️ O que NÃO dá: mudança de etapa/status do prospect. O EVO não emite
 * evento para isso — quem cobre é o poller em `sincronizarProspects`.
 */
/** Etapas encerradas: o atendimento acabou, e aula nova não o reabre. */
const ETAPAS_ENCERRADAS = new Set(['ganho', 'perdido', 'finalizado']);

/** Etapas em que já existe uma aula registrada na ficha. */
const ETAPAS_COM_AULA = new Set(['experimental_agendada', 'experimental_realizada']);

/**
 * Este lead já sabe de uma aula que ainda vai acontecer?
 *
 * Não basta olhar a etapa. Quem fez a primeira experimental fica em
 * `experimental_realizada` com a data no passado — e se marcar uma segunda
 * no balcão, essa é notícia nova: precisa de lembrete e de conversa depois,
 * como qualquer outra. Barrar pela etapa deixaria a segunda aula muda.
 *
 * O que de fato dispensa trabalho é ter aula FUTURA na ficha, que é o caso
 * de segundos atrás: a tool da Leia acabou de marcar e o webhook da venda
 * de R$ 0 chega logo atrás, falando da mesma aula.
 */
function jaSabeDeAulaFutura(lead) {
  if (ETAPAS_ENCERRADAS.has(lead.stage)) return true;
  if (!ETAPAS_COM_AULA.has(lead.stage)) return false;

  const quando = Date.parse(lead.experimental_at || '');
  return Number.isFinite(quando) && quando > Date.now();
}

/**
 * A aula experimental marcada no BALCÃO entra no funil por aqui.
 *
 * ## Como ela chega
 *
 * Não por `ActivityEnroll`. Esse evento está assinado desde o começo e
 * nunca recebeu nada — confirmado num teste em 12/09/2026, marcando uma
 * experimental direto no EVO para o prospect 47086. O que chegou foi
 * `NewSale`, porque o serviço "AULA EXPERIMENTAL" é **vendido por R$ 0**
 * toda vez que alguém marca um trial. É o mesmo motivo pelo qual
 * `ehSomenteExperimental` existe.
 *
 * ## O que faltava
 *
 * Até então esse ramo só PROTEGIA: reconhecia a venda de R$ 0 e parava,
 * para o lead não fechar como ganho por engano (o que cancelaria os
 * follow-ups da aula — aconteceu com 8 leads em 25/08/2026). Mas ninguém
 * movia o lead. O resultado, para quem falou com a Leia e depois marcou no
 * balcão: o funil seguia dizendo "em conversa", sem lembrete de 24h e sem
 * conversa pós-aula. Pelo caminho da Leia isso funciona porque a tool move
 * o lead ela mesma, não porque o webhook faça algo.
 *
 * ## O que ainda faltava (29/10/2026)
 *
 * Mover o lead só funcionava quando o atendimento já conhecia o cadastro e
 * a reserva já existia no instante da venda. Nas seis conversas analisadas
 * nesse dia, nenhuma aula do balcão tinha chegado ao lead: em três o
 * cadastro tinha sido criado ou reaproveitado pela consultora, e em duas a
 * venda veio antes da reserva. Agora o cadastro desconhecido é procurado pelo celular, e a
 * aula sem reserva fica guardada para procurar de novo
 * (`procurarAulasVendidas`).
 *
 * ## A ordem aqui é de custo
 *
 * Casar o lead é de graça (Supabase). Só depois de existir lead E de ele
 * ainda não saber da aula é que sai a consulta ao EVO — a venda não diz
 * QUANDO é a aula, só que ela foi vendida, e sem hora não há lembrete.
 * A aula que a própria Leia acabou de marcar não custa requisição nenhuma.
 * O cadastro que nenhum atendimento conhece custa uma (o cadastro, para
 * saber o celular) — eram 41 vendas assim em outubro de 2026, a maioria de
 * gente que nunca escreveu no WhatsApp.
 */
async function aoVerExperimentalNaVenda(detalhe, evento) {
  const idMember = detalhe?.idMember ?? detalhe?.IdMember ?? null;
  const idProspect = detalhe?.idProspect ?? detalhe?.IdProspect ?? null;

  let lead = idMember ? await leadPorMembro(idMember) : null;
  if (!lead && idProspect) {
    lead = await leadPorProspect(idProspect);

    // Nenhum atendimento conhece este cadastro, ou só um encerrado conhece:
    // procurar pelo celular dele. Até 29/10/2026 este era o fim da linha, e
    // a aula marcada no cadastro que a consultora criou no balcão não
    // chegava a lugar nenhum — ver `leadAbertoDoCelularDoProspect`.
    if (!lead || ETAPAS_ENCERRADAS.has(lead.stage)) {
      const achado = await leadAbertoDoCelularDoProspect(idProspect);
      if (achado) {
        lead = await ligarCadastroAoLead(achado.lead, achado.prospect, {
          actor: 'evo-webhook', idSale: evento.id_record,
        });
      }
    }
  }

  // Prospect que só existe no EVO: nada a fazer, e o funil não inventa
  // lead para quem nunca escreveu.
  if (!lead) return null;

  // A Leia marcou, e a tool dela já moveu o lead segundos atrás. Sair
  // daqui agora poupa a consulta de sessões — e `agendar` é idempotente,
  // então mesmo que passasse não duplicaria follow-up.
  if (jaSabeDeAulaFutura(lead)) {
    logger.debug(`[evo-sync] Lead ${lead.id} já sabe da aula (${lead.stage}) — nada a reaprender`);
    return lead;
  }

  const vendidaEm = instanteDaVenda(detalhe, evento);
  let escolhida = null;
  try {
    escolhida = await sessaoNoEvo({ idProspect, idMember }, { desde: vendidaEm });
  } catch (err) {
    logger.warn(`[evo-sync] Não deu para ler as sessões do lead ${lead.id}: ${err.message}`);
  }

  // Sem a sessão, a aula fica guardada para procurar de novo. A consultora
  // às vezes vende a aula antes de reservar o horário — e até 29/10/2026 o
  // sistema olhava uma vez só, aqui, e nunca mais.
  if (!escolhida) {
    await guardarAulaVendida(lead, { idSale: evento.id_record, idProspect, idMember, vendidaEm });
    return lead;
  }

  const { lead: atualizado } = await registrarAulaDoBalcao(lead, escolhida, {
    actor: 'evo-webhook', payload: { idSale: evento.id_record },
  });
  return atualizado || lead;
}

// ──────────────────────────────────────────────
// Aula do balcão: achar o atendimento, achar a sessão, registrar
// ──────────────────────────────────────────────

/** A linha inteira do lead, para quem vai gravar nela (metadata, próxima ação). */
async function lerLead(id) {
  const { data } = await supabase.from('crm_leads').select('*').eq('id', id).maybeSingle();
  return data || null;
}

/** Nome do cadastro do EVO, para o razão do lead. */
const nomeDoCadastro = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ').trim() || null;

/**
 * O atendimento de venda aberto do celular de um cadastro do EVO.
 *
 * Serve a dois casos que a venda da aula não resolvia sozinha:
 *
 *  - **o cadastro que nenhum atendimento conhece.** A consultora assume a
 *    conversa antes de a Leia cadastrar, e cria ou reaproveita o cadastro
 *    no balcão. Foi assim com a Amanda (cadastro da Emily, criado pela
 *    Catia), a Márcia (da Lara) e a Hellen (um cadastro de 2018 do mesmo
 *    celular, renomeado para Luiza);
 *  - **o cadastro que só um atendimento encerrado conhece.** Quem foi dado
 *    como perdido em setembro e voltou a escrever em outubro tem lead novo,
 *    e o cadastro continua preso ao antigo.
 *
 * Só atendimento de VENDA aberto. O celular é da família: a aula do filho
 * não deve puxar de volta para a venda a conversa de relacionamento da mãe
 * que já é aluna.
 *
 * Custa uma consulta ao EVO — o cadastro, para saber o celular.
 */
async function leadAbertoDoCelularDoProspect(idProspect) {
  let prospect = null;
  try {
    prospect = await evoClient.buscarProspectPorId(idProspect);
  } catch (err) {
    logger.warn(`[evo-sync] Não deu para ler o cadastro ${idProspect} no EVO: ${err.message}`);
    return null;
  }

  const telefone = prospect?.cellphone ? normalizePhone(prospect.cellphone) : null;
  if (!telefone || !/^55\d{10,11}$/.test(telefone)) return null;

  const abertos = (await leadsDaPessoa({ telefones: [telefone] }))
    .filter(l => l.phone === telefone)
    .filter(l => !ETAPAS_ENCERRADAS.has(l.stage) && (l.trilha || 'lead') === 'lead')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!abertos.length) return null;

  const lead = await lerLead(abertos[0].id);
  return lead ? { lead, prospect } : null;
}

/**
 * Liga ao atendimento o cadastro do EVO em que a aula foi marcada — ou
 * registra por que não ligou. A regra está em `vinculoDoProspect`.
 */
async function ligarCadastroAoLead(lead, prospect, { actor, idSale = null }) {
  const idProspect = Number(prospect?.idProspect);
  const nome = nomeDoCadastro(prospect);
  const rotulo = `${idProspect}${nome ? ` (${nome})` : ''}`;
  const decisao = vinculoDoProspect(lead, idProspect);

  if (decisao === 'manter') return lead;

  if (decisao === 'outro') {
    await registrarEvento(lead.id, {
      type: 'evo_prospect_outro',
      actor,
      summary: `Aula marcada no EVO no cadastro ${rotulo}, do mesmo celular. ` +
        `O atendimento continua ligado ao cadastro ${lead.evo_id_prospect}.`,
      payload: { idProspect, idSale },
    });
    return lead;
  }

  const { data, error } = await supabase
    .from('crm_leads')
    .update({
      evo_id_prospect: idProspect,
      evo_sync: 'sincronizado',
      evo_sync_error: null,
      evo_synced_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .select()
    .single();

  // O caso típico é o 23505: o cadastro está preso ao atendimento encerrado
  // de antes (o índice é único na tabela inteira). A aula entra neste
  // assim mesmo; só o vínculo fica onde estava.
  if (error) {
    logger.warn(`[evo-sync] Lead ${lead.id}: cadastro ${idProspect} não ligado (${error.message}) — a aula entra assim mesmo`);
    return lead;
  }

  await registrarEvento(lead.id, {
    type: 'evo_prospect_vinculado',
    actor,
    summary: `Cadastro ${rotulo} do EVO ligado pelo celular`,
    payload: { idProspect, idSale, origem: 'celular' },
  });
  logger.info(`[evo-sync] Lead ${lead.id}: cadastro ${idProspect} ligado pelo celular`);
  return data;
}

/**
 * A aula de uma pessoa no EVO, a partir de `desde` (ver `escolherSessao`).
 *
 * Lança quando o EVO falha: "não há aula" e "não deu para saber" pedem
 * coisas diferentes de quem chama.
 */
async function sessaoNoEvo({ idProspect = null, idMember = null }, { desde = null, agora = new Date() } = {}) {
  const de = diaSP(desde || agora);
  const ate = new Date(agora.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sessoes = await evoClient.sessoesDaPessoa({ idProspect, idMember, de, ate });
  return escolherSessao(sessoes, { desde, agora });
}

/**
 * Registra no atendimento a aula achada no EVO e arma a régua dela.
 *
 * A mesma aula que o lead já conhece não arma nada: os follow-ups dela já
 * foram agendados ou enviados, e agendar de novo mandaria o lembrete duas
 * vezes.
 *
 * Limpa a aula guardada sem reserva e, se a nota de "aula sem reserva" na
 * próxima ação foi posta por este sistema, a nota também.
 *
 * @returns {Promise<{ lead: object|null, nova: boolean }>}
 */
async function registrarAulaDoBalcao(leadOuId, escolhida, { actor, payload = {} }) {
  const lead = await lerLead(typeof leadOuId === 'object' ? leadOuId.id : leadOuId);
  if (!lead) return { lead: null, nova: false };

  const { dataHora, sessao } = escolhida;
  const atividade = sessao?.activitieName || sessao?.activityName || null;
  const quando = paraISO(dataHora);

  const { aula_vendida: guardada, ...metadata } = lead.metadata || {};
  const notaNossa = String(lead.next_action_note || '').startsWith(NOTA_SEM_RESERVA);
  const limpeza = {
    ...(guardada ? { metadata } : {}),
    ...(notaNossa ? { next_action_at: null, next_action_note: null } : {}),
  };

  if (Date.parse(lead.experimental_at || '') === Date.parse(quando)) {
    if (Object.keys(limpeza).length) {
      await supabase.from('crm_leads').update(limpeza).eq('id', lead.id);
    }
    return { lead: { ...lead, ...limpeza }, nova: false };
  }

  // `somenteAvanco` protege o retrocesso de etapa, mas NÃO descarta a
  // atualização: `mudarEtapa` grava `campos` mesmo quando bloqueia a etapa
  // (ver funil.js). É o que faz a SEGUNDA experimental funcionar — quem
  // está em `experimental_realizada` e marca outra no balcão continua
  // nessa etapa, com a ficha e a régua apontando para a aula nova. A etapa
  // não volta atrás, e a pessoa recebe lembrete e conversa pós-aula igual.
  const atualizado = await mudarEtapa(lead, 'experimental_agendada', {
    actor,
    somenteAvanco: true,
    motivo: `Aula experimental de ${atividade || 'atividade'} marcada no EVO para ${dataHora}`,
    campos: {
      experimental_at: quando,
      experimental_status: 'agendada',
      experimental_activity: atividade,
      ...limpeza,
    },
    payload: { ...payload, sessao },
  });

  // A régua da aula — lembrete de 24h e conversa depois. É o que torna a
  // aula do balcão indistinguível da que a Leia marcou, do ponto de vista
  // do cliente.
  try {
    const { followup } = await import('./followup.js');
    await followup.aoAgendarExperimental(atualizado || lead, { dataHora, atividade });
  } catch (err) {
    logger.error(`[evo-sync] Follow-up da experimental do lead ${lead.id} falhou: ${err.message}`);
  }

  logger.info(`[evo-sync] Lead ${lead.id}: experimental marcada no EVO para ${dataHora} (${atividade || 'atividade'})`);
  return { lead: atualizado || lead, nova: true };
}

/**
 * Guarda a aula vendida que ainda não tem horário reservado, para procurar
 * de novo (`procurarAulasVendidas`).
 *
 * Em `metadata.aula_vendida`, e não numa tabela: é um estado de dias, de
 * um punhado de leads, e uma migration a mais é uma chance a mais de o
 * código rodar contra um banco que não a tem.
 */
async function guardarAulaVendida(lead, { idSale, idProspect, idMember, vendidaEm }) {
  const atual = await lerLead(lead.id);
  if (!atual) return;

  const marcador = {
    id_sale: idSale ?? null,
    id_prospect: idProspect ?? null,
    id_member: idMember ?? null,
    vendida_em: vendidaEm.toISOString(),
    tentativas: 0,
  };

  await supabase
    .from('crm_leads')
    .update({ metadata: { ...(atual.metadata || {}), aula_vendida: marcador } })
    .eq('id', atual.id);

  await registrarEvento(atual.id, {
    type: 'aula_vendida_sem_reserva',
    actor: 'evo-webhook',
    summary: 'Aula experimental vendida no EVO, ainda sem horário reservado — o sistema volta a procurar a reserva',
    payload: marcador,
  });
  logger.info(`[evo-sync] Lead ${atual.id}: aula vendida (venda ${idSale}) sem reserva ainda — guardada para procurar de novo`);
}

/** Data e hora de São Paulo, curta, para nota e razão. */
const curtaSP = (iso) => new Date(iso).toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * Avisa a consultora que a aula foi vendida e o horário não foi reservado.
 *
 * Pela próxima ação do lead, que o painel mostra em vermelho quando vence —
 * é o mesmo canal da sugestão pós-aula. Não passa por cima de uma próxima
 * ação que a consultora marcou para o futuro: aí fica só o razão.
 */
async function avisarAulaSemReserva(lead, marcador, agora) {
  const nota = `${NOTA_SEM_RESERVA} em ${curtaSP(marcador.vendida_em)}, sem horário reservado. ` +
    'Conferir a reserva e confirmar o horário com o cliente.';
  const proxima = Date.parse(lead.next_action_at || '');
  const ocupada = Number.isFinite(proxima) && proxima > agora.getTime();

  await supabase
    .from('crm_leads')
    .update({
      metadata: {
        ...(lead.metadata || {}),
        aula_vendida: { ...marcador, avisado_em: agora.toISOString(), tentativas: (marcador.tentativas || 0) + 1 },
      },
      ...(ocupada ? {} : { next_action_at: agora.toISOString(), next_action_note: nota }),
    })
    .eq('id', lead.id);

  await registrarEvento(lead.id, {
    type: 'sugestao_consultor',
    actor: 'sistema',
    summary: nota,
    payload: { idSale: marcador.id_sale, idProspect: marcador.id_prospect, idMember: marcador.id_member },
  });
  logger.info(`[evo-sync] Lead ${lead.id}: aula vendida sem reserva — consultora avisada`);
}

/**
 * Procura de novo a reserva das aulas vendidas que ainda não tinham horário.
 *
 * Roda no ciclo do worker do EVO. Uma consulta ao EVO por aula guardada, e
 * no máximo `limite` por ciclo — a fila anda pela mais antiga, porque cada
 * passada regrava a linha e a manda para o fim.
 *
 *  - achou a sessão → registra a aula e arma a régua;
 *  - não achou, depois de 3h → avisa a consultora, uma vez;
 *  - não achou em 7 dias → desiste e deixa o motivo no razão.
 */
export async function procurarAulasVendidas({ limite = 10, agora = new Date() } = {}) {
  const resumo = { examinadas: 0, achadas: 0, avisadas: 0, desistidas: 0 };

  const { data: leads, error } = await supabase
    .from('crm_leads')
    .select('*')
    .not('metadata->aula_vendida', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limite);

  if (error) {
    logger.warn(`[evo-sync] Não deu para ler as aulas vendidas sem reserva: ${error.message}`);
    return resumo;
  }

  for (const lead of leads || []) {
    resumo.examinadas++;
    const { aula_vendida: marcador, ...semMarcador } = lead.metadata || {};

    // Encerrado, ou já sabe de aula por vir (a Leia marcou, ou outra venda
    // trouxe a sessão): não há mais o que procurar.
    if (jaSabeDeAulaFutura(lead)) {
      await supabase.from('crm_leads').update({ metadata: semMarcador }).eq('id', lead.id);
      continue;
    }

    let escolhida = null;
    try {
      escolhida = await sessaoNoEvo(
        { idProspect: marcador.id_prospect, idMember: marcador.id_member },
        { desde: new Date(marcador.vendida_em), agora },
      );
    } catch (err) {
      // EVO fora: nada muda, e a próxima passada tenta de novo. O prazo
      // continua correndo, porque ele conta da venda.
      logger.warn(`[evo-sync] Lead ${lead.id}: sessões não lidas (${err.message}) — tento no próximo ciclo`);
      await supabase.from('crm_leads').update({ metadata: lead.metadata }).eq('id', lead.id);
      continue;
    }

    if (escolhida) {
      await registrarAulaDoBalcao(lead, escolhida, {
        actor: 'evo-poll',
        payload: { idSale: marcador.id_sale, tentativas: (marcador.tentativas || 0) + 1 },
      });
      resumo.achadas++;
      continue;
    }

    const passo = proximoPassoDaAulaVendida(marcador, agora);

    if (passo === 'desistir') {
      await supabase.from('crm_leads').update({ metadata: semMarcador }).eq('id', lead.id);
      await registrarEvento(lead.id, {
        type: 'aula_vendida_sem_reserva',
        actor: 'sistema',
        summary: `A aula vendida em ${curtaSP(marcador.vendida_em)} não ganhou horário em 7 dias — o sistema parou de procurar`,
        payload: marcador,
      });
      resumo.desistidas++;
    } else if (passo === 'avisar') {
      await avisarAulaSemReserva(lead, marcador, agora);
      resumo.avisadas++;
    } else {
      await supabase
        .from('crm_leads')
        .update({ metadata: { ...lead.metadata, aula_vendida: { ...marcador, tentativas: (marcador.tentativas || 0) + 1 } } })
        .eq('id', lead.id);
    }
  }

  if (resumo.examinadas) {
    logger.info(
      `[evo-sync] Aulas vendidas sem reserva: ${resumo.examinadas} examinada(s), ${resumo.achadas} achada(s), ` +
      `${resumo.avisadas} aviso(s) à consultora, ${resumo.desistidas} desistência(s)`
    );
  }
  return resumo;
}

/** A aula `a` é melhor que `b`? Por vir ganha de passada; entre as por vir, a mais próxima; entre as passadas, a mais recente. */
function aulaMelhor(a, b) {
  if (a.futura !== b.futura) return a.futura;
  return a.futura ? a.dataHora < b.dataHora : a.dataHora > b.dataHora;
}

/**
 * Procura no EVO uma aula da pessoa a partir de `desde` e, se for nova, a
 * registra no atendimento (com a régua da aula).
 *
 * É a rede embaixo do webhook: a régua de silêncio pergunta aqui antes de
 * cutucar quem parece sumido, e o encerramento antes de dar alguém como
 * perdido. Assim a mensagem de "tudo bem se não for o momento" não sai mais
 * para quem tem aula marcada — que foi o caso da Amanda.
 *
 * Quem é consultado: o cadastro de aluno e o de oportunidade do lead; e,
 * quando o lead não tem cadastro de oportunidade, os do celular dele (os
 * três mais recentes) — é o caso do cadastro feito no balcão.
 *
 * @param {object}  lead
 * @param {object}  [opcoes]
 * @param {Date}    [opcoes.desde]          a partir de quando a aula conta
 * @param {boolean} [opcoes.somenteFutura]  ignora aula que já passou
 * @param {boolean} [opcoes.registrar]      `false` só olha (simulação)
 * @returns {Promise<
 *   { dataHora: string, futura: boolean, nova: boolean, lead: object } |
 *   { indefinido: true } |
 *   null
 * >} `null` quando não há aula; `indefinido` quando o EVO não respondeu.
 */
export async function conferirAulaNoEvo(lead, {
  desde = new Date(), somenteFutura = false, registrar = true, actor = 'sistema', agora = new Date(),
} = {}) {
  const pessoas = [];
  let falhou = false;

  if (Number(lead.evo_id_member) > 0) pessoas.push({ idMember: Number(lead.evo_id_member) });

  if (Number(lead.evo_id_prospect) > 0) {
    pessoas.push({ idProspect: Number(lead.evo_id_prospect) });
  } else if (lead.phone) {
    try {
      const { cellphone } = evoClient.separarDdi(lead.phone);
      const doCelular = await evoClient.buscarProspects({ phone: cellphone, take: 50 });
      doCelular
        .filter(p => p?.idProspect)
        .sort((a, b) => String(b.registerDate || '').localeCompare(String(a.registerDate || '')))
        .slice(0, 3)
        .forEach(p => pessoas.push({ idProspect: Number(p.idProspect), prospect: p }));
    } catch (err) {
      falhou = true;
      logger.warn(`[evo-sync] Lead ${lead.id}: cadastros do celular não lidos (${err.message})`);
    }
  }

  let melhor = null;
  for (const pessoa of pessoas) {
    let escolhida = null;
    try {
      escolhida = await sessaoNoEvo(pessoa, { desde, agora });
    } catch (err) {
      falhou = true;
      logger.warn(`[evo-sync] Lead ${lead.id}: sessões não lidas (${err.message})`);
      continue;
    }
    if (!escolhida || (somenteFutura && !escolhida.futura)) continue;
    if (!melhor || aulaMelhor(escolhida, melhor)) melhor = { ...escolhida, pessoa };
  }

  if (!melhor) return falhou ? { indefinido: true } : null;

  const conhecida = Date.parse(lead.experimental_at || '') === Date.parse(paraISO(melhor.dataHora));
  if (!registrar) {
    return { dataHora: melhor.dataHora, futura: melhor.futura, nova: !conhecida, lead };
  }

  let alvo = lead;
  if (melhor.pessoa.prospect) {
    alvo = await ligarCadastroAoLead((await lerLead(lead.id)) || lead, melhor.pessoa.prospect, { actor });
  }
  const { lead: atualizado, nova } = await registrarAulaDoBalcao(alvo, melhor, {
    actor, payload: { origem: 'conferencia' },
  });
  return { dataHora: melhor.dataHora, futura: melhor.futura, nova, lead: atualizado || lead };
}

// ──────────────────────────────────────────────
// Automações do CRM 2.0 do EVO
//
// São a outra porta de webhook do EVO, configurada na tela de automação
// (ação "Webhook"). O payload já vem completo — `person` com nome, celular
// e os números de aluno e prospect —, então nada aqui consulta o EVO.
//
// Ativadas em 26/10/2026, a pedido do responsável:
//   *trial_class_completed   aula experimental realizada (oportunidade e cliente)
//   *prospect_registration   cadastro de oportunidade
// As que já existiam ("sem presenca 10", segmentações) seguem só guardadas.
//
// O nome da versão de cliente da aula realizada não estava na
// documentação; por isso a regra casa pelo FINAL do nome.
// ──────────────────────────────────────────────

/** Os atendimentos de quem o aviso fala, do mais útil para o menos. */
async function atendimentosDoAviso(person) {
  const telefone = person?.phone ? normalizePhone(person.phone) : null;
  const leads = await leadsDaPessoa({
    idMember: person?.idMember,
    idProspect: person?.idProspect,
    telefones: telefone ? [telefone] : [],
  });
  const fechado = (l) => ['ganho', 'perdido', 'finalizado'].includes(l.stage);
  const peso = (l) => (!fechado(l) && (l.trilha || 'lead') === 'lead' ? 0 : !fechado(l) ? 1 : 2);
  return leads.sort((a, b) => peso(a) - peso(b) || new Date(b.created_at) - new Date(a.created_at));
}

/**
 * Interpreta um aviso de automação do CRM.
 *
 * @returns {Promise<object|null>} o lead a que o aviso foi ligado
 */
export async function processarAutomacaoDoCrm(tipo, payload) {
  const person = payload?.person || {};

  // Aula experimental realizada: quem foi à academia.
  //
  // O consultor fecha a aula no EVO lançando presença ou falta, e a
  // automação avisa de madrugada quem esteve presente. Vira a etapa
  // "Experimental realizada" — que até aqui ninguém preenchia — e é o que a
  // conversa pós-aula da Leia lê na manhã seguinte para saber o que dizer.
  if (/trial_class_completed$/.test(tipo)) {
    const [lead] = await atendimentosDoAviso(person);
    if (!lead) {
      logger.info(`[evo-sync] Aula experimental realizada de quem não está no funil (${person.fullName || 'sem nome'})`);
      return null;
    }

    // `somenteAvanco`: lead encerrado não reabre e etapa não volta. Os
    // campos são gravados mesmo assim (ver `mudarEtapa`) — o fato da
    // presença vale para quem já fechou.
    const atualizado = await mudarEtapa(lead, 'experimental_realizada', {
      actor: 'evo-crm',
      somenteAvanco: true,
      motivo: 'O EVO avisou: aula experimental realizada',
      campos: { experimental_status: 'realizada' },
    });
    await registrarEvento(lead.id, {
      type: 'experimental_realizada',
      actor: 'evo-crm',
      summary: `Aula experimental realizada (aviso do EVO${payload?.eventLabel ? `: ${payload.eventLabel}` : ''})`,
      payload: { eventDate: payload?.eventDate ?? null, eventContext: payload?.eventContext ?? null },
    });
    logger.info(`[evo-sync] Lead ${lead.id}: aula experimental realizada`);
    return atualizado || lead;
  }

  // Cadastro de oportunidade: liga o prospect ao atendimento do WhatsApp.
  //
  // O consultor cadastra no balcão quem chegou depois de conversar com a
  // Leia, e o lead não ficava sabendo do prospect — então a conversão dele
  // nunca era reconhecida. Quem não tem atendimento nenhum é cadastro de
  // balcão, e fica contado pelo próprio evento (lead_id vazio).
  if (/prospect_registration$/.test(tipo)) {
    const idProspect = Number(person.idProspect) || null;
    if (!idProspect) return null;

    const { data: jaLigado } = await supabase
      .from('crm_leads').select('id').eq('evo_id_prospect', idProspect).limit(1);
    if (jaLigado?.length) return jaLigado[0];

    const lead = (await atendimentosDoAviso(person))
      .find(l => !l.evo_id_prospect && !['ganho', 'perdido', 'finalizado'].includes(l.stage));
    if (!lead) return null;

    await supabase.from('crm_leads').update({ evo_id_prospect: idProspect }).eq('id', lead.id);
    await registrarEvento(lead.id, {
      type: 'evo_prospect_vinculado',
      actor: 'evo-crm',
      summary: `Cadastrado como oportunidade no EVO (prospect ${idProspect})`,
      payload: { idProspect },
    });
    logger.info(`[evo-sync] Lead ${lead.id}: prospect ${idProspect} ligado pelo cadastro no EVO`);
    return lead;
  }

  logger.debug(`[evo-sync] Automação ${tipo} guardada sem regra de funil`);
  return null;
}

/**
 * Tipos que o `switch` abaixo sabe interpretar.
 *
 * É a lista que decide se vale pagar o ApiCallback. Ao dar regra a um tipo
 * novo, ele precisa entrar AQUI também — senão o `case` recebe
 * `detalhe = null` e não acha lead nenhum, em silêncio.
 */
const TIPOS_COM_REGRA = new Set([
  'NewSale', 'RecurrentSale', 'CreateMembership', 'CreateMember', 'ActivityEnroll',
]);

export async function processarEventoWebhook(evento) {
  const tipo = evento.event_type;
  let lead = null;
  let detalhe = null;

  try {
    // O envelope traz só ids. O dado real está atrás do ApiCallback — e
    // buscá-lo custa UMA requisição ao EVO, por evento.
    //
    // Por isso o detalhe só é buscado para o que o `switch` sabe usar. A
    // conta assinada não é a única que chega aqui: o EVO manda também
    // eventos que ninguém pediu (`crm.segmentation.batch` respondeu por
    // 122 dos 660 eventos guardados até 12/09/2026). Todos caíam no
    // `default`, que não faz nada com o detalhe — mas o detalhe já tinha
    // sido comprado, porque a busca acontecia antes de saber o tipo.
    //
    // O envelope continua sendo guardado igual, com ou sem detalhe: ele é
    // o registro de que o evento chegou, e é o que permite reprocessar
    // depois se um tipo novo ganhar regra.
    if (evento.api_callback && TIPOS_COM_REGRA.has(tipo)) {
      detalhe = await buscarDetalhe(evento).catch(err => {
        logger.warn(`[evo-sync] ApiCallback de ${tipo} falhou: ${err.message}`);
        return null;
      });
    }

    switch (tipo) {
      case 'NewSale':
      case 'RecurrentSale':
      case 'CreateMembership': {
        // Agendar aula experimental REGISTRA UMA VENDA no EVO.
        //
        // O serviço "AULA EXPERIMENTAL" é vendido por R$ 0 toda vez que
        // alguém marca um trial — inclusive quando é a própria Leia que
        // marca, via `agendar_aula_experimental`. Então `NewSale` dispara
        // para agendamento, não só para venda de plano.
        //
        // Sem esta conferência, fechar o lead como "ganho" erra duas vezes:
        // afirma uma venda que não houve, e o "ganho" CANCELA os follow-ups
        // da régua — o lembrete da aula e a conversa pós-aula deixam de sair
        // justamente para quem tem aula marcada. Aconteceu com 8 leads em
        // 25/08/2026, ao reprocessar os eventos guardados.
        if (await ehSomenteExperimental(detalhe)) {
          logger.info(
            `[evo-sync] ${tipo} ${evento.id_record} é do serviço de aula experimental — ` +
            'não fecha lead como ganho'
          );
          lead = await aoVerExperimentalNaVenda(detalhe, evento);
          break;
        }

        // Só `NewSale` é venda nova.
        //
        // `RecurrentSale` é a mensalidade automática de quem já é aluno: as
        // 589 guardadas até 26/10/2026 são todas renovação de contrato
        // (`idMembershipRenewed`), nenhuma de prospect. `CreateMembership`
        // é o cadastro de um PLANO no catálogo do EVO — o detalhe é o plano,
        // sem pessoa nenhuma. Nenhum dos dois é alguém comprando.
        if (tipo !== 'NewSale') break;

        // Touca, maiô, avaliação física e cortesia passam no caixa do EVO
        // como venda, mas não são o fechamento que o funil conta.
        if (!planoDaVenda(detalhe)) {
          const idMember = detalhe?.idMember ?? detalhe?.IdMember ?? null;
          lead = idMember ? await leadPorMembro(idMember) : null;
          if (!lead && detalhe?.idProspect) lead = await leadPorProspect(detalhe.idProspect);
          logger.info(`[evo-sync] ${tipo} ${evento.id_record} não tem plano pago — é compra, não fechamento`);
          break;
        }

        // Venda de plano: entra no registro de vendas, classificada, e o
        // atendimento do WhatsApp que ela fecha vira ganho (ver vendas.js).
        lead = await registrarVendaDoEvo(detalhe, evento);
        break;
      }

      case 'CreateMember': {
        const idMember = evento.id_record;
        const doc = detalhe?.document || detalhe?.cellphone;
        lead = await leadPorMembro(idMember);
        if (!lead && detalhe?.idProspect) lead = await leadPorProspect(detalhe.idProspect);

        // O cadastro de aluno novo não traz o prospect, mas traz o celular.
        // Ligar AGORA o número de aluno ao atendimento aberto é o que faz a
        // venda, que chega logo atrás com esse número, achar o lead sem
        // perguntar nada ao EVO. Só atendimento aberto: o encerrado de
        // meses atrás não é desta matrícula.
        if (!lead) {
          const abertos = (await leadsDaPessoa({ telefones: telefonesDoMembro(detalhe) }))
            .filter(l => !['ganho', 'perdido', 'finalizado'].includes(l.stage) && !l.evo_id_member)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          lead = abertos[0] || null;
        }

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
        if (String(tipo).startsWith('crm.automation.')) {
          lead = await processarAutomacaoDoCrm(tipo, evento.payload);
          break;
        }
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
 * Cache do id do serviço de aula experimental no EVO.
 * O catálogo de serviços praticamente não muda; consultá-lo a cada webhook
 * seria gastar cota da API por um dado estável.
 */
let idServicoExperimental;

/**
 * A venda é SÓ de aula experimental?
 *
 * A conferência é pelo `idService`, não pelo nome: o EVO marca o serviço
 * com `experimentalClass: true` e é isso que manda. Casar por texto
 * quebraria no dia em que alguém renomeasse "AULA EXPERIMENTAL" na tela do
 * EVO, e o sintoma seria lead fechado como ganho sem venda — o pior lado
 * do erro. O nome fica como rede: se o catálogo não puder ser lido, é
 * melhor reconhecer o experimental por texto do que tratá-lo como venda.
 *
 * Item com `idMembership` é plano, e plano nunca é só experimental.
 *
 * Venda SEM itens não conta como experimental: não dá para afirmar nada.
 * Ela segue para o fluxo de venda, e lá também não fecha nada, porque não
 * tem plano (ver `planoDaVenda`).
 */
export { ehSomenteExperimental as _ehSomenteExperimental };

/**
 * A venda de plano mais recente deste aluno, entre os webhooks guardados.
 *
 * É como o poller descobre o valor. A venda costuma chegar ANTES dele, mas
 * sem achar o lead: o detalhe traz o `idMember` novo e `idProspect` nulo, e
 * o lead ainda só conhece o prospect. Foi o caso de 12 dos 19 ganhos até
 * 26/10/2026 — todos com a venda guardada, nenhum com o valor no lead.
 */
async function vendaGuardadaDoMembro(idMember) {
  const { data, error } = await supabase
    .from('crm_evo_webhook_events')
    .select('id_record, detail')
    .eq('event_type', 'NewSale')
    .eq('detail->>idMember', String(idMember))
    .order('id', { ascending: false })
    .limit(20);

  if (error) {
    logger.warn(`[evo-sync] Não deu para procurar a venda do membro ${idMember}: ${error.message}`);
    return null;
  }

  for (const evento of data || []) {
    const plano = planoDaVenda(evento.detail);
    if (plano) return { ...plano, idSale: evento.id_record };
  }
  return null;
}

async function ehSomenteExperimental(detalhe) {
  const itens = detalhe?.saleItens ?? detalhe?.saleItems ?? [];
  if (!Array.isArray(itens) || itens.length === 0) return false;

  if (idServicoExperimental === undefined) {
    try {
      const servico = await evoClient.buscarServicoExperimental();
      idServicoExperimental = servico?.idService ?? servico?.id ?? null;
    } catch (err) {
      logger.warn('[evo-sync] Não consegui ler o serviço experimental do EVO:', err.message);
      idServicoExperimental = null;
    }
  }

  return itens.every(item => {
    if (item?.idMembership) return false;
    if (idServicoExperimental != null && item?.idService === idServicoExperimental) return true;
    const texto = `${item?.item ?? ''} ${item?.description ?? ''}`;
    return /aula\s*experimental/i.test(texto);
  });
}

/**
 * Busca o detalhe apontado pelo ApiCallback.
 *
 * O envelope do webhook só traz ids; o dado real está atrás desta URL.
 *
 * ## Duas correções que vieram da observação, não da doc
 *
 * **O host do callback não é o host da API.** Nós consultamos
 * `evo-integracao-api`, e o EVO chama de volta apontando para
 * `evo-integracao` (sem o "-api"). Comparar com `config.evo.baseUrl`
 * rejeitava todo callback legítimo, e o sintoma era mudo: a venda chegava,
 * o detalhe nunca era buscado, e o lead não fechava como ganho. Por isso a
 * conferência é contra `callbackHosts`, uma allowlist.
 *
 * **Nem todo ApiCallback vem interpolado.** O de `CreateMember` chega
 * literalmente como `/api/v1/members/{idMember}` — o EVO não substitui o
 * placeholder. Quando isso acontece, o id certo é o `IdRecord` do próprio
 * envelope, que veio correto.
 *
 * A allowlist continua sendo o que impede SSRF: seguir URL arbitrária vinda
 * de webhook, num processo que alcança a rede interna do Docker, seria
 * entregar a rede a quem descobrir o endpoint.
 */
/**
 * Exportada SÓ para teste.
 *
 * A versão anterior deste código foi para produção com `/^d+$/` no lugar de
 * `/^\d+$/` — uma barra invertida comida pelo script que gerou o arquivo.
 * O teste da época não pegou porque reimplementava a regex em vez de chamar
 * esta função, e assim testava uma cópia correta de um código quebrado.
 */
export { buscarDetalhe as _buscarDetalhe };

async function buscarDetalhe(evento) {
  // A substituição acontece na string CRUA, antes de parsear.
  //
  // `new URL()` percent-encoda as chaves — `{idMember}` vira
  // `%7BidMember%7D` — e aí uma regex procurando `{` no `pathname` nunca
  // casa. A primeira versão disto fazia exatamente isso e deixava o
  // placeholder passar direto para o fetch, que voltava 404.
  //
  // Trocar antes de parsear é seguro porque o valor é validado como só
  // dígitos: não há como injetar `://`, `@` ou outro host. A conferência
  // de host continua depois, sobre a URL final.
  let bruto = String(evento.api_callback || '');

  if (/\{[^}]+\}/.test(bruto)) {
    const id = String(evento.id_record ?? '');
    if (!/^\d+$/.test(id)) {
      throw new Error(
        `ApiCallback tem placeholder (${bruto}) e o IdRecord não é utilizável — ignorado`
      );
    }
    bruto = bruto.replace(/\{[^}]+\}/g, id);
    logger.debug(`[evo-sync] Placeholder do ApiCallback resolvido pelo IdRecord: ${bruto}`);
  }

  const url = new URL(bruto);

  if (!config.evo.callbackHosts.includes(url.host)) {
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
 * Reconcilia o funil com as conversões registradas no EVO.
 *
 * Existe porque o EVO **não emite evento de mudança de prospect**, e
 * porque webhook é entrega best-effort: se `CreateMember` se perder numa
 * instabilidade, o lead nunca fecha como ganho. Este poller é a rede de
 * segurança daquilo que o webhook entrega em tempo real.
 *
 * Não cria lead para prospect que nunca passou pelo WhatsApp — o funil é
 * do que a Leia e o painel tocam, não uma cópia da base inteira do EVO.
 *
 * ## Por que UMA consulta, e não uma por lead
 *
 * Até 12/09/2026 este poller fazia `buscarProspectPorId` para cada lead
 * aberto com vínculo no EVO. Com 27 leads e ciclo de 15 min, eram
 * **2.592 requisições por dia** — 75% de todo o consumo da conta, para
 * uma resposta que era `{convertidos: 0, atualizados: 0}` na esmagadora
 * maioria dos ciclos.
 *
 * A pergunta certa não é "o que houve com cada um dos meus 27?", e sim
 * "quem converteu desde a última vez?" — e essa o EVO responde de uma vez,
 * com `conversionDateStart`. O cruzamento com os leads locais é feito
 * aqui, de graça. Mesma detecção, 1 requisição em vez de 27.
 *
 * ## O que foi removido junto, e por quê
 *
 * O ramo que copiava `currentStep`/`temperature` para `metadata`. Os dois
 * campos vêm vazios em toda a base — conferido em 12/09/2026 numa amostra
 * de convertidos: `currentStep: null` e `temperature: "0"` ou `""`. Era o
 * lado caro do poller (exigia ler prospect a prospect) sustentando um
 * dado que nunca chegou a existir. Se a academia começar a preencher, o
 * caminho de volta é uma consulta própria, não 2.592 requisições por dia.
 *
 * ⚠️ Este poller nunca detectou aula marcada no balcão, apesar do que o
 * comentário antigo sugeria: ele só lia campos do prospect, nunca as
 * matrículas em aula. Quem cobre isso é o webhook `ActivityEnroll` — que
 * está assinado e ainda não recebeu nenhum evento. Enquanto esse teste
 * não for feito, essa lacuna existe, e existia igual antes desta mudança.
 */
export async function sincronizarProspects({ dias = 30 } = {}) {
  const inicio = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const resumo = { lidos: 0, atualizados: 0, convertidos: 0, erros: 0 };

  try {
    // Só olhamos leads que já têm vínculo com o EVO: são os únicos que
    // podem ter convertido lá e importar aqui.
    const { data: leads } = await supabase
      .from('crm_leads')
      .select('id, evo_id_prospect, evo_id_member, stage, full_name')
      .not('evo_id_prospect', 'is', null)
      .not('stage', 'in', FILTRO_ETAPAS_FECHADAS)
      .limit(500);

    // Sem lead vinculado aberto não há o que reconciliar — e aí nem a
    // consulta ao EVO precisa sair. É o caso comum de madrugada.
    if (!leads?.length) {
      logger.info('[evo-sync] Poll de prospects: nenhum lead vinculado aberto — nada a consultar');
      return resumo;
    }

    // A janela é generosa (30 dias) de propósito: ela é o que faz o poller
    // recuperar o que se perdeu enquanto o serviço esteve fora do ar. Cabe
    // numa página — foram 38 conversões em 30 dias quando isto foi medido.
    // A paginação existe para o mês que crescer, com teto para a consulta
    // barata não virar cara de novo sem ninguém notar.
    const convertidos = [];
    for (let pagina = 0; pagina < 3; pagina++) {
      const lote = await evoClient.buscarProspects({
        conversionDateStart: inicio,
        take: 50,
        skip: pagina * 50,
      });
      convertidos.push(...lote);
      if (lote.length < 50) break;
    }

    resumo.lidos = convertidos.length;

    const porProspect = new Map(
      convertidos.filter(p => p?.idProspect).map(p => [String(p.idProspect), p])
    );

    for (const lead of leads) {
      try {
        const p = porProspect.get(String(lead.evo_id_prospect));
        if (!p?.idMember || lead.evo_id_member) continue;

        // A conversão não diz o valor. Se a venda já chegou pelo webhook,
        // ele está guardado lá; se ainda não chegou, a venda completa o
        // valor quando chegar (vendas.js, ação `completar`).
        const venda = await vendaGuardadaDoMembro(p.idMember);

        await mudarEtapa(lead, 'ganho', {
          actor: 'evo-poll',
          motivo: 'Oportunidade convertida em aluno dentro do EVO' +
            (venda ? `: ${venda.planos.join(', ')}` : ''),
          campos: {
            evo_id_member: p.idMember,
            evo_sync: 'sincronizado',
            sale_at: p.conversionDate || new Date().toISOString(),
            ...(venda && { sale_value: venda.valor, evo_id_sale: venda.idSale }),
          },
          payload: { idMember: p.idMember, conversionDate: p.conversionDate, idSale: venda?.idSale ?? null },
        });
        // A venda ficou registrada sem atendimento quando chegou — o webhook
        // não sabia de quem era. Agora sabe.
        if (venda) await vincularVendaAoLead(venda.idSale, lead);
        resumo.convertidos++;
      } catch (err) {
        resumo.erros++;
        logger.warn(`[evo-sync] Reconciliação do lead ${lead.id} falhou: ${err.message}`);
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

  // `lidos` mudou de significado com a consulta em lote: antes era "leads
  // que eu perguntei um a um", agora é "conversões que o EVO devolveu na
  // janela". A linha diz as duas coisas para o número não ser lido com a
  // régua antiga — e para o custo ficar visível no próprio log.
  logger.info(
    `[evo-sync] Poll de prospects: ${resumo.convertidos} conversão(ões) reconciliada(s) ` +
    `de ${resumo.lidos} na janela de ${dias}d` +
    (resumo.erros ? `, ${resumo.erros} erro(s)` : '')
  );
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
          'O EVO recusou o cadastro do webhook com 403: o token não tem permissão ' +
          'de POST em /api/v1/webhook. Não é a credencial — a leitura funciona. ' +
          'A permissão é por endpoint e você mesmo habilita, no EVO em ' +
          'Configurações → Integrações: expanda a chave e marque POST /api/v1/webhook. ' +
          'Aproveite e marque também POST /api/v2/sales e ' +
          'POST /api/v1/notifications/prospect, que estão bloqueados pelo mesmo motivo. ' +
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
  sincronizarProspects, registrarWebhooks, procurarAulasVendidas, conferirAulaNoEvo,
};
