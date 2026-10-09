/**
 * src/services/acompanhamento/ensaio.js
 * O ensaio do dia: a régua do acompanhamento rodada sobre todos os alunos,
 * gravada, e nada enviado.
 *
 * ## O que acontece numa rodada
 *
 * 1. Busca as fichas e os modelos no Prescrev. Se ele não responder, roda
 *    sobre a última cópia (`acomp_fichas`, e os modelos em `crm_controle`)
 *    e diz isso no resumo.
 * 2. Lê o treino de musculação de cada aluno no EVO — uma chamada por aluno
 *    por dia; rodar de novo no mesmo dia reaproveita a leitura
 *    (`acomp_treinos`), e se o EVO falhar vale a última.
 * 3. Para cada aluno, a régua (`regua.js`, pura) decide a situação do dia,
 *    o modelo e o texto — ou por que nada sai — e o que iria à equipe.
 * 4. Põe hora em cada mensagem: perto do começo do período preferido,
 *    dentro da janela de contato do dia (a mesma do follow-up de venda).
 * 5. Aplica o sub-teto do acompanhamento (D5): eventos antes da rotina, e
 *    o que passar do teto fica "bloqueado", com o motivo.
 * 6. Grava uma linha por aluno em `acomp_disparos` e carimba o resumo em
 *    `crm_controle` ('acomp:ensaio').
 *
 * Domingo não tem janela: a rodada só carimba o dia, e a cadência de quem
 * vencia nele anda para segunda.
 *
 * ## Ensaio e envio (A5)
 *
 * Com `ACOMPANHAMENTO_DRY_RUN` ligado (o padrão, a fase de teste), a rodada
 * é ENSAIO: grava o que sairia ('simulado'), para todos com ficha completa, e
 * anota quem ainda não ativou o WhatsApp. Desligado, é ENVIO: só quem tem
 * inscrição ativa, o histórico é o do que saiu de fato ('enviado'), a linha
 * nasce 'pendente' com a hora prevista, e quem manda é `envio.js`, no ciclo
 * curto do worker, reconferindo tudo antes de cada mensagem. Este arquivo
 * continua sem chamar a Evolution. No envio entram também o freio das três
 * sem resposta (§5.4) e a volta de quem pausou até uma data que passou.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { janelaDoDia } from '../followup.js';
import { hojeSP } from '../campanhas.js';
import { evoClient } from '../evo-client.js';
import { buscarEquipe, buscarFichas, buscarModelos } from './prescrev.js';
import { equipeAtivada, registrarDaRegua } from './encaminhamentos.js';
import { PRIORIDADE, decidir, horaPrevista, leituraDaAgenda, resumirTreinos } from './regua.js';
import { SENT_BY_REGUA } from './conversa.js';

/** Ensaio enquanto ACOMPANHAMENTO_DRY_RUN não for false. */
export const modoAtual = () => (config.acompanhamento.dryRun ? 'ensaio' : 'envio');
const MARCA_ENSAIO = 'acomp:ensaio';
const MARCA_MODELOS = 'acomp:modelos';

/** Quantos dias as linhas "nada" ficam — elas explicam o dia, e não contam para nada. */
const NADA_DURA_DIAS = 14;

