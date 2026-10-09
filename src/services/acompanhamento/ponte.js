/**
 * src/services/acompanhamento/ponte.js
 * A ponte: professor e aluno conversam pelo número da academia (A5d).
 *
 * Pedido do responsável em 09/10/2026: alguns professores não querem dar o
 * número pessoal ao aluno. O professor responde no WhatsApp dele, ao número
 * da academia, CITANDO o briefing ou uma mensagem do aluno repassada; daqui a
 * mensagem vai ao aluno pelo número da academia, assinada com o nome dele. A
 * resposta do aluno volta ao professor do mesmo jeito. Ninguém vê o número de
 * ninguém, a conversa fica registrada, e a Leia sabe o que foi combinado.
 *
 * ## Os dois sentidos
 *
 *   professor → aluno  `doProfessor`, chamado pela porta da equipe. Texto,
 *                      áudio (como voz), foto, vídeo e documento. A reação ✅
 *                      na mensagem do professor confirma o envio; ⚠️ e uma
 *                      linha dizem por que não foi. Sai a qualquer hora — quem
 *                      escolhe escrever fora do turno é o professor.
 *   aluno → professor  `doAluno`, uma porta do webhook. Com a ponte aberta, a
 *                      mensagem do aluno vai ao professor que escreveu por
 *                      último, e a Leia não a vê. Mensagem à equipe só no
 *                      horário de quem recebe: fora dele, espera o turno na
 *                      `acomp_ponte_fila` — a menos que o professor tenha
 *                      escrito há menos de 30 minutos.
 *
 * ## Abre e fecha
 *
 * Abre na primeira mensagem do professor citando o encaminhamento (que vale
 * como "1 — assumo"). Fecha no "2", ou com 72 horas sem mensagem; fechada, o
 * aluno volta à Leia. O aluno que cita depois uma mensagem do professor a
 * reabre. Uma aberta por aluno (018).
 *
 * ## O eco
 *
 * Tudo o que sai da instância volta pelo webhook como `fromMe`, e o que não
 * estiver gravado é lido como consultor escrevendo do aparelho — que cala a
 * Leia. Áudio e mídia não passam pela checagem de eco por texto. Por isso a
 * ponte GRAVA ANTES de enviar (status `pending`), e `ehEcoDaPonte` reconhece a
 * linha ainda sem o id da Evolution.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { sendAudio, sendMediaBase64, sendReaction, sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { baixarMidia } from '../transcricao.js';
import { estaSuprimido } from '../campanhas.js';
import { buscarEquipe } from './prescrev.js';
import { professorHoje } from './horario.js';
import { primeiroNome } from './render.js';
import { mesmoNumero } from './comandos.js';
import { assumirPelaPonte, equipeAtivada, responderBriefing } from './encaminhamentos.js';
import {
  SENT_BY_PONTE, TEXTOS_PONTE, TIPOS_REPASSADOS, cabecalhoAoProfessor, cabecalhoDeAudio, comandoSozinho, ehDoProfessor,
  legendaAoAluno, ponteVencida, quandoRepassar, sentByProfessor, textoAoAluno, textoAoProfessor,
} from './ponte-regras.js';

const evento = (evento, detalhe = null) => ({ em: new Date().toISOString(), evento, detalhe });
const DEBOUNCE_MS = Math.max(2, config.agente.debounceSegundos) * 1000;
const AJUDA_A_CADA_MS = 60 * 60_000;
const MEDIA = { image: 'image', video: 'video', document: 'document' };

// ──────────────────────────────────────────────
// Leitura
// ──────────────────────────────────────────────

/** A ponte aberta do aluno, pelos 8 últimos dígitos. A vencida fecha aqui. */
export async function ponteAbertaDo(phone) {
  const fim = String(phone ?? '').replace(/\D/g, '').slice(-8);
  if (fim.length !== 8) return null;
  const { data, error } = await supabase.from('acomp_pontes').select('*')
    .is('fechada_em', null).like('aluno_phone', `%${fim}`);
  if (error) {
    // Antes da 018 a tabela não existe: ponte nenhuma.
    if (error.code !== 'PGRST205') logger.warn('[ponte] acomp_pontes:', error.message);
    return null;
  }
  const ponte = (data ?? []).find(p => mesmoNumero(p.aluno_phone, phone)) ?? null;
  if (ponte && ponteVencida(ponte)) {
    await fechar(ponte, 'prazo: 72 h sem mensagem');
    return null;
  }
  return ponte;
}

