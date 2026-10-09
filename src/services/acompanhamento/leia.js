/**
 * src/services/acompanhamento/leia.js
 * A Leia do acompanhamento no WhatsApp de verdade (etapa A5).
 *
 * ## A porta (§6.1 do plano)
 *
 * Quem tem inscrição ativa ou pausada cai na Leia do acompanhamento quando a
 * conversa é do acompanhamento: mensagem dele (régua, aceite ou a própria
 * Leia) nos últimos 7 dias, ou encaminhamento aberto. Fora disso, segue para
 * a Leia de vendas — que passa a saber que é aluno em acompanhamento, para
 * não o tratar como lead. O roteamento lê o estado, e não o `sent_by` da
 * última mensagem.
 *
 * ## As ferramentas valem
 *
 * Diferente do simulador: a pausa grava na inscrição, a transferência chama
 * o consultor (o webhook faz o handoff), e o encaminhamento abre — como
 * 'simulado' enquanto `ACOMPANHAMENTO_ENCAMINHAMENTOS_REAIS` estiver
 * desligado, que é a fase de teste (decisão de 08/10/2026). O desfecho de
 * cada turno vai na mensagem (metadata), para a calibração (A6).
 */
import { supabase } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { hojeSP } from '../campanhas.js';
import { historicoDaConversa, processarAcompanhamento } from '../ai-agent.js';
import { buscarEquipe } from './prescrev.js';
import { primeiroNome } from './render.js';
import { destinoDoAluno } from './comandos.js';
import { professorHoje } from './horario.js';
import { registrarDaLeia } from './encaminhamentos.js';
import { inscricaoDoNumero } from './ativacao.js';
import { CATEGORIAS, DESFECHOS } from './ferramentas.js';
import { ABRE_RODADA, SENT_BY_LEIA, contextoDoAluno, trocaAtual } from './conversa.js';

const JANELA_DA_CONVERSA_MS = 7 * 86_400_000;
const ABERTOS = ['simulado', 'na_fila', 'aguardando'];
const evento = (evento, detalhe = null) => ({ em: new Date().toISOString(), evento, detalhe });
const ddmm = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

async function fichaDo(clienteId) {
  const { data } = await supabase.from('acomp_fichas').select('ficha').eq('cliente_id', clienteId).maybeSingle();
  return data?.ficha ?? null;
}

async function treinosDo(clienteId) {
  const { data } = await supabase.from('acomp_treinos').select('treinos').eq('cliente_id', clienteId).maybeSingle();
  return data?.treinos ?? [];
}

async function encaminhamentoAbertoDo(clienteId) {
  const desde = new Date(Date.now() - JANELA_DA_CONVERSA_MS).toISOString();
  const { data } = await supabase.from('acomp_encaminhamentos').select('motivo, status, created_at')
    .eq('cliente_id', clienteId).in('status', ABERTOS).gte('created_at', desde)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data;
}

/**
 * Para qual Leia vai esta mensagem.
 * @returns {Promise<null | { caminho: 'acompanhamento'|'vendas', inscricao: object, ficha: object|null, aluno: object|null }>}
 *   null = não é aluno do acompanhamento
 */
export async function caminhoDoContato({ phone, contactId }) {
  const inscricao = await inscricaoDoNumero(phone);
  if (!inscricao || !['ativa', 'pausada'].includes(inscricao.status)) return null;
  const ficha = await fichaDo(inscricao.cliente_id);
  const aluno = ficha
    ? { nome: ficha.aluno?.primeiro_nome ?? null, professor: primeiroNome(ficha.marcadores?.professor ?? ficha.professor?.nome ?? '') || null }
    : null;
  if (!ficha) return { caminho: 'vendas', inscricao, ficha, aluno };

  const desde = new Date(Date.now() - JANELA_DA_CONVERSA_MS).toISOString();
  const [{ data: recente }, aberto] = await Promise.all([
    supabase.from('wa_messages').select('id').eq('contact_id', contactId).eq('direction', 'outbound')
      .in('sent_by', [...ABRE_RODADA, SENT_BY_LEIA]).gte('created_at', desde).limit(1).maybeSingle(),
    encaminhamentoAbertoDo(inscricao.cliente_id),
  ]);
  return { caminho: recente || aberto ? 'acompanhamento' : 'vendas', inscricao, ficha, aluno };
}

