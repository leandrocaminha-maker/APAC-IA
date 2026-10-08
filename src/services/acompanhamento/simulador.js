/**
 * src/services/acompanhamento/simulador.js
 * O simulador da Leia no acompanhamento, no painel (etapa A3).
 *
 * Quem testa escolhe um aluno com ficha; a conversa começa com a última
 * mensagem que a prévia da régua gerou para ele (`acomp_disparos`), e quem
 * testa escreve como se fosse o aluno. Cada turno passa pelo mesmo caminho
 * que o WhatsApp vai usar (`processarAcompanhamento`), com o executor de
 * SIMULAÇÃO: as ferramentas registram na mensagem o que fariam, e nada é
 * aberto, pausado nem enviado — o encaminhamento simulado não vai à tela do
 * Prescrev, onde apareceria com o nome de um aluno de verdade.
 *
 * O contato é próprio (`teste-acomp-<usuário>`), separado do simulador de
 * vendas: as duas conversas não se misturam. `teste` no telefone e
 * `teste-web` nas tags fazem dele contato de teste em toda guarda do sistema.
 *
 * "SAIR" e "PAUSAR ACOMPANHAMENTO" não passam pela Leia: aqui o simulador
 * diz o que o WhatsApp faria.
 */
import { supabase } from '../../lib/supabase.js';
import { saveMessage } from '../contacts.js';
import { ehPedidoDeSaida, hojeSP } from '../campanhas.js';
import { historicoDaConversa, processarAcompanhamento } from '../ai-agent.js';
import { executorDeSimulacao } from './ferramentas.js';
import {
  SENT_BY_LEIA, SENT_BY_REGUA, TEXTO_PAUSA, contextoDoAluno, ehPedidoDePausa, trocaAtual,
} from './conversa.js';

const CANAL = 'web-test';
const ROTULO_CATEGORIA = {
  dor_ou_lesao: 'dor ou lesão', saude: 'saúde', ajuste_de_treino: 'ajuste de treino',
  ausencia_ou_desanimo: 'ausência ou desânimo', pedido_do_aluno: 'pedido do aluno', outro: 'outro',
};
const ddmm = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

async function contato(usuario) {
  const phone = `teste-acomp-${usuario.id}`;
  const { data: existente } = await supabase.from('wa_contacts').select('*').eq('phone', phone).maybeSingle();
  if (existente) return existente;
  const { data, error } = await supabase.from('wa_contacts').insert({
    phone, name: usuario.nome, is_prospect: false,
    tags: ['teste-web', 'simulador-acomp'], metadata: { origem: 'simulador-acomp', usuario: usuario.email },
  }).select().single();
  if (error) throw new Error(`contato do simulador: ${error.message}`);
  return data;
}

async function conversaAtiva(contactId) {
  const { data } = await supabase.from('wa_conversations').select('*')
    .eq('contact_id', contactId).eq('channel', CANAL).in('status', ['active', 'human'])
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.context?.origem === 'simulador-acomp' ? data : null;
}

async function mensagensDa(conversaId) {
  const { data, error } = await supabase.from('wa_messages')
    .select('id, direction, content, sent_by, metadata, created_at')
    .eq('conversation_id', conversaId).order('created_at', { ascending: true }).limit(300);
  if (error) throw new Error(`mensagens: ${error.message}`);
  return data ?? [];
}

async function fichaDe(clienteId) {
  const { data, error } = await supabase.from('acomp_fichas').select('ficha').eq('cliente_id', clienteId).maybeSingle();
  if (error) throw new Error(`acomp_fichas: ${error.message}`);
  if (!data) throw new Error('Este aluno não tem ficha no acompanhamento.');
  return data.ficha;
}