async function fechar(ponte, motivo) {
  await supabase.from('acomp_pontes').update({
    fechada_em: new Date().toISOString(), motivo_fechamento: motivo,
    historico: [...(ponte.historico ?? []), evento('fechada', motivo)],
  }).eq('id', ponte.id).is('fechada_em', null);
  logger.info(`[ponte] Fechada (${ponte.aluno} ↔ ${ponte.professor_nome}): ${motivo}`);
}

/** A mensagem citada, se for nossa e desta conversa. */
async function mensagemCitada(contactId, citada) {
  const { data } = await supabase.from('wa_messages').select('id, sent_by, metadata')
    .eq('evolution_msg_id', citada).eq('contact_id', contactId).eq('direction', 'outbound')
    .limit(1).maybeSingle();
  return data ?? null;
}

/** O contato do aluno: o que já existe com o mesmo final de número, para não abrir outra conversa. */
async function contatoDoAluno(phone) {
  const fim = String(phone).replace(/\D/g, '').slice(-8);
  const { data } = await supabase.from('wa_contacts').select('*').like('phone', `%${fim}`);
  const existente = (data ?? []).find(c => mesmoNumero(c.phone, phone));
  return existente ?? getOrCreateContact(phone);
}

/** O horário do professor da ponte, da lista do Prescrev. `undefined` = sem a lista. */
async function horarioDo(profileId) {
  try {
    const equipe = await buscarEquipe();
    return equipe.find(m => m.profile_id === profileId)?.horario ?? null;
  } catch (err) {
    logger.warn('[ponte] Sem a lista da equipe para ler o horário:', err.message);
    return undefined;
  }
}

/** Para a Leia: a ponte aberta do aluno e quando o professor vê a mensagem. */
export async function ponteParaALeia(phone) {
  const ponte = await ponteAbertaDo(phone);
  if (!ponte) return null;
  const horario = await horarioDo(ponte.professor_profile_id);
  return {
    professor: primeiroNome(ponte.professor_nome),
    situacao: horario === undefined ? null : professorHoje(horario),
    teste: ponte.teste,
  };
}

// ──────────────────────────────────────────────
// Envio que grava antes
// ──────────────────────────────────────────────

/**
 * Grava (pending), envia, e completa com o id da Evolution. Ver "O eco".
 * @returns {Promise<object>} a resposta da Evolution
 */
async function enviarGravando({ contato, conversa, sentBy, conteudo, tipo, metadata, enviar }) {
  const linha = await saveMessage({
    conversationId: conversa.id, contactId: contato.id, direction: 'outbound',
    content: conteudo, contentType: tipo, sentBy, status: 'pending', metadata,
  });
  let r;
  try {
    r = await enviar();
  } catch (err) {
    if (linha?.id) await supabase.from('wa_messages').update({ status: 'failed' }).eq('id', linha.id);
    throw err;
  }
  if (linha?.id) {
    await supabase.from('wa_messages').update({ status: 'sent', evolution_msg_id: r?.key?.id ?? null }).eq('id', linha.id);
  }
  return r;
}

/**
 * O eco de um envio da ponte que ainda não ganhou o id da Evolution: a linha
 * `pending` gravada antes de enviar, deste contato, há menos de 2 minutos.
 * Chamado por `registrarMensagemDeSaida` do webhook.
 */
export async function ehEcoDaPonte(contactId) {
  const desde = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data } = await supabase.from('wa_messages').select('id, sent_by')
    .eq('contact_id', contactId).eq('direction', 'outbound').eq('status', 'pending').gte('created_at', desde)
    .limit(5);
  return (data ?? []).some(m => m.sent_by === SENT_BY_PONTE || ehDoProfessor(m.sent_by));
}