async function carregarFichas() {
  try {
    const { fichas, sem_ficha } = await buscarFichas();
    const agora = new Date().toISOString();
    if (fichas.length) {
      const { error } = await supabase.from('acomp_fichas').upsert(
        fichas.map(f => ({ cliente_id: f.cliente_id, ficha: f, atualizada_em: f.atualizada_em, recebida_em: agora })),
        { onConflict: 'cliente_id' });
      if (error) throw new Error(`acomp_fichas: ${error.message}`);
    }
    // A ficha que deixou de vir (o Prescrev a tirou da lista) sai da cópia:
    // a régua não fala com quem o Prescrev deixou de acompanhar.
    const fora = supabase.from('acomp_fichas').delete();
    const { error: errFora } = fichas.length
      ? await fora.not('cliente_id', 'in', `(${fichas.map(f => f.cliente_id).join(',')})`)
      : await fora.gte('recebida_em', '1970-01-01');
    if (errFora) logger.warn('[acompanhamento] Não deu para limpar fichas antigas:', errFora.message);
    return { fichas, fonte: 'prescrev', semFicha: sem_ficha };
  } catch (err) {
    logger.warn('[acompanhamento] Prescrev não respondeu às fichas — rodando sobre a cópia:', err.message);
    const { data, error } = await supabase.from('acomp_fichas').select('ficha, recebida_em');
    if (error) throw new Error(`acomp_fichas: ${error.message}`);
    const quando = (data ?? []).map(x => x.recebida_em).sort().at(-1);
    return { fichas: (data ?? []).map(x => x.ficha), fonte: `cópia de ${quando ?? '—'} (${err.message})`, semFicha: null };
  }
}

async function carregarModelos() {
  try {
    const modelos = await buscarModelos();
    await carimbarMarcador(MARCA_MODELOS, modelos);
    return { modelos: modelos.modelos, fonte: 'prescrev' };
  } catch (err) {
    logger.warn('[acompanhamento] Prescrev não respondeu aos modelos — usando a cópia:', err.message);
    const marca = await lerMarcador(MARCA_MODELOS);
    if (!marca?.valor?.modelos) throw new Error(`Sem modelos: o Prescrev não respondeu e não há cópia (${err.message})`);
    return { modelos: marca.valor.modelos, fonte: `cópia de ${marca.quando.toISOString()} (${err.message})` };
  }
}

/** O tipo do evento da automação "Sem presença" do CRM do EVO (§4.2 do plano). */
export const EVENTO_SEM_PRESENCA = 'crm.automation.no_attendance';

/**
 * Os avisos "Sem presença" da última semana, por id de membro do EVO. Vêm
 * crus de `crm_evo_webhook_events`, onde o /webhook/evo guarda todo evento.
 * `dias` é o `daysOffset`; 0 ou ausente vira null — o da segmentação vinha
 * 0, e o que ele significa aqui se confere com um aluno conhecido (§9.3).
 */
async function avisosSemPresenca() {
  const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await supabase.from('crm_evo_webhook_events')
    .select('payload, created_at').eq('event_type', EVENTO_SEM_PRESENCA).gte('created_at', desde);
  if (error) throw new Error(`crm_evo_webhook_events: ${error.message}`);
  const porMembro = new Map();
  for (const { payload, created_at } of data ?? []) {
    const id = Number(payload?.person?.idMember);
    if (!Number.isInteger(id)) continue;
    const dias = Number(payload?.eventContext?.daysOffset);
    const aviso = { dia: hojeSP(new Date(payload?.eventDate ?? created_at)), dias: dias > 0 ? dias : null };
    porMembro.set(id, [...(porMembro.get(id) ?? []), aviso]);
  }
  return porMembro;
}

/**
 * Os treinos de musculação de cada aluno, por cliente do Prescrev. Uma
 * chamada ao EVO por aluno por dia: a leitura de hoje já gravada em
 * `acomp_treinos` é reaproveitada, e se o EVO falhar vale a última que houver.
 * Sem a migration 012, segue sem treino e diz isso no resumo.
 */
