/**
 * src/services/avaliacao-avisos.js
 * Os avisos da avaliação física pelo WhatsApp (03/11/2026).
 *
 * As regras — quando cada um sai, como se reconhece a compra e a
 * automação, os textos — estão em `avaliacao-avisos-regras.js`, puras.
 * Aqui mora o que lê e grava:
 *
 *   aoVenderAvaliacao     o webhook NewSale com o "AF E CONSULTORIA" marca o
 *                         aviso da compra (`evo-sync.js`)
 *   aoAvisoDaAutomacao    a automação do CRM do EVO (3 dias antes, véspera)
 *                         acha a sessão na agenda da pessoa e marca o aviso
 *                         dela — a dos 3 dias já marca a véspera também, para
 *                         o lembrete sair mesmo se a segunda automação faltar
 *   enviarAvisos          o worker manda o que chegou à hora
 *
 * ## Na hora de sair, o mundo se confere de novo
 *
 * Entre marcar e enviar passam dias. Por isso, antes de cada aviso:
 *
 *   passou do prazo         não sai (a véspera depois de 13 h antes falaria
 *                           de um prazo de desmarcar já vencido)
 *   número suprimido        não sai
 *   a sessão sumiu ou mudou não sai: a sessão remarcada é outra, e a
 *                           automação a anuncia de novo
 *   o da compra saiu há     o dos 3 dias não sai (seria o mesmo texto duas
 *   menos de 24 h           vezes); a véspera continua
 *   consultor na conversa   NÃO espera (decisão de 03/11/2026): é aviso de
 *                           horário marcado, e a resposta do cliente continua
 *                           com o consultor — a conversa segue em modo humano
 *
 * E o questionário se pergunta ao Prescrev só na hora do envio: quem
 * respondeu entre a automação e a mensagem não recebe o link.
 *
 * ## Desligado por padrão
 *
 * Com `AVALIACAO_AVISOS_ENVIO=false` (o padrão), cada aviso chega à hora
 * dele como 'simulado', com o texto que sairia, e nada vai ao WhatsApp.
 *
 * O envio fica FORA do teto diário do número (decisão de 03/11/2026): não
 * conta nem espera por ele (`limite-envio.js`). Ligar é decisão do responsável, no `.env`.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { sendText, normalizePhone } from './evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from './contacts.js';
import { estaNaJanela } from './followup.js';
import { estaSuprimido } from './campanhas.js';
import { buscarMembroPorId, sessoesDaPessoa } from './evo-client.js';
import { telefonesDoMembro } from './vendas-regras.js';
import { questionarioRecebido } from './acompanhamento/prescrev.js';
import {
  QUESTIONARIO_JANELA_MS, TRES_DIAS_DEPOIS_DA_VENDA_MS, VENDA_INTERVALO_MS, VENDA_RECENTE_MS,
  agendaDoAviso, diaSP, etapaDaAutomacao, generoDe, horarioDaSessao, primeiroNome,
  sessaoDaAvaliacao, temAvaliacaoNaVenda, textoDoAviso,
} from './avaliacao-avisos-regras.js';

export const SENT_BY_AVALIACAO = 'bot:avaliacao';
const DIA_MS = 86_400_000;
const TENTATIVAS_MAX = 3;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const semTabela = (error) => error?.code === 'PGRST205' || error?.code === '42P01';

let avisouSemTabela = false;
function avisarSemTabela() {
  if (avisouSemTabela) return;
  avisouSemTabela = true;
  logger.warn('[avaliacao] A tabela aval_avisos não existe: aplique supabase/migrations/022_avaliacao_avisos.sql');
}

/** Grava o aviso; o que já existe (mesma pessoa, etapa e referência) fica como está. */
async function gravar(linha) {
  const { error } = await supabase.from('aval_avisos')
    .upsert(linha, { onConflict: 'id_member,etapa,referencia', ignoreDuplicates: true });
  if (error) {
    if (semTabela(error)) { avisarSemTabela(); return false; }
    throw new Error(`aval_avisos: ${error.message}`);
  }
  return true;
}

async function atualizar(aviso, campos) {
  const { error } = await supabase.from('aval_avisos').update(campos).eq('id', aviso.id);
  if (error) logger.warn(`[avaliacao] Aviso ${aviso.id} não atualizado: ${error.message}`);
}