// ──────────────────────────────────────────────
// Professor → aluno
// ──────────────────────────────────────────────

/** Abre a ponte do aluno, ou passa a aberta para quem escreveu agora. */
async function abrirOuAtualizar(enc, membro) {
  const agora = new Date().toISOString();
  const quem = {
    professor_profile_id: membro.profile_id, professor_nome: membro.nome, professor_phone: membro.phone,
    encaminhamento_id: enc.id, ultima_em: agora, ultima_do_professor_em: agora,
  };
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const aberta = await ponteAbertaDo(enc.aluno_phone);
    if (aberta) {
      const troca = aberta.professor_profile_id !== membro.profile_id;
      const historico = troca ? [...(aberta.historico ?? []), evento('passou a', membro.nome)] : aberta.historico;
      await supabase.from('acomp_pontes').update({ ...quem, historico }).eq('id', aberta.id);
      return { ...aberta, ...quem, historico };
    }
    const nova = {
      aluno_phone: enc.aluno_phone, aluno: enc.aluno, cliente_id: enc.cliente_id ?? null, teste: enc.origem === 'teste',
      aberta_em: agora, ...quem, historico: [evento('aberta', `${membro.nome} escreveu a ${enc.aluno}`)],
    };
    const { data, error } = await supabase.from('acomp_pontes').insert(nova).select().single();
    if (!error) {
      logger.info(`[ponte] Aberta: ${membro.nome} ↔ ${enc.aluno}${nova.teste ? ' (teste)' : ''}`);
      return data;
    }
    // Duas mensagens ao mesmo tempo: a outra abriu — atualiza a dela.
    if (error.code !== '23505') throw new Error(`acomp_pontes: ${error.message}`);
  }
  throw new Error('acomp_pontes: não deu para abrir nem achar a ponte');
}

/**
 * A mensagem de quem é da equipe que CITA uma mensagem da ponte — o briefing
 * ou um repasse do aluno. Devolve false quando a citação não é da ponte, e a
 * porta da equipe segue como antes.
 *
 * @param {object} p
 * @param {object} p.membro     a linha de `acomp_equipe`
 * @param {string} p.tipo       o tipo RECEBIDO (antes da transcrição do áudio)
 * @param {object} p.key        a `key` da mensagem do professor (para reagir e baixar a mídia)
 * @param {(texto: string) => Promise<void>} p.responder
 */
export async function doProfessor({ membro, phone, contact, content, tipo, key, citada, responder }) {
  if (!citada) return false;
  const origem = await mensagemCitada(contact.id, citada);
  const encId = origem?.metadata?.encaminhamento;
  if (!encId) return false;
  const { data: enc } = await supabase.from('acomp_encaminhamentos').select('*').eq('id', encId).maybeSingle();
  if (!enc) return false;

  // "2" sozinho citando o briefing: o comando daquele encaminhamento.
  const numero = tipo === 'text' ? comandoSozinho(content) : null;
  if (numero) {
    await responder(await responderBriefing({ phone, numero, nota: null, encaminhamentoId: enc.id }));
    logger.info(`[ponte] ${membro.nome} respondeu ${numero} citando o encaminhamento de ${enc.aluno}`);
    return true;
  }

  await repassarAoAluno({ membro, content, tipo, key, enc, responder });
  return true;
}