async function treinosDosAlunos(fichas, hoje) {
  const porCliente = new Map();
  const { data: guardados, error } = await supabase.from('acomp_treinos').select('cliente_id, treinos, lido_em');
  if (error) return { porCliente, nota: `acomp_treinos indisponível (${error.message})` };
  const guardado = new Map((guardados ?? []).map(g => [g.cliente_id, g]));
  let lidos = 0, falhas = 0;
  for (const ficha of fichas) {
    const idMembro = Number(ficha.aluno?.evo_id);
    if (!Number.isInteger(idMembro)) continue;
    const g = guardado.get(ficha.cliente_id);
    if (g && hojeSP(new Date(g.lido_em)) === hoje) { porCliente.set(ficha.cliente_id, g.treinos); continue; }
    try {
      const treinos = resumirTreinos(await evoClient.treinosDoAluno(idMembro));
      const { error: errGravar } = await supabase.from('acomp_treinos').upsert(
        { cliente_id: ficha.cliente_id, evo_member_id: idMembro, treinos, lido_em: new Date().toISOString() },
        { onConflict: 'cliente_id' });
      if (errGravar) logger.warn('[acompanhamento] Não deu para guardar o treino:', errGravar.message);
      porCliente.set(ficha.cliente_id, treinos);
      lidos++;
    } catch (err) {
      falhas++;
      logger.warn(`[acompanhamento] Treino do membro ${idMembro} não lido: ${err.message}`);
      if (g) porCliente.set(ficha.cliente_id, g.treinos);
    }
  }
  return { porCliente, nota: `${lidos} lido(s) do EVO${falhas ? `, ${falhas} falha(s) (vale a última leitura)` : ''}` };
}

/**
 * As inscrições vivas por aluno (017). Quem pausou até uma data que já
 * passou volta a ativo aqui — a pausa do aluno tem fim quando ele disse.
 */
async function inscricoesDosAlunos(hoje) {
  const porCliente = new Map();
  const { data, error } = await supabase.from('acomp_inscricoes')
    .select('id, cliente_id, phone, contact_id, status, ativado_em, confirmado_em, pausado_ate, historico')
    .in('status', ['ativa', 'pausada']);
  if (error) {
    if (error.code !== 'PGRST205') logger.warn('[acompanhamento] acomp_inscricoes:', error.message);
    return porCliente;
  }
  for (const i of data ?? []) {
    if (i.status === 'pausada' && i.pausado_ate && i.pausado_ate < hoje) {
      await supabase.from('acomp_inscricoes').update({
        status: 'ativa', pausado_ate: null,
        historico: [...(i.historico ?? []), { em: new Date().toISOString(), evento: 'pausa terminou', detalhe: i.pausado_ate }],
      }).eq('id', i.id);
      i.status = 'ativa';
      i.pausado_ate = null;
    }
    porCliente.set(i.cliente_id, {
      ...i, ativadoEm: hojeSP(new Date(i.confirmado_em ?? i.ativado_em)), pausadoAte: i.pausado_ate,
    });
  }
  return porCliente;
}

/**
 * Quantas mensagens da régua seguidas saíram depois da última resposta do
 * aluno e da última presença dele — o freio das três sem resposta (§5.4).
 * Só no envio: no ensaio nada saiu de verdade.
 */
async function semRespostaDe(ficha, inscricao) {
  let contactId = inscricao.contact_id;
  if (!contactId) {
    const { data } = await supabase.from('wa_contacts').select('id').eq('phone', inscricao.phone).maybeSingle();
    contactId = data?.id;
  }
  if (!contactId) return 0;
  const { data } = await supabase.from('wa_messages').select('direction, sent_by, created_at')
    .eq('contact_id', contactId).order('created_at', { ascending: false }).limit(80);
  const linhas = data ?? [];
  const ultimaResposta = linhas.find(m => m.direction === 'inbound')?.created_at ?? null;
  const presenca = leituraDaAgenda(ficha)?.ultimaPresenca ?? null;
  const corte = Math.max(
    ultimaResposta ? Date.parse(ultimaResposta) : 0,
    presenca ? Date.parse(`${presenca}T23:59:59-03:00`) : 0,
  );
  return linhas.filter(m => m.direction === 'outbound' && m.sent_by === SENT_BY_REGUA && Date.parse(m.created_at) > corte).length;
}