/** Os alunos com ficha, e se a prévia já gerou mensagem para eles. */
export async function alunosParaSimular() {
  const [{ data: fichas, error }, { data: textos }] = await Promise.all([
    supabase.from('acomp_fichas').select('cliente_id, ficha'),
    supabase.from('acomp_disparos').select('cliente_id').not('texto', 'is', null),
  ]);
  if (error) throw new Error(`acomp_fichas: ${error.message}`);
  const comTexto = new Set((textos ?? []).map(t => t.cliente_id));
  return (fichas ?? [])
    .map(f => ({ cliente_id: f.cliente_id, nome: f.ficha?.aluno?.primeiro_nome ?? '—', temMensagem: comTexto.has(f.cliente_id) }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

function paraTela(m) {
  const de = m.direction === 'inbound' ? 'aluno' : m.sent_by === SENT_BY_REGUA ? 'regua' : 'leia';
  return { de, texto: m.content, em: m.created_at, detalhes: m.metadata?.simulacao ? m.metadata : null };
}

/** A conversa em curso do usuário, se houver. */
export async function sessao(usuario) {
  const c = await contato(usuario);
  const conversa = await conversaAtiva(c.id);
  if (!conversa) return null;
  const ficha = await fichaDe(conversa.context.cliente_id).catch(() => null);
  return {
    cliente_id: conversa.context.cliente_id,
    aluno: ficha?.aluno?.primeiro_nome ?? '—',
    mensagens: (await mensagensDa(conversa.id)).map(paraTela),
  };
}

/** Começa uma conversa com o aluno escolhido, a partir da última mensagem da prévia. */
export async function iniciar(usuario, clienteId) {
  const ficha = await fichaDe(clienteId);
  const { data: disparo } = await supabase.from('acomp_disparos').select('dia, situacao, texto')
    .eq('cliente_id', clienteId).not('texto', 'is', null).order('dia', { ascending: false }).limit(1).maybeSingle();
  if (!disparo) throw new Error('A prévia ainda não gerou mensagem para este aluno: rode o ensaio.');

  const c = await contato(usuario);
  await supabase.from('wa_conversations').update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('contact_id', c.id).eq('channel', CANAL).in('status', ['active', 'human']);
  const { data: conversa, error } = await supabase.from('wa_conversations').insert({
    contact_id: c.id, status: 'active', channel: CANAL, ai_enabled: true,
    context: { origem: 'simulador-acomp', cliente_id: clienteId },
  }).select().single();
  if (error) throw new Error(`conversa do simulador: ${error.message}`);

  await saveMessage({
    conversationId: conversa.id, contactId: c.id, direction: 'outbound', content: disparo.texto,
    sentBy: SENT_BY_REGUA, metadata: { canal: CANAL, regua: { dia: disparo.dia, situacao: disparo.situacao } },
  });
  return { cliente_id: clienteId, aluno: ficha.aluno?.primeiro_nome ?? '—', mensagens: (await mensagensDa(conversa.id)).map(paraTela) };
}

/**
 * Um turno: a mensagem de quem testa, como se fosse o aluno.
 * @returns {Promise<object>} o que a tela mostra
 */
export async function responder(usuario, mensagem) {
  const c = await contato(usuario);
  const conversa = await conversaAtiva(c.id);
  if (!conversa) throw new Error('Escolha um aluno e comece a conversa.');

  const salva = await saveMessage({
    conversationId: conversa.id, contactId: c.id, direction: 'inbound', content: mensagem,
    sentBy: 'simulador', metadata: { canal: CANAL, usuario: usuario.email },
  });

  // Comandos: no WhatsApp, a porta do webhook os trata antes da Leia.
  if (ehPedidoDeSaida(mensagem)) {
    return { comando: 'sair', explicacao: 'No WhatsApp: o número sai de todo envio automático e o acompanhamento se encerra. A Leia não responde.' };
  }
  if (ehPedidoDePausa(mensagem)) {
    return { comando: 'pausar', resposta: TEXTO_PAUSA, explicacao: 'No WhatsApp: a régua para de escrever a este aluno, e a resposta é esta, fixa.' };
  }

  const linhas = await mensagensDa(conversa.id);
  const troca = trocaAtual(linhas);
  const ficha = await fichaDe(conversa.context.cliente_id);
  const regua = [...linhas].reverse().find(m => m.sent_by === SENT_BY_REGUA);
  const jaEncaminhado = linhas.flatMap(m => (m.metadata?.encaminhamentos ?? []).map(e => ({ ...e, em: m.created_at })))[0];

  const contexto = contextoDoAluno({
    ficha, hoje: hojeSP(), troca, simulacao: true,
    ultimaDoAcompanhamento: regua ? { texto: regua.content, quando: ddmm(regua.created_at) } : null,
    encaminhamentoAberto: jaEncaminhado
      ? { motivo: ROTULO_CATEGORIA[jaEncaminhado.categoria] ?? jaEncaminhado.categoria, quando: `em ${ddmm(jaEncaminhado.em)}` }
      : null,
  });

  const turno = { desfecho: null, encaminhamentos: [], pausa: null, handoff: null };
  const historico = await historicoDaConversa(conversa.id, { excludeMessageIds: [salva?.id] });
  const r = await processarAcompanhamento({
    mensagem, historico, contexto, executar: executorDeSimulacao(turno),
    conversationId: conversa.id, origem: 'acompanhamento-simulador',
  });

  // Todo turno tem desfecho (§6.4): o silêncio depois do limite é registrado aqui.
  if (r.semResposta && !turno.desfecho) turno.desfecho = { tipo: 'outro', resumo: 'papo depois do limite: sem resposta' };

  const detalhes = {
    simulacao: true, troca: troca.troca, limite: troca.limiteAtingido, semResposta: r.semResposta,
    desfecho: turno.desfecho, encaminhamentos: turno.encaminhamentos, pausa: turno.pausa, handoff: turno.handoff,
    ferramentas: r.ferramentas,
  };
  if (r.semResposta) {
    // Nada sai; a marca fica na mensagem do aluno, para a tela mostrar.
    await supabase.from('wa_messages').update({ metadata: { ...(salva?.metadata ?? {}), ...detalhes } }).eq('id', salva?.id);
  } else {
    await saveMessage({
      conversationId: conversa.id, contactId: c.id, direction: 'outbound', content: r.text,
      sentBy: SENT_BY_LEIA, metadata: { canal: CANAL, ...detalhes },
    });
  }
  return { resposta: r.text, detalhes };
}