async function repassarAoAluno({ membro, content, tipo, key, enc, responder }) {
  const reagir = (emoji) => sendReaction({ remoteJid: key.remoteJid, id: key.id }, emoji)
    .catch(err => logger.warn('[ponte] Reação não foi:', err.message));
  const recusar = async (texto, porque) => {
    logger.info(`[ponte] ${membro.nome} → ${enc.aluno}: não foi (${porque})`);
    await reagir('⚠️');
    await responder(texto);
  };

  if (enc.status === 'simulado' || enc.status === 'cancelado') return recusar(TEXTOS_PONTE.ensaio, enc.status);
  if (!enc.aluno_phone) return recusar(TEXTOS_PONTE.semNumero(enc.aluno), 'sem número');
  if (!TIPOS_REPASSADOS.includes(tipo)) return recusar(TEXTOS_PONTE.tipo, `tipo ${tipo}`);
  if (await estaSuprimido(enc.aluno_phone)) return recusar(TEXTOS_PONTE.suprimido(enc.aluno), 'SAIR');

  const nome = primeiroNome(membro.nome);
  const ponte = await abrirOuAtualizar(enc, membro);
  const contato = await contatoDoAluno(enc.aluno_phone);
  const conversa = await getOrCreateConversation(contato.id);
  const comum = { contato, conversa, sentBy: sentByProfessor(membro.profile_id), metadata: { ponte: ponte.id, encaminhamento: enc.id } };
  const para = contato.phone;

  try {
    if (tipo === 'text') {
      const texto = textoAoAluno(nome, content);
      await enviarGravando({ ...comum, conteudo: texto, tipo: 'text', enviar: () => sendText(para, texto) });
    } else {
      const midia = await baixarMidia(key.id);
      if (!midia) return recusar(TEXTOS_PONTE.midia, 'mídia não baixou');
      if (tipo === 'audio') {
        const cabecalho = cabecalhoDeAudio(nome);
        await enviarGravando({ ...comum, conteudo: cabecalho, tipo: 'text', enviar: () => sendText(para, cabecalho, { delayMs: 800 }) });
        // O conteúdo gravado é a transcrição do webhook ("[áudio] …"): a Leia lê o que ele disse.
        await enviarGravando({ ...comum, conteudo: content, tipo: 'audio', enviar: () => sendAudio(para, midia.base64) });
      } else {
        const legenda = legendaAoAluno(nome, content);
        await enviarGravando({
          ...comum, conteudo: legenda, tipo,
          enviar: () => sendMediaBase64(para, { ...midia, caption: legenda, mediatype: MEDIA[tipo] }),
        });
      }
    }
  } catch (err) {
    logger.warn(`[ponte] ${membro.nome} → ${enc.aluno}: o envio falhou: ${err.message}`);
    return recusar(TEXTOS_PONTE.falhou(enc.aluno), 'falha no envio');
  }

  await reagir('✅');
  await assumirPelaPonte(enc, membro).catch(err => logger.warn('[ponte] Encaminhamento não marcado como assumido:', err.message));
  logger.info(`[ponte] ${nome} → ${enc.aluno} (${tipo})`);
  // O professor está conversando: o que o aluno mandou e esperava o turno vai agora.
  agendarEntrega(ponte.id, 0);
}

// ──────────────────────────────────────────────
// A explicação a quem escreve sem citar
// ──────────────────────────────────────────────

const ultimaAjuda = new Map(); // phone -> instante

/**
 * Quem é da equipe e escreveu sem citar (e sem comando) recebe, no máximo uma
 * vez por hora, a explicação de como falar com o aluno — mas só quem tem
 * conversa pela ponte, ou encaminhamento recente, para não falar sozinho com
 * quem nunca usou.
 */
export async function precisaDeAjuda(membro) {
  if (Date.now() - (ultimaAjuda.get(membro.phone) ?? 0) < AJUDA_A_CADA_MS) return false;
  const desde = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [{ data: ponte }, { data: enc }] = await Promise.all([
    supabase.from('acomp_pontes').select('id').eq('professor_profile_id', membro.profile_id).is('fechada_em', null).limit(1).maybeSingle(),
    supabase.from('acomp_encaminhamentos').select('id').eq('destinatario_phone', membro.phone)
      .in('status', ['aguardando', 'assumido']).gte('updated_at', desde).limit(1).maybeSingle(),
  ]);
  if (!ponte && !enc) return false;
  ultimaAjuda.set(membro.phone, Date.now());
  return true;
}

export const AJUDA = TEXTOS_PONTE.ajuda;

// ──────────────────────────────────────────────
// Aluno → professor
// ──────────────────────────────────────────────