/** As mensagens que contam para a cadência: no ensaio, as simuladas; no envio, as que saíram — antes de hoje. */
async function historicoDe(ids, hoje, modo) {
  const linhas = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('acomp_disparos')
      .select('cliente_id, dia, situacao, modelo_id, valores')
      .in('cliente_id', ids.slice(i, i + 150))
      .eq('modo', modo).eq('status', modo === 'ensaio' ? 'simulado' : 'enviado').lt('dia', hoje);
    if (error) throw new Error(`acomp_disparos: ${error.message}`);
    linhas.push(...(data ?? []));
  }
  return linhas;
}

/**
 * Roda o ensaio de hoje e grava. Rodar de novo no mesmo dia refaz as linhas
 * do dia — a régua só olha o histórico de antes de hoje.
 * @returns {Promise<object>} o resumo, também carimbado em crm_controle
 */
export async function rodarEnsaio({ agora = new Date(), origem = 'worker' } = {}) {
  const hoje = hojeSP(agora);
  const modo = modoAtual();
  const resumo = { dia: hoje, origem, rodado_em: agora.toISOString(), modo };

  const janela = janelaDoDia(agora);
  if (!janela) {
    Object.assign(resumo, { sem_janela: true, contagem: {} });
    await carimbarMarcador(MARCA_ENSAIO, resumo);
    return resumo;
  }

  const { fichas, fonte, semFicha } = await carregarFichas();
  const { modelos, fonte: fonteModelos } = await carregarModelos();
  const historico = await historicoDe(fichas.map(f => f.cliente_id), hoje, modo);
  const inscricoes = await inscricoesDosAlunos(hoje);
  const semResposta = new Map();
  if (modo === 'envio') {
    for (const f of fichas) {
      const i = inscricoes.get(f.cliente_id);
      if (i?.status === 'ativa') semResposta.set(f.cliente_id, await semRespostaDe(f, i).catch(() => 0));
    }
  }
  const avisos = await avisosSemPresenca();
  const { porCliente: treinos, nota: notaTreinos } = await treinosDosAlunos(fichas, hoje);

  const decisoes = fichas.map(ficha => {
    const d = decidir({
      ficha, modelos, hoje, modo,
      historico: historico.filter(h => h.cliente_id === ficha.cliente_id),
      sinais: avisos.get(Number(ficha.aluno?.evo_id)) ?? [],
      treinos: treinos.get(ficha.cliente_id) ?? [],
      inscricao: inscricoes.get(ficha.cliente_id) ?? null,
      semResposta: semResposta.get(ficha.cliente_id) ?? 0,
    });
    const sai = d.status === 'simulado' || d.status === 'pendente';
    // No envio, a hora é a maior entre a prevista e a da rodada: rodado às
    // 11h, uma mensagem prevista para as 9h36 sai agora, e não ontem.
    let previsto = sai ? horaPrevista(ficha, hoje, janela) : null;
    if (previsto && modo === 'envio' && previsto < agora) previsto = agora;
    return { ficha, d, previsto };
  });

  // Sub-teto do dia (D5): eventos antes da rotina, e dentro da mesma
  // prioridade, quem sai mais cedo.
  const teto = config.acompanhamento.tetoDiario;
  decisoes
    .filter(x => x.d.status === 'simulado' || x.d.status === 'pendente')
    .sort((a, b) => (PRIORIDADE[a.d.situacao] - PRIORIDADE[b.d.situacao]) || (a.previsto - b.previsto))
    .forEach((x, i) => {
      if (teto > 0 && i >= teto) {
        x.d = { ...x.d, status: 'bloqueado', bloqueios: [...x.d.bloqueios, `Sub-teto do acompanhamento atingido (${teto} por dia).`] };
        x.previsto = null;
      }
    });

  // Freio nas trilhas que não são de adesão: o acompanhamento pausa (a
  // adesão vira aviso à equipe, pelos encaminhamentos abaixo).
  for (const { ficha, d } of decisoes.filter(x => x.d.freio === 'pausa')) {
    const i = inscricoes.get(ficha.cliente_id);
    if (!i) continue;
    await supabase.from('acomp_inscricoes').update({
      status: 'pausada',
      historico: [...(i.historico ?? []), { em: new Date().toISOString(), evento: 'pausa pelo freio', detalhe: d.motivo }],
    }).eq('id', i.id);
  }

  // No envio, a linha de hoje que já saiu (ou que o envio cancelou ou viu
  // falhar) não se refaz: rodar de novo no mesmo dia não manda duas vezes.
  let jaDecididos = new Set();
  if (modo === 'envio') {
    const { data: feitos } = await supabase.from('acomp_disparos').select('cliente_id')
      .eq('modo', 'envio').eq('dia', hoje).in('status', ['enviado', 'cancelado', 'falhou']);
    jaDecididos = new Set((feitos ?? []).map(f => f.cliente_id));
  }

  const linhas = decisoes.filter(x => !jaDecididos.has(x.ficha.cliente_id)).map(({ ficha, d, previsto }) => ({
    cliente_id: ficha.cliente_id,
    dia: hoje,
    modo,
    status: d.status,
    situacao: d.situacao,
    trilha: d.trilha,
    modelo_id: d.modelo_id,
    texto: d.texto,
    valores: d.valores,
    motivo: d.motivo,
    bloqueios: d.bloqueios,
    avisos_equipe: (d.avisos_equipe ?? []).map(a => a.texto),
    previsto_para: previsto ? previsto.toISOString() : null,
  }));
  if (linhas.length) {
    const { error } = await supabase.from('acomp_disparos').upsert(linhas, { onConflict: 'cliente_id,dia,modo' });
    if (error) throw new Error(`acomp_disparos: ${error.message}`);
  }

  // Os avisos à equipe viram encaminhamentos — em ensaio, abertos e não
  // enviados (decisão do responsável em 08/10/2026). Sem a 015, ou sem a
  // lista da equipe, segue sem abrir e diz isso no resumo.
  let notaEncaminhamentos;
  try {
    const comAviso = decisoes.filter(x => x.d.avisos_equipe?.length);
    if (comAviso.length) {
      const [equipe, ativos] = await Promise.all([buscarEquipe(), equipeAtivada()]);
      let novos = 0;
      for (const { ficha, d } of comAviso) {
        novos += await registrarDaRegua({
          ficha, avisos: d.avisos_equipe, treinos: treinos.get(ficha.cliente_id) ?? [], hoje, equipe, ativos,
        });
      }
      notaEncaminhamentos = `${novos} aberto(s) em ensaio`;
    }
  } catch (err) {
    logger.warn('[acompanhamento] Encaminhamentos não abertos:', err.message);
    notaEncaminhamentos = `não abertos (${err.message})`;
  }

  const limite = new Date(Date.parse(hoje) - NADA_DURA_DIAS * 86_400_000).toISOString().slice(0, 10);
  await supabase.from('acomp_disparos').delete().eq('status', 'nada').lt('dia', limite);

  const contagem = {};
  for (const l of linhas) contagem[l.status] = (contagem[l.status] ?? 0) + 1;
  Object.assign(resumo, {
    fichas: fichas.length, sem_ficha: semFicha, fonte_fichas: fonte, fonte_modelos: fonteModelos, contagem,
    avisos_sem_presenca: [...avisos.values()].reduce((n, l) => n + l.length, 0),
    treinos: notaTreinos,
    avisos_equipe: linhas.reduce((n, l) => n + l.avisos_equipe.length, 0),
    encaminhamentos: notaEncaminhamentos ?? null,
  });
  await carimbarMarcador(MARCA_ENSAIO, resumo);
  logger.info(`[acompanhamento] ${modo === 'ensaio' ? 'Ensaio' : 'Rodada de envio'} de ${hoje}: ${fichas.length} ficha(s) — ${JSON.stringify(contagem)}`);
  return resumo;
}

/** A última rodada, para o worker saber se o dia já rodou e o painel mostrar. */
export async function ultimaRodada() {
  return lerMarcador(MARCA_ENSAIO);
}