/** O executor de verdade: cada ferramenta faz o que diz, e registra no turno. */
function executorReal({ ficha, inscricao, phone, treinos, turno }) {
  return async (nome, args) => {
    switch (nome) {
      case 'registrar_desfecho':
        if (!DESFECHOS.includes(args.tipo)) return { success: false, mensagem: `tipo inválido: ${args.tipo}` };
        turno.desfecho = { tipo: args.tipo, resumo: String(args.resumo ?? '').slice(0, 200) };
        return { success: true };
      case 'encaminhar_ao_professor': {
        if (!CATEGORIAS.includes(args.categoria)) return { success: false, mensagem: `categoria inválida: ${args.categoria}` };
        const urgencia = args.urgencia === 'hoje' ? 'hoje' : 'proximos_dias';
        const resumo = String(args.resumo_para_professor ?? '').slice(0, 400);
        try {
          const r = await registrarDaLeia({ ficha, categoria: args.categoria, urgencia, resumo, phoneAluno: phone, treinos, hoje: hojeSP() });
          turno.encaminhamentos.push({ categoria: args.categoria, urgencia, resumo, status: r.status, destinatario: r.destinatario });
          return { success: true, mensagem: 'Encaminhamento aberto. O professor (ou a equipe) fala com o aluno.' };
        } catch (err) {
          logger.error('[acompanhamento] Encaminhamento da Leia não abriu:', err.message);
          turno.encaminhamentos.push({ categoria: args.categoria, urgencia, resumo, status: 'falhou' });
          return { success: false, mensagem: 'Não consegui avisar o professor agora. Diga ao aluno que a equipe vai falar com ele.' };
        }
      }
      case 'pausar_acompanhamento': {
        const ate = /^\d{4}-\d{2}-\d{2}$/.test(String(args.ate ?? '')) ? args.ate : null;
        const motivo = String(args.motivo ?? '').slice(0, 200);
        const { error } = await supabase.from('acomp_inscricoes').update({
          status: 'pausada', pausado_ate: ate,
          historico: [...(inscricao.historico ?? []), evento('pausa pela Leia', [ate ? `até ${ate}` : null, motivo].filter(Boolean).join(' — '))],
        }).eq('id', inscricao.id);
        if (error) return { success: false, mensagem: 'Não consegui pausar agora.' };
        turno.pausa = { ate, motivo };
        return { success: true };
      }
      case 'transferir_para_humano':
        turno.handoff = { motivo: args.motivo, mensagem: args.mensagem };
        return { success: true, action: 'handoff', motivo: args.motivo, mensagem: args.mensagem };
      default:
        return { success: false, mensagem: `Ferramenta "${nome}" não existe neste caminho.` };
    }
  };
}

/**
 * Um turno da Leia do acompanhamento. Quem manda a resposta é o webhook.
 * @returns {Promise<{ text: string|null, semResposta: boolean, handoff: object|null, detalhes: object }>}
 */
export async function responderNoAcompanhamento({ phone, contact, conversation, content, savedIds, rota }) {
  const { inscricao, ficha } = rota;
  const hoje = hojeSP();

  const { data: recentes } = await supabase.from('wa_messages').select('direction, sent_by, content, created_at')
    .eq('contact_id', contact.id).order('created_at', { ascending: false }).limit(60);
  const linhas = (recentes ?? []).reverse();
  const troca = trocaAtual(linhas);
  const regua = [...linhas].reverse().find(m => m.direction === 'outbound' && ABRE_RODADA.includes(m.sent_by));

  const [treinos, aberto, equipe] = await Promise.all([
    treinosDo(inscricao.cliente_id),
    encaminhamentoAbertoDo(inscricao.cliente_id),
    buscarEquipe().catch(() => null),
  ]);
  // Onde o professor está hoje: o horário dele, da lista da equipe. Sem a
  // lista, a linha some — e a Leia não promete nada além do "assim que possível".
  let situacaoDoProfessor;
  if (equipe) {
    const destino = destinoDoAluno({ ficha, treinos, hoje, equipe });
    if (destino) situacaoDoProfessor = professorHoje(equipe.find(m => m.profile_id === destino.profile_id)?.horario ?? null);
  }

  const contexto = contextoDoAluno({
    ficha, hoje, troca, situacaoDoProfessor,
    ultimaDoAcompanhamento: regua ? { texto: regua.content, quando: ddmm(regua.created_at) } : null,
    encaminhamentoAberto: aberto ? { motivo: aberto.motivo, quando: `em ${ddmm(aberto.created_at)}` } : null,
  });

  const turno = { desfecho: null, encaminhamentos: [], pausa: null, handoff: null };
  const historico = await historicoDaConversa(conversation.id, { excludeMessageIds: savedIds });
  const r = await processarAcompanhamento({
    mensagem: content, historico, contexto, conversationId: conversation.id, origem: 'acompanhamento',
    executar: executorReal({ ficha, inscricao, phone, treinos, turno }),
  });
  if (r.semResposta && !turno.desfecho) turno.desfecho = { tipo: 'outro', resumo: 'papo depois do limite: sem resposta' };

  const detalhes = {
    troca: troca.troca, limite: troca.limiteAtingido, semResposta: r.semResposta, desfecho: turno.desfecho,
    encaminhamentos: turno.encaminhamentos, pausa: turno.pausa, handoff: turno.handoff, ferramentas: r.ferramentas,
  };
  if (r.semResposta && savedIds?.length) {
    // Nada sai; o desfecho fica na mensagem do aluno.
    const id = savedIds[savedIds.length - 1];
    const { data: msg } = await supabase.from('wa_messages').select('metadata').eq('id', id).maybeSingle();
    await supabase.from('wa_messages').update({ metadata: { ...(msg?.metadata ?? {}), acompanhamento: detalhes } }).eq('id', id);
  }
  logger.info(`[acompanhamento] Leia: ${ficha.aluno?.primeiro_nome} troca ${troca.troca} → ${turno.desfecho?.tipo ?? 'sem desfecho'}`
    + (turno.encaminhamentos.length ? ` · encaminhou (${turno.encaminhamentos.map(e => e.status).join(', ')})` : ''));
  return { text: r.text, semResposta: r.semResposta, handoff: r.handoff, detalhes };
}