/** A ponte que o aluno reabre citando uma mensagem do professor. */
async function reabrirPelaCitacao(contactId, citada) {
  const m = await mensagemCitada(contactId, citada);
  if (!ehDoProfessor(m?.sent_by) || !m.metadata?.ponte) return null;
  const { data: velha } = await supabase.from('acomp_pontes').select('*').eq('id', m.metadata.ponte).maybeSingle();
  if (!velha) return null;
  const agora = new Date().toISOString();
  const { data, error } = await supabase.from('acomp_pontes').insert({
    aluno_phone: velha.aluno_phone, aluno: velha.aluno, cliente_id: velha.cliente_id,
    encaminhamento_id: velha.encaminhamento_id, teste: velha.teste,
    professor_profile_id: velha.professor_profile_id, professor_nome: velha.professor_nome, professor_phone: velha.professor_phone,
    aberta_em: agora, ultima_em: agora, ultima_do_professor_em: velha.ultima_do_professor_em,
    historico: [evento('reaberta', `${velha.aluno} citou uma mensagem de ${velha.professor_nome}`)],
  }).select().single();
  if (error) {
    logger.warn('[ponte] Não reabriu pela citação:', error.message);
    return null;
  }
  return data;
}

/**
 * A mensagem do aluno, com a ponte aberta, vai ao professor — e a Leia não a
 * vê, a não ser na espera do turno (abaixo).
 *
 * @param {object} p
 * @param {string} p.tipo  o tipo RECEBIDO (antes da transcrição do áudio)
 * @returns {Promise<{ tratada: false } | { tratada: true, espera: null | { professor: string, situacao: object|null, teste: boolean, primeira: boolean } }>}
 *   espera: a mensagem aguarda o turno do professor — quem responde ao aluno
 *   é a Leia (com a ponte no contexto) ou, sem ela, o aviso fixo
 */
export async function doAluno({ phone, contact, content, tipo, key, citada, savedMessage }) {
  let ponte = await ponteAbertaDo(phone);
  if (!ponte && citada) ponte = await reabrirPelaCitacao(contact.id, citada);
  if (!ponte) return { tratada: false };

  const ativo = (await equipeAtivada()).find(a => a.profile_id === ponte.professor_profile_id);
  if (!ativo) {
    await fechar(ponte, `${ponte.professor_nome} não está mais com o EQUIPE ativado`);
    return { tratada: false };
  }
  const horario = await horarioDo(ponte.professor_profile_id);
  // Sem a lista da equipe não há como saber o turno: espera o próximo ciclo
  // do worker, que confere de novo (falha fechada, como os briefings).
  const q = horario === undefined
    ? { acao: 'turno', enviarEm: new Date(Date.now() + config.acompanhamento.encaminhamentosMinutos * 60_000) }
    : quandoRepassar({ horario, ultimaDoProfessorEm: ponte.ultima_do_professor_em });
  if (q.acao === 'sem_horario') {
    await fechar(ponte, `${ponte.professor_nome} ficou sem horário de trabalho`);
    return { tratada: false };
  }

  const { count: antes } = await supabase.from('acomp_ponte_fila').select('id', { count: 'exact', head: true })
    .eq('ponte_id', ponte.id).eq('status', 'pendente');
  const enviarEm = q.acao === 'agora' ? new Date(Date.now() + DEBOUNCE_MS) : q.enviarEm;
  const { error } = await supabase.from('acomp_ponte_fila').insert({
    ponte_id: ponte.id, wa_message_id: savedMessage?.id ?? null, evolution_msg_id: key?.id ?? null,
    tipo, texto: content, enviar_em: enviarEm.toISOString(),
  });
  if (error) {
    logger.error('[ponte] A mensagem do aluno não entrou na fila — segue o caminho normal:', error.message);
    return { tratada: false };
  }
  await supabase.from('acomp_pontes').update({ ultima_em: new Date().toISOString() }).eq('id', ponte.id);

  if (q.acao === 'agora') {
    agendarEntrega(ponte.id, DEBOUNCE_MS);
    return { tratada: true, espera: null };
  }
  logger.info(`[ponte] ${ponte.aluno} → ${ponte.professor_nome}: espera o turno (${enviarEm.toISOString()})`);
  return {
    tratada: true,
    espera: {
      professor: primeiroNome(ponte.professor_nome),
      situacao: horario ? professorHoje(horario) : null,
      teste: ponte.teste,
      primeira: !antes,
    },
  };
}

