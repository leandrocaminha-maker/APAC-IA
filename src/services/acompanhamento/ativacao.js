/**
 * src/services/acompanhamento/ativacao.js
 * A inscrição do aluno: "ATIVAR <código>", a confirmação do número, a pausa
 * e a saída (etapa A5, §5.1 do PLANO_ACOMPANHAMENTO.md do Prescrev, D2).
 *
 * ## O caminho
 *
 * 1. O código está no card do cliente e no Relatório 1; na entrega, o
 *    professor pede ao aluno que mande "ATIVAR <código>" ali mesmo.
 * 2. Aqui o código é conferido contra a ficha (a cópia em `acomp_fichas`, e
 *    o Prescrev quando o código acabou de ser gerado).
 * 3. Número igual ao do cadastro: a inscrição nasce ATIVA, o contato vira
 *    aluno e a resposta é o aceite — gravado como `bot:acompanhamento`, para
 *    que a resposta do aluno vá à Leia do acompanhamento (conversa.js).
 * 4. Número diferente: PENDENTE, até a equipe confirmar no card do Prescrev
 *    (`confirmar`). O código está impresso, e quem pegar o papel não pode
 *    passar a receber o acompanhamento de outra pessoa — por isso a resposta
 *    ao pendente não diz o nome do aluno.
 *
 * É resposta a mensagem recebida: não conta no teto do número. Errar o
 * código 5 vezes em 24h cala a porta para aquele número, como no EQUIPE.
 *
 * ## Na fase de teste
 *
 * A ativação funciona — é como a equipe testa o caminho inteiro, com o
 * próprio número e o código de um aluno (fica pendente, e se confirma no
 * card). O que não sai é a régua: ela continua em ensaio até o responsável
 * declarar o início (decisão de 08/10/2026).
 */
import { supabase } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { buscarFichas } from './prescrev.js';
import { primeiroNome } from './render.js';
import { TEXTOS_ATIVACAO, lerComandoAtivar, mesmoNumero, textoDoAceite } from './comandos.js';
import { SENT_BY_REGUA, TEXTO_PAUSA, ehPedidoDePausa } from './conversa.js';

const VIVAS = ['ativa', 'pendente', 'pausada'];
const TENTATIVAS_MAX = 5;
const TENTATIVAS_JANELA_MS = 24 * 60 * 60_000;
const evento = (evento, detalhe = null) => ({ em: new Date().toISOString(), evento, detalhe });

const tentativas = new Map(); // phone -> [instantes das falhas]
function bloqueado(phone) {
  const recentes = (tentativas.get(phone) ?? []).filter(t => Date.now() - t < TENTATIVAS_JANELA_MS);
  tentativas.set(phone, recentes);
  return recentes.length >= TENTATIVAS_MAX;
}
const falhou = (phone) => tentativas.set(phone, [...(tentativas.get(phone) ?? []), Date.now()]);

/** A ficha do código: a cópia, ou o Prescrev quando o código é novo (e aí guarda). */
async function fichaPeloCodigo(codigo) {
  const { data, error } = await supabase.from('acomp_fichas').select('ficha')
    .eq('ficha->aluno->>codigo_ativacao', codigo).maybeSingle();
  if (error) throw new Error(`acomp_fichas: ${error.message}`);
  if (data) return data.ficha;
  const { fichas } = await buscarFichas();
  const ficha = fichas.find(f => f.aluno?.codigo_ativacao === codigo) ?? null;
  if (ficha) {
    await supabase.from('acomp_fichas').upsert({
      cliente_id: ficha.cliente_id, ficha, atualizada_em: ficha.atualizada_em, recebida_em: new Date().toISOString(),
    }, { onConflict: 'cliente_id' });
  }
  return ficha;
}

/** O aceite deste aluno. */
export function aceiteDaFicha(ficha) {
  return textoDoAceite({
    nome: ficha.aluno?.primeiro_nome ?? null,
    professor: primeiroNome(ficha.marcadores?.professor ?? ficha.professor?.nome ?? '') || null,
    cadenciaDias: ficha.trilha?.cadencia_dias ?? null,
  });
}