const cancelar = (aviso, motivo) => atualizar(aviso, { status: 'cancelado', motivo });

// ──────────────────────────────────────────────
// Marcar
// ──────────────────────────────────────────────

/**
 * A venda com a avaliação física marca o aviso da compra. Chamado pelo
 * `processarEventoWebhook` em todo NewSale — o que não é avaliação passa
 * direto. Venda guardada há mais de 2 dias é reprocessamento: não avisa.
 */
export async function aoVenderAvaliacao(detalhe, evento, { agora = new Date() } = {}) {
  const c = config.avaliacao;
  if (!c.habilitado || !temAvaliacaoNaVenda(detalhe, { servicos: c.servicos })) return false;
  const idMember = Number(detalhe?.idMember);
  if (!Number.isInteger(idMember) || idMember <= 0) return false;

  const recebida = Date.parse(evento?.created_at ?? '') || agora.getTime();
  if (agora.getTime() - recebida > VENDA_RECENTE_MS) return false;

  // Quem já recebeu o aviso de uma compra há menos de 30 dias não recebe de
  // novo: a segunda venda do mesmo serviço é ajuste no caixa, e não outra avaliação.
  const { data: ja, error } = await supabase.from('aval_avisos').select('id')
    .eq('id_member', idMember).eq('etapa', 'venda')
    .gte('created_at', new Date(agora.getTime() - VENDA_INTERVALO_MS).toISOString()).limit(1);
  if (error) {
    if (semTabela(error)) { avisarSemTabela(); return false; }
    throw new Error(`aval_avisos: ${error.message}`);
  }
  if (ja?.length) return false;

  const { previsto, prazo } = agendaDoAviso('venda', { agora });
  const ok = await gravar({
    id_member: idMember, etapa: 'venda', referencia: `venda:${detalhe.idSale ?? evento?.id_record ?? 'sem-id'}`,
    id_sale: Number(detalhe.idSale) || null, previsto_para: previsto.toISOString(), prazo: prazo.toISOString(),
    evento_id: evento?.id ?? null,
  });
  if (ok) logger.info(`[avaliacao] Compra da avaliação do membro ${idMember}: aviso marcado para ${previsto.toISOString()}`);
  return ok;
}

/**
 * A automação do CRM do EVO é da avaliação? Se for, marca o aviso e devolve
 * true — e a automação não segue para as outras regras. Sem sessão de
 * avaliação na agenda, grava o aviso já cancelado, com o motivo: é o que
 * mostra a automação configurada errado.
 */
export async function aoAvisoDaAutomacao(payload, evento, { agora = new Date() } = {}) {
  const c = config.avaliacao;
  if (!c.habilitado) return false;
  const etapa = etapaDaAutomacao(payload, { rotulo: c.rotuloAutomacao });
  if (!etapa) return false;

  // Reprocessar uma automação de dias atrás leria a agenda de hoje: não marca nada.
  const recebida = Date.parse(evento?.created_at ?? '') || agora.getTime();
  if (agora.getTime() - recebida > VENDA_RECENTE_MS) return true;

  const pessoa = payload?.person ?? {};
  const idMember = Number(pessoa.idMember);
  if (!Number.isInteger(idMember) || idMember <= 0) {
    logger.info(`[avaliacao] Automação "${payload?.eventLabel}" sem idMember (${pessoa.fullName || 'sem nome'}): ignorada`);
    return true;
  }

  const dias = Number(payload?.eventContext?.daysOffset) || 0;
  const diaAlvo = diaSP(new Date(agora.getTime() + dias * DIA_MS));
  const sessoes = await sessoesDaPessoa({
    idMember, de: diaSP(agora), ate: diaSP(new Date(agora.getTime() + (dias + 7) * DIA_MS)),
  });
  const achada = sessaoDaAvaliacao(sessoes, { atividades: c.atividades, diaAlvo, agora });

  const base = {
    id_member: idMember,
    nome: primeiroNome(pessoa.firstName ?? pessoa.fullName),
    phone: pessoa.phone ? normalizePhone(pessoa.phone) : null,
    email: pessoa.email || null,
    genero: generoDe(pessoa.gender),
    evento_id: evento?.id ?? null,
  };

  if (!achada) {
    await gravar({
      ...base, etapa, referencia: `sem-sessao:${evento?.id ?? agora.getTime()}`,
      previsto_para: agora.toISOString(), prazo: agora.toISOString(), status: 'cancelado',
      motivo: `A automação "${payload?.eventLabel}" chegou, mas não há avaliação na agenda do EVO para ${diaAlvo}.`,
    });
    logger.warn(`[avaliacao] Automação sem avaliação na agenda: membro ${idMember}, ${diaAlvo}`);
    return true;
  }

  const sessao = {
    id_sessao: achada.sessao.idActivitieSession ?? null,
    sessao_em: achada.em.toISOString(),
    professor: primeiroNome(achada.sessao.instructor),
  };
  const referencia = String(achada.sessao.idActivitieSession ?? achada.em.toISOString());

  // A dos 3 dias já deixa a véspera marcada.
  for (const e of etapa === 'tres_dias' ? ['tres_dias', 'vespera'] : ['vespera']) {
    const agenda = agendaDoAviso(e, { agora, sessaoEm: achada.em });
    if (!agenda || agenda.prazo.getTime() <= agora.getTime()) continue;
    await gravar({
      ...base, ...sessao, etapa: e, referencia,
      previsto_para: agenda.previsto.toISOString(), prazo: agenda.prazo.toISOString(),
    });
  }
  logger.info(`[avaliacao] Automação "${payload?.eventLabel}": avaliação do membro ${idMember} em ${sessao.sessao_em}`);
  return true;
}