// ──────────────────────────────────────────────
// A entrega ao professor
// ──────────────────────────────────────────────

const timers = new Map();   // ponte_id -> timer
const emVoo = new Set();    // ponte_id

/** (Re)arma a entrega da fila de uma ponte: os balões do aluno vão juntos. */
function agendarEntrega(ponteId, ms) {
  clearTimeout(timers.get(ponteId));
  const t = setTimeout(() => {
    timers.delete(ponteId);
    entregarFila(ponteId).catch(err => logger.warn('[ponte] Entrega falhou:', err.message));
  }, ms);
  t.unref?.();
  timers.set(ponteId, t);
}

/**
 * Leva ao professor o que o aluno mandou e está na fila. Texto junto, numa
 * mensagem só; áudio e mídia como vieram. Fora do turno (e sem conversa
 * acontecendo), reagenda para o começo dele.
 */
export async function entregarFila(ponteId) {
  if (emVoo.has(ponteId)) return agendarEntrega(ponteId, 2_000);
  emVoo.add(ponteId);
  try {
    const { data: ponte } = await supabase.from('acomp_pontes').select('*').eq('id', ponteId).maybeSingle();
    if (!ponte) return;
    const { data: linhas } = await supabase.from('acomp_ponte_fila').select('*')
      .eq('ponte_id', ponteId).eq('status', 'pendente').order('id');
    if (!linhas?.length) return;

    const horario = await horarioDo(ponte.professor_profile_id);
    if (horario === undefined) return; // o worker tenta de novo
    const q = quandoRepassar({ horario, ultimaDoProfessorEm: ponte.ultima_do_professor_em });
    if (q.acao !== 'agora') {
      const enviarEm = q.acao === 'turno' ? q.enviarEm.toISOString() : null;
      if (enviarEm) await supabase.from('acomp_ponte_fila').update({ enviar_em: enviarEm }).in('id', linhas.map(l => l.id));
      return;
    }

    const contato = await getOrCreateContact(ponte.professor_phone, ponte.professor_nome);
    const conversa = await getOrCreateConversation(contato.id);
    const comum = { contato, conversa, sentBy: SENT_BY_PONTE, metadata: { ponte: ponte.id, encaminhamento: ponte.encaminhamento_id } };
    const marcar = (ids, campos) => supabase.from('acomp_ponte_fila').update(campos).in('id', ids);

    let textos = [];
    const soltarTextos = async () => {
      if (!textos.length) return;
      const lote = textos;
      textos = [];
      const texto = textoAoProfessor(ponte.aluno, lote.map(l => l.texto));
      try {
        await enviarGravando({ ...comum, conteudo: texto, tipo: 'text', enviar: () => sendText(ponte.professor_phone, texto) });
        await marcar(lote.map(l => l.id), { status: 'entregue', entregue_em: new Date().toISOString() });
      } catch (err) {
        await marcar(lote.map(l => l.id), { status: 'falhou', erro: err.message.slice(0, 300) });
      }
    };

    for (const l of linhas) {
      if (l.tipo === 'text' || !TIPOS_REPASSADOS.includes(l.tipo)) {
        // Figurinha, contato: vai o marcador que o webhook gravou ("[mensagem não suportada]").
        textos.push(l.tipo === 'text' ? l : { ...l, texto: l.texto || '[mensagem não suportada]' });
        continue;
      }
      await soltarTextos();
      try {
        const midia = await baixarMidia(l.evolution_msg_id);
        if (!midia) throw new Error('mídia não baixou');
        const cabecalho = cabecalhoAoProfessor(ponte.aluno, l.tipo, l.texto);
        if (l.tipo === 'audio') {
          await enviarGravando({ ...comum, conteudo: cabecalho, tipo: 'text', enviar: () => sendText(ponte.professor_phone, cabecalho, { delayMs: 800 }) });
          await enviarGravando({ ...comum, conteudo: l.texto, tipo: 'audio', enviar: () => sendAudio(ponte.professor_phone, midia.base64) });
        } else {
          await enviarGravando({
            ...comum, conteudo: cabecalho, tipo: l.tipo,
            enviar: () => sendMediaBase64(ponte.professor_phone, { ...midia, caption: cabecalho, mediatype: MEDIA[l.tipo] }),
          });
        }
        await marcar([l.id], { status: 'entregue', entregue_em: new Date().toISOString() });
      } catch (err) {
        // A mídia não foi: vai ao menos o aviso, com o que a transcrição disse.
        textos.push({ ...l, texto: `[${l.tipo} que não consegui repassar]${l.texto && !/^\[[^\]]+\]$/.test(l.texto) ? ` ${l.texto}` : ''}` });
        logger.warn(`[ponte] Mídia de ${ponte.aluno} não repassada: ${err.message}`);
      }
    }
    await soltarTextos();
    logger.info(`[ponte] ${ponte.aluno} → ${ponte.professor_nome}: ${linhas.length} mensagem(ns) entregue(s)`);
  } finally {
    emVoo.delete(ponteId);
  }
}