/** A inscrição viva deste número, se houver. */
export async function inscricaoDoNumero(phone) {
  const { data, error } = await supabase.from('acomp_inscricoes').select('*').eq('phone', phone).in('status', VIVAS).maybeSingle();
  if (error) {
    if (error.code !== 'PGRST205') logger.warn('[ativacao] acomp_inscricoes:', error.message);
    return null;
  }
  return data;
}

/** Encerra o que estiver ativo ou pausado para o aluno: um número por aluno. */
async function encerrarDoCliente(clienteId, motivo, excetoId = null) {
  let q = supabase.from('acomp_inscricoes').update({
    status: 'encerrada', encerrado_em: new Date().toISOString(), motivo_encerramento: motivo,
  }).eq('cliente_id', clienteId).in('status', ['ativa', 'pausada']);
  if (excetoId) q = q.neq('id', excetoId);
  const { error } = await q;
  if (error) throw new Error(`acomp_inscricoes: ${error.message}`);
}

async function virarAluno(contactId) {
  if (!contactId) return;
  const { error } = await supabase.from('wa_contacts').update({ tipo_contato: 'aluno', is_prospect: false }).eq('id', contactId);
  if (error) logger.warn('[ativacao] Contato não marcado como aluno:', error.message);
}

/**
 * A porta do ATIVAR no webhook. Devolve true quando a mensagem é dela.
 * `responder(texto, sentBy)` manda e grava.
 */
export async function tratarAtivacao({ phone, contact, content, responder }) {
  const codigo = lerComandoAtivar(content);
  if (codigo === null) return false;
  if (bloqueado(phone)) return true; // calado, para não ensinar a tentar
  if (codigo === '') { await responder(TEXTOS_ATIVACAO.formato); return true; }

  let ficha;
  try {
    ficha = await fichaPeloCodigo(codigo);
  } catch (err) {
    logger.error('[ativacao] Não deu para conferir o código:', err.message);
    await responder('Não consegui conferir o código agora. Tente de novo em alguns minutos.');
    return true;
  }
  if (!ficha || ficha.estado?.encerrado) {
    falhou(phone);
    logger.warn(`[ativacao] Código ATIVAR não reconhecido vindo de ${phone}`);
    await responder(TEXTOS_ATIVACAO.invalido);
    return true;
  }

  const doNumero = await inscricaoDoNumero(phone);
  if (doNumero && doNumero.cliente_id !== ficha.cliente_id) { await responder(TEXTOS_ATIVACAO.outroAluno); return true; }
  if (doNumero?.status === 'ativa') { await responder(TEXTOS_ATIVACAO.jaAtivo); return true; }
  if (doNumero?.status === 'pendente') { await responder(TEXTOS_ATIVACAO.aguardando); return true; }
  if (doNumero?.status === 'pausada') {
    await supabase.from('acomp_inscricoes').update({
      status: 'ativa', pausado_ate: null, historico: [...(doNumero.historico ?? []), evento('retomado', 'ATIVAR de novo')],
    }).eq('id', doNumero.id);
    await responder(aceiteDaFicha(ficha), SENT_BY_REGUA);
    logger.info(`[ativacao] ${ficha.aluno?.primeiro_nome}: acompanhamento retomado`);
    return true;
  }

  const doCadastro = mesmoNumero(phone, ficha.aluno?.celular_cadastro);
  if (doCadastro) await encerrarDoCliente(ficha.cliente_id, 'outro número ativou');
  const { error } = await supabase.from('acomp_inscricoes').insert({
    cliente_id: ficha.cliente_id, phone, contact_id: contact?.id ?? null, codigo,
    status: doCadastro ? 'ativa' : 'pendente',
    confirmado_em: doCadastro ? new Date().toISOString() : null,
    confirmado_por: doCadastro ? 'cadastro' : null,
    historico: [evento('ativar', doCadastro ? 'número do cadastro' : 'número diferente do cadastro: aguarda a equipe')],
  });
  if (error) {
    if (error.code === '23505') { await responder(TEXTOS_ATIVACAO.jaAtivo); return true; }
    logger.error('[ativacao] Inscrição não gravada:', error.message);
    await responder('Não consegui registrar agora. Tente de novo em alguns minutos.');
    return true;
  }

  if (doCadastro) {
    await virarAluno(contact?.id);
    await responder(aceiteDaFicha(ficha), SENT_BY_REGUA);
    logger.info(`[ativacao] ${ficha.aluno?.primeiro_nome}: acompanhamento ativo`);
  } else {
    await responder(TEXTOS_ATIVACAO.pendente);
    logger.info(`[ativacao] Código de ${ficha.aluno?.primeiro_nome} vindo de outro número: pendente`);
  }
  return true;
}

