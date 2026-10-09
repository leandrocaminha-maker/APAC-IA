/**
 * src/services/acompanhamento/envio.js
 * O envio real da régua do acompanhamento (etapa A5c).
 *
 * A rodada do dia (`ensaio.js`, no modo envio) decide e grava cada mensagem
 * como 'pendente', com a hora prevista. Aqui, no ciclo curto do worker, o
 * que chegou à hora sai — depois de reconferir o mundo, porque entre a
 * rodada e a hora muita coisa muda (§5.4 do plano):
 *
 *   não sai (cancelado)  o aluno pausou ou saiu; o número foi suprimido;
 *                        há encaminhamento aberto com o professor
 *   fica para outro dia  um consultor está na conversa; o aluno escreveu
 *   (cancelado)          nas últimas 24 h — a rodada de amanhã decide de novo
 *   espera               fora da janela de contato
 *   não sai hoje         sub-teto do acompanhamento (D5) ou teto do número
 *
 * A mensagem sai como `bot:acompanhamento` — conta no teto do número
 * (limite-envio.js) e abre a rodada de trocas da Leia (conversa.js). Entre
 * uma e outra, uma pausa de 20 a 40 s: número Baileys não manda rajada.
 *
 * ## Desligado na fase de teste
 *
 * Só roda com `ACOMPANHAMENTO_DRY_RUN=false` — decisão do responsável em
 * 08/10/2026: o envio fica pronto e desligado até ele declarar o início.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { dentroDaJanela } from '../followup.js';
import { estaSuprimido, hojeSP } from '../campanhas.js';
import { limiteEnvio } from '../limite-envio.js';
import { SENT_BY_REGUA } from './conversa.js';

const DIA_MS = 86_400_000;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Por que esta mensagem não sai agora — ou null, se sai. PURO: recebe o
 * que se leu do mundo.
 */
export function motivoParaNaoSair({ inscricao, suprimido, conversaHumana, escreveuEm24h, encaminhamentoAberto }) {
  if (!inscricao || inscricao.status !== 'ativa') return 'O aluno não está ativo no WhatsApp (pausou ou saiu).';
  if (suprimido) return 'Número suprimido: pediu para sair.';
  if (encaminhamentoAberto) return 'Há encaminhamento aberto com o professor.';
  if (conversaHumana) return 'Um consultor está na conversa: fica para outro dia.';
  if (escreveuEm24h) return 'O aluno escreveu nas últimas 24 h: fica para outro dia.';
  return null;
}

async function lerMundo(disparo, agora) {
  const { data: inscricao } = await supabase.from('acomp_inscricoes').select('*')
    .eq('cliente_id', disparo.cliente_id).in('status', ['ativa', 'pausada']).maybeSingle();
  if (!inscricao) return { inscricao: null };
  const [{ data: contato }, { data: aberto }, suprimido] = await Promise.all([
    supabase.from('wa_contacts').select('id').eq('phone', inscricao.phone).maybeSingle(),
    supabase.from('acomp_encaminhamentos').select('id').eq('cliente_id', disparo.cliente_id)
      .in('status', ['aguardando', 'na_fila']).limit(1).maybeSingle(),
    estaSuprimido(inscricao.phone),
  ]);
  let conversaHumana = false, escreveuEm24h = false;
  if (contato) {
    const desde = new Date(agora.getTime() - DIA_MS).toISOString();
    const [{ data: humana }, { data: escreveu }] = await Promise.all([
      supabase.from('wa_conversations').select('id').eq('contact_id', contato.id).eq('status', 'human').limit(1).maybeSingle(),
      supabase.from('wa_messages').select('id').eq('contact_id', contato.id).eq('direction', 'inbound')
        .gte('created_at', desde).limit(1).maybeSingle(),
    ]);
    conversaHumana = !!humana;
    escreveuEm24h = !!escreveu;
  }
  return { inscricao, suprimido, conversaHumana, escreveuEm24h, encaminhamentoAberto: !!aberto };
}

async function marcar(disparo, status, motivo = null) {
  await supabase.from('acomp_disparos').update({
    status, ...(motivo ? { bloqueios: [...(disparo.bloqueios ?? []), motivo] } : {}),
  }).eq('id', disparo.id);
}

/**
 * Manda o que chegou à hora. Chamado pelo worker a cada poucos minutos.
 * @returns {Promise<number>} quantas saíram
 */
export async function enviarDisparos({ agora = new Date() } = {}) {
  if (config.acompanhamento.dryRun) return 0;
  const hoje = hojeSP(agora);

  // O que ficou pendente de um dia que passou não sai mais: a rodada de hoje decide de novo.
  await supabase.from('acomp_disparos').update({ status: 'cancelado' })
    .eq('modo', 'envio').eq('status', 'pendente').lt('dia', hoje);

  const { data: pendentes, error } = await supabase.from('acomp_disparos').select('*')
    .eq('modo', 'envio').eq('status', 'pendente').eq('dia', hoje).lte('previsto_para', agora.toISOString())
    .order('previsto_para', { ascending: true });
  if (error) {
    if (error.code !== 'PGRST205') logger.warn('[acompanhamento] Pendentes não lidos:', error.message);
    return 0;
  }
  if (!pendentes?.length) return 0;
  // Fora da janela de contato, espera: a hora prevista já cai dentro dela.
  if (dentroDaJanela(agora).getTime() !== agora.getTime()) return 0;

  const teto = config.acompanhamento.tetoDiario;
  const { count: jaHoje } = await supabase.from('acomp_disparos').select('id', { count: 'exact', head: true })
    .eq('modo', 'envio').eq('status', 'enviado').eq('dia', hoje);
  let enviadosHoje = jaHoje ?? 0;
  let enviados = 0;

  for (const disparo of pendentes) {
    try {
      const mundo = await lerMundo(disparo, new Date());
      const motivo = motivoParaNaoSair(mundo);
      if (motivo) { await marcar(disparo, 'cancelado', motivo); continue; }
      if (teto > 0 && enviadosHoje >= teto) {
        await marcar(disparo, 'cancelado', `Sub-teto do acompanhamento atingido (${teto} por dia).`);
        continue;
      }
      const cota = await limiteEnvio.podeIniciarConversa();
      if (!cota.ok) { await marcar(disparo, 'cancelado', `Teto do número: ${cota.motivo}.`); continue; }

      if (enviados > 0) await esperar(20_000 + Math.random() * 20_000);
      const { inscricao } = mundo;
      const contato = await getOrCreateContact(inscricao.phone, null);
      const conversa = await getOrCreateConversation(contato.id);
      const r = await sendText(inscricao.phone, disparo.texto);
      await saveMessage({
        conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: disparo.texto,
        contentType: 'text', sentBy: SENT_BY_REGUA, evolutionMsgId: r?.key?.id || null, status: 'sent',
        metadata: { acompanhamento: 'regua', disparo: disparo.id, situacao: disparo.situacao, modelo: disparo.modelo_id },
      });
      await marcar(disparo, 'enviado');
      enviados++;
      enviadosHoje++;
      logger.info(`[acompanhamento] Enviada: ${disparo.situacao} para o cliente ${disparo.cliente_id}`);
    } catch (err) {
      logger.error(`[acompanhamento] Disparo ${disparo.id} falhou: ${err.message}`);
      await marcar(disparo, 'falhou', `Falha no envio: ${err.message}`).catch(() => {});
    }
  }
  return enviados;
}
