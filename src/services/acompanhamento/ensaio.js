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
 * 2. Para cada aluno, a régua (`regua.js`, pura) decide a situação do dia,
 *    o modelo e o texto — ou por que nada sai.
 * 3. Põe hora em cada mensagem: perto do começo do período preferido,
 *    dentro da janela de contato do dia (a mesma do follow-up de venda).
 * 4. Aplica o sub-teto do acompanhamento (D5): eventos antes da rotina, e
 *    o que passar do teto fica "bloqueado", com o motivo.
 * 5. Grava uma linha por aluno em `acomp_disparos` e carimba o resumo em
 *    `crm_controle` ('acomp:ensaio').
 *
 * Domingo não tem janela: a rodada só carimba o dia, e a cadência de quem
 * vencia nele anda para segunda.
 *
 * ## Por que não envia
 *
 * Esta é a etapa A2 do plano do acompanhamento: ler uma semana de prévia
 * antes de a régua falar com alguém. Não há chamada à Evolution neste
 * arquivo nem fila — o envio real é outra etapa, com outro código.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { janelaDoDia } from '../followup.js';
import { hojeSP } from '../campanhas.js';
import { buscarFichas, buscarModelos } from './prescrev.js';
import { PRIORIDADE, decidir, horaPrevista } from './regua.js';

const MODO = 'ensaio';
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

/** As mensagens que contam para a cadência: no ensaio, as simuladas antes de hoje. */
async function historicoDe(ids, hoje) {
  const linhas = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from('acomp_disparos')
      .select('cliente_id, dia, situacao, modelo_id, valores')
      .in('cliente_id', ids.slice(i, i + 150))
      .eq('modo', MODO).eq('status', 'simulado').lt('dia', hoje);
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
  const resumo = { dia: hoje, origem, rodado_em: agora.toISOString(), modo: MODO };

  const janela = janelaDoDia(agora);
  if (!janela) {
    Object.assign(resumo, { sem_janela: true, contagem: {} });
    await carimbarMarcador(MARCA_ENSAIO, resumo);
    return resumo;
  }

  const { fichas, fonte, semFicha } = await carregarFichas();
  const { modelos, fonte: fonteModelos } = await carregarModelos();
  const historico = await historicoDe(fichas.map(f => f.cliente_id), hoje);
  const avisos = await avisosSemPresenca();

  const decisoes = fichas.map(ficha => {
    const d = decidir({
      ficha, modelos, hoje, modo: MODO,
      historico: historico.filter(h => h.cliente_id === ficha.cliente_id),
      sinais: avisos.get(Number(ficha.aluno?.evo_id)) ?? [],
    });
    const previsto = d.status === 'simulado' ? horaPrevista(ficha, hoje, janela) : null;
    return { ficha, d, previsto };
  });

  // Sub-teto do dia (D5): eventos antes da rotina, e dentro da mesma
  // prioridade, quem sai mais cedo.
  const teto = config.acompanhamento.tetoDiario;
  decisoes
    .filter(x => x.d.status === 'simulado')
    .sort((a, b) => (PRIORIDADE[a.d.situacao] - PRIORIDADE[b.d.situacao]) || (a.previsto - b.previsto))
    .forEach((x, i) => {
      if (teto > 0 && i >= teto) {
        x.d = { ...x.d, status: 'bloqueado', bloqueios: [...x.d.bloqueios, `Sub-teto do acompanhamento atingido (${teto} por dia).`] };
        x.previsto = null;
      }
    });

  const linhas = decisoes.map(({ ficha, d, previsto }) => ({
    cliente_id: ficha.cliente_id,
    dia: hoje,
    modo: MODO,
    status: d.status,
    situacao: d.situacao,
    trilha: d.trilha,
    modelo_id: d.modelo_id,
    texto: d.texto,
    valores: d.valores,
    motivo: d.motivo,
    bloqueios: d.bloqueios,
    previsto_para: previsto ? previsto.toISOString() : null,
  }));
  if (linhas.length) {
    const { error } = await supabase.from('acomp_disparos').upsert(linhas, { onConflict: 'cliente_id,dia,modo' });
    if (error) throw new Error(`acomp_disparos: ${error.message}`);
  }

  const limite = new Date(Date.parse(hoje) - NADA_DURA_DIAS * 86_400_000).toISOString().slice(0, 10);
  await supabase.from('acomp_disparos').delete().eq('status', 'nada').lt('dia', limite);

  const contagem = {};
  for (const l of linhas) contagem[l.status] = (contagem[l.status] ?? 0) + 1;
  Object.assign(resumo, {
    fichas: fichas.length, sem_ficha: semFicha, fonte_fichas: fonte, fonte_modelos: fonteModelos, contagem,
    avisos_sem_presenca: [...avisos.values()].reduce((n, l) => n + l.length, 0),
  });
  await carimbarMarcador(MARCA_ENSAIO, resumo);
  logger.info(`[acompanhamento] Ensaio de ${hoje}: ${fichas.length} ficha(s) — ${JSON.stringify(contagem)}`);
  return resumo;
}

/** A última rodada, para o worker saber se o dia já rodou e o painel mostrar. */
export async function ultimaRodada() {
  return lerMarcador(MARCA_ENSAIO);
}