// ──────────────────────────────────────────────
// Enviar
// ──────────────────────────────────────────────

/** Celular, nome, e-mail e sexo do cadastro do EVO, para o aviso que ainda não os tem. */
async function completarPessoa(aviso) {
  if (aviso.phone && aviso.nome && aviso.genero) return aviso;
  const membro = await buscarMembroPorId(aviso.id_member);
  const email = membro?.email
    || (membro?.contacts ?? []).find(c => /mail/i.test(String(c?.contactType ?? '')))?.description || null;
  const campos = {
    phone: aviso.phone || telefonesDoMembro(membro)[0] || null,
    nome: aviso.nome || primeiroNome(membro?.firstName),
    email: aviso.email || email,
    genero: aviso.genero || generoDe(membro?.gender),
  };
  await atualizar(aviso, campos);
  return { ...aviso, ...campos, nome_completo: [membro?.firstName, membro?.lastName].filter(Boolean).join(' ') || null };
}

/** A sessão continua na agenda, no mesmo horário? Devolve o motivo de não sair, ou null. */
async function conferirSessao(aviso) {
  const em = new Date(aviso.sessao_em);
  const sessoes = await sessoesDaPessoa({
    idMember: aviso.id_member, de: diaSP(new Date(em.getTime() - DIA_MS)), ate: diaSP(new Date(em.getTime() + DIA_MS)),
  });
  const s = sessoes.find(x => String(x?.idActivitieSession) === String(aviso.id_sessao));
  if (!s) return 'A sessão saiu da agenda do EVO (desmarcada ou remarcada).';
  const agoraEm = horarioDaSessao(s);
  if (!agoraEm || agoraEm.getTime() !== em.getTime()) {
    return `A sessão mudou de horário (${agoraEm?.toISOString() ?? '?'}): a automação anuncia o novo.`;
  }
  return null;
}

/** O aviso da compra saiu há menos de 24 h? Então o dos 3 dias repetiria o texto. */
async function vendaAcabouDeSair(aviso, agora) {
  const { data } = await supabase.from('aval_avisos').select('id')
    .eq('id_member', aviso.id_member).eq('etapa', 'venda').in('status', ['enviado', 'simulado'])
    .gte('enviado_em', new Date(agora.getTime() - TRES_DIAS_DEPOIS_DA_VENDA_MS).toISOString()).limit(1);
  return !!data?.length;
}

/** O questionário já chegou ao Prescrev? null = não deu para saber, e o link vai. */
async function consultarQuestionario(aviso) {
  try {
    const desde = new Date(new Date(aviso.sessao_em).getTime() - QUESTIONARIO_JANELA_MS).toISOString();
    const r = await questionarioRecebido({ evo: aviso.id_member, email: aviso.email, desde });
    return r?.recebido === true;
  } catch (err) {
    logger.warn(`[avaliacao] Não deu para perguntar ao Prescrev pelo questionário: ${err.message}`);
    return null;
  }
}