/** "PAUSAR ACOMPANHAMENTO" de quem tem inscrição ativa. Devolve true quando a mensagem é dela. */
export async function tratarPausa({ phone, content, responder }) {
  if (!ehPedidoDePausa(content)) return false;
  const inscricao = await inscricaoDoNumero(phone);
  if (!inscricao || inscricao.status === 'pendente') return false;
  if (inscricao.status === 'ativa') {
    await supabase.from('acomp_inscricoes').update({
      status: 'pausada', historico: [...(inscricao.historico ?? []), evento('pausa', 'PAUSAR ACOMPANHAMENTO')],
    }).eq('id', inscricao.id);
  }
  await responder(TEXTO_PAUSA);
  return true;
}

/** SAIR também encerra o acompanhamento (§6.1). */
export async function encerrarPorSaida(phone) {
  const { error } = await supabase.from('acomp_inscricoes').update({
    status: 'encerrada', encerrado_em: new Date().toISOString(), motivo_encerramento: 'SAIR',
  }).eq('phone', phone).in('status', VIVAS);
  if (error && error.code !== 'PGRST205') logger.warn('[ativacao] SAIR não encerrou a inscrição:', error.message);
}

/**
 * A equipe confirma, no card do Prescrev, o número pendente: ele passa a
 * receber, o que estava ativo para o aluno sai, e o aceite vai — é resposta
 * ao ATIVAR que ele mandou.
 */
export async function confirmar(inscricaoId, por) {
  const { data: inscricao, error } = await supabase.from('acomp_inscricoes').select('*').eq('id', inscricaoId).maybeSingle();
  if (error) throw new Error(`acomp_inscricoes: ${error.message}`);
  if (!inscricao) throw new Error('Inscrição não encontrada.');
  if (inscricao.status !== 'pendente') throw new Error(`A inscrição não está pendente (${inscricao.status}).`);
  const { data: copia } = await supabase.from('acomp_fichas').select('ficha').eq('cliente_id', inscricao.cliente_id).maybeSingle();
  if (!copia) throw new Error('O aluno não tem ficha no acompanhamento.');

  await encerrarDoCliente(inscricao.cliente_id, 'a equipe confirmou outro número', inscricao.id);
  const { error: e } = await supabase.from('acomp_inscricoes').update({
    status: 'ativa', confirmado_em: new Date().toISOString(), confirmado_por: por,
    historico: [...(inscricao.historico ?? []), evento('confirmado', por)],
  }).eq('id', inscricao.id);
  if (e) throw new Error(`acomp_inscricoes: ${e.message}`);

  const contato = await getOrCreateContact(inscricao.phone, copia.ficha.aluno?.primeiro_nome ?? null);
  await virarAluno(contato.id);
  const conversa = await getOrCreateConversation(contato.id);
  const texto = aceiteDaFicha(copia.ficha);
  const r = await sendText(inscricao.phone, texto);
  await saveMessage({
    conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: texto, contentType: 'text',
    sentBy: SENT_BY_REGUA, evolutionMsgId: r?.key?.id || null, status: 'sent', metadata: { acompanhamento: 'aceite' },
  });
  logger.info(`[ativacao] ${copia.ficha.aluno?.primeiro_nome}: número confirmado por ${por}`);
}

/** As inscrições, para o Prescrev — o número só pelo final. */
export async function listarInscricoes({ clienteId = null } = {}) {
  let q = supabase.from('acomp_inscricoes')
    .select('id, cliente_id, phone, status, ativado_em, confirmado_em, confirmado_por, pausado_ate, encerrado_em, motivo_encerramento')
    .order('created_at', { ascending: false }).limit(500);
  if (clienteId) q = q.eq('cliente_id', clienteId);
  const { data, error } = await q;
  if (error) throw new Error(`acomp_inscricoes: ${error.message}`);
  return (data ?? []).map(({ phone, ...i }) => ({ ...i, final_do_numero: String(phone).slice(-4) }));
}