/**
 * A cada ciclo do worker: a fila que chegou ao turno do professor sai, e a
 * ponte sem mensagem há 72 horas fecha.
 * @returns {Promise<number>} quantas pontes tiveram entrega
 */
export async function processarPontes() {
  const agora = new Date();
  const { data: devidas, error } = await supabase.from('acomp_ponte_fila').select('ponte_id')
    .eq('status', 'pendente').lte('enviar_em', agora.toISOString());
  if (error) {
    if (error.code !== 'PGRST205') logger.warn('[ponte] Fila não conferida:', error.message);
    return 0;
  }
  const pontes = [...new Set((devidas ?? []).map(d => d.ponte_id))];
  for (const id of pontes) await entregarFila(id).catch(err => logger.warn(`[ponte] Entrega de ${id}:`, err.message));

  const { data: abertas } = await supabase.from('acomp_pontes').select('*').is('fechada_em', null);
  for (const p of (abertas ?? []).filter(p => ponteVencida(p, agora))) await fechar(p, 'prazo: 72 h sem mensagem');
  return pontes.length;
}

/** A conversa de uma ponte, para a tela do Prescrev: só o que passou por ela, sem números. */
export async function conversaDoEncaminhamento(encId) {
  const { data: pontes } = await supabase.from('acomp_pontes')
    .select('id, aluno, professor_nome, aberta_em, fechada_em, motivo_fechamento, teste')
    .eq('encaminhamento_id', encId).order('aberta_em');
  if (!pontes?.length) return { pontes: [], mensagens: [] };

  const { data: enc } = await supabase.from('acomp_encaminhamentos').select('aluno_phone').eq('id', encId).maybeSingle();
  const contato = enc?.aluno_phone ? await contatoDoAluno(enc.aluno_phone) : null;
  if (!contato) return { pontes, mensagens: [] };

  // Só o que passou pela ponte: do aluno, o que entrou na fila; dos
  // professores, o que eles escreveram. A Leia e o consultor ficam no painel do APAC.
  const ids = pontes.map(p => p.id);
  const [{ data: fila }, { data: msgs }] = await Promise.all([
    supabase.from('acomp_ponte_fila').select('wa_message_id').in('ponte_id', ids),
    supabase.from('wa_messages').select('id, direction, sent_by, content, content_type, metadata, created_at')
      .eq('contact_id', contato.id).gte('created_at', pontes[0].aberta_em).order('created_at').limit(300),
  ]);
  const doAluno = new Set((fila ?? []).map(f => f.wa_message_id).filter(Boolean));
  const mensagens = (msgs ?? [])
    .filter(m => (m.direction === 'inbound' && doAluno.has(m.id)) || (ehDoProfessor(m.sent_by) && ids.includes(m.metadata?.ponte)))
    .map(m => ({ de: m.direction === 'inbound' ? 'aluno' : 'professor', texto: m.content, tipo: m.content_type, em: m.created_at }));
  return { pontes, mensagens };
}