let rodando = false;

/**
 * Manda o que chegou à hora. Chamado pelo worker a cada poucos minutos,
 * e só faz algo dentro da janela de contato ativo.
 * @returns {Promise<number>} quantos saíram (ou foram simulados)
 */
export async function enviarAvisos({ agora = new Date() } = {}) {
  const c = config.avaliacao;
  if (!c.habilitado || rodando || !estaNaJanela(agora)) return 0;
  rodando = true;
  try {
    const { data: pendentes, error } = await supabase.from('aval_avisos').select('*')
      .eq('status', 'pendente').lte('previsto_para', agora.toISOString())
      .order('previsto_para', { ascending: true }).limit(20);
    if (error) {
      if (semTabela(error)) avisarSemTabela();
      else logger.warn('[avaliacao] Pendentes não lidos:', error.message);
      return 0;
    }

    let feitos = 0;
    for (const original of pendentes ?? []) {
      const momento = new Date();
      try {
        if (momento.getTime() > Date.parse(original.prazo)) {
          await cancelar(original, 'Passou do prazo sem sair.');
          continue;
        }
        const aviso = await completarPessoa(original);
        if (!aviso.phone) { await cancelar(aviso, 'Sem celular no cadastro do EVO.'); continue; }
        if (await estaSuprimido(aviso.phone)) { await cancelar(aviso, 'Número suprimido: pediu para sair.'); continue; }

        if (aviso.etapa !== 'venda') {
          const motivo = await conferirSessao(aviso);
          if (motivo) { await cancelar(aviso, motivo); continue; }
        }
        if (aviso.etapa === 'tres_dias' && await vendaAcabouDeSair(aviso, momento)) {
          await cancelar(aviso, 'O aviso da compra saiu há menos de 24 h: a véspera continua marcada.');
          continue;
        }

        const questionario = aviso.etapa === 'venda' ? null : await consultarQuestionario(aviso);
        const texto = textoDoAviso(aviso.etapa, {
          nome: aviso.nome, genero: aviso.genero, link: c.linkQuestionario,
          sessaoEm: aviso.sessao_em ? new Date(aviso.sessao_em) : null,
          professor: aviso.professor, questionario, agora: momento,
        });

        if (!c.envio) {
          await atualizar(aviso, { status: 'simulado', texto, questionario, enviado_em: momento.toISOString() });
          feitos++;
          continue;
        }

        // Fora do teto do número (decisão de 03/11/2026, `limite-envio.js`).
        if (feitos > 0) await esperar(20_000 + Math.random() * 20_000);

        const contato = await getOrCreateContact(aviso.phone, aviso.nome_completo ?? null);
        // Quem compra a avaliação é aluno: a resposta abre atendimento de
        // relacionamento, e não lead de venda (funil.js, TIPOS_CONTATO).
        if (!contato.tipo_contato) {
          await supabase.from('wa_contacts').update({ tipo_contato: 'aluno', evo_member_id: aviso.id_member })
            .eq('id', contato.id).is('tipo_contato', null);
        }
        const conversa = await getOrCreateConversation(contato.id);
        const r = await sendText(aviso.phone, texto);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: texto,
          contentType: 'text', sentBy: SENT_BY_AVALIACAO, evolutionMsgId: r?.key?.id || null, status: 'sent',
          metadata: { avaliacao: aviso.etapa, aviso: aviso.id },
        });
        await atualizar(aviso, { status: 'enviado', texto, questionario, enviado_em: new Date().toISOString() });
        feitos++;
        logger.info(`[avaliacao] Enviado: ${aviso.etapa} ao membro ${aviso.id_member}`);
      } catch (err) {
        const tentativas = (original.tentativas ?? 0) + 1;
        logger.error(`[avaliacao] Aviso ${original.id} falhou: ${err.message}`);
        await atualizar(original, {
          tentativas, motivo: `Falha: ${err.message}`.slice(0, 500),
          ...(tentativas >= TENTATIVAS_MAX ? { status: 'falhou' } : {}),
        });
      }
    }
    return feitos;
  } finally {
    rodando = false;
  }
}

export const avaliacaoAvisos = { aoVenderAvaliacao, aoAvisoDaAutomacao, enviarAvisos };
