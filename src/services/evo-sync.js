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
  FILTRO_ETAPAS_FECHADAS,
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
 *   NewSale / RecurrentSale → alguém comprou. Fecha o lead como ganho.
 *   CreateMember            → prospect virou aluno. Vincula o idMember.
 *   CreateMembership        → contrato criado. Fecha como ganho.
 *   ActivityEnroll          → matrícula em aula, que é como a experimental
 *                             agendada pelo consultor aparece.
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
 * ## A ordem aqui é de custo
 *
 * Casar o lead é de graça (Supabase). Só depois de existir lead E de ele
 * ainda não saber da aula é que sai a consulta ao EVO — a venda não diz
 * QUANDO é a aula, só que ela foi vendida, e sem hora não há lembrete.
 * Assim o evento do prospect que nunca passou pelo WhatsApp, e o da aula
 * que a própria Leia acabou de marcar, não custam requisição nenhuma.
 */
async function aoVerExperimentalNaVenda(detalhe, evento) {
  const idMember = detalhe?.idMember ?? detalhe?.IdMember ?? null;
  const idProspect = detalhe?.idProspect ?? detalhe?.IdProspect ?? null;

  let lead = idMember ? await leadPorMembro(idMember) : null;
  if (!lead && idProspect) lead = await leadPorProspect(idProspect);

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

  const hoje = new Date().toISOString().slice(0, 10);
  const ate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const sessoes = await evoClient
    .sessoesDaPessoa({ idProspect, idMember, de: hoje, ate })
    .catch(err => {
      logger.warn(`[evo-sync] Não deu para ler as sessões do lead ${lead.id}: ${err.message}`);
      return [];
    });

  // A mais próxima: o EVO devolve a agenda da pessoa na janela, e a venda
  // que acabou de chegar é a da aula que ainda vai acontecer.
  const sessao = sessoes
    .filter(s => s?.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date))[0];

  if (!sessao) {
    logger.warn(
      `[evo-sync] Venda ${evento.id_record} é de aula experimental do lead ${lead.id}, ` +
      'mas o EVO não devolveu a sessão — lead não movido, porque sem a hora não há lembrete'
    );
    return lead;
  }

  const dataHora = `${String(sessao.date).slice(0, 10)} ${String(sessao.startTime || '00:00').slice(0, 5)}`;
  const atividade = sessao.activitieName || sessao.activityName || null;

  // `somenteAvanco` protege o retrocesso de etapa, mas NÃO descarta a
  // atualização: `mudarEtapa` grava `campos` mesmo quando bloqueia a etapa
  // (ver funil.js). É o que faz a SEGUNDA experimental funcionar — quem
  // está em `experimental_realizada` e marca outra no balcão continua
  // nessa etapa, com a ficha e a régua apontando para a aula nova. A etapa
  // não volta atrás, e a pessoa recebe lembrete e conversa pós-aula igual.
  const atualizado = await mudarEtapa(lead, 'experimental_agendada', {
    actor: 'evo-webhook',
    somenteAvanco: true,
    motivo: `Aula experimental de ${atividade || 'atividade'} marcada no EVO para ${dataHora}`,
    campos: {
      experimental_at: paraISO(dataHora),
      experimental_status: 'agendada',
      experimental_activity: atividade,
    },
    payload: { idSale: evento.id_record, sessao },
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
  return atualizado || lead;
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
 * Item com `idMembership` é plano, e plano é venda de verdade sempre.
 *
 * Venda SEM itens não conta como experimental: não dá para afirmar nada, e
 * o padrão seguro aí é seguir o fluxo normal de venda.
 */
export { ehSomenteExperimental as _ehSomenteExperimental };

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
  sincronizarProspects, registrarWebhooks,
};
