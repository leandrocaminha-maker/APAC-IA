/**
 * src/services/acompanhamento/agenda-testes.js
 * A agenda de testes do dia no WhatsApp de cada professor (05/11/2026).
 *
 * Decisão do responsável: no fim da consulta, o avaliador marca a sessão de
 * aplicação dos testes com um professor da sala (de preferência o professor
 * assistente), no Prescrev (migration 060 de lá). No dia, o professor recebe
 * a agenda dele aqui:
 *
 *   no começo do turno   a agenda do dia inteiro, com o link da tela de
 *                        testes de cada aluno (onde está o protocolo)
 *   depois               o que entrou (a consulta pode marcar na sequência) e
 *                        o que saiu (cancelado ou remarcado)
 *
 * Só a quem ativou o EQUIPE e está no horário de trabalho agora; o teste que
 * já começou não entra. É mensagem de OPERAÇÃO para a equipe, como o aviso
 * de sessões: não passa pela régua do aluno nem conta no teto do número.
 *
 * O Prescrev publica a agenda (`/api/acompanhamento/agenda-testes`); quem
 * guarda o que já foi avisado é o marcador 'acomp:agenda_testes', um por
 * dia. Desliga com ACOMPANHAMENTO_AGENDA_TESTES=false.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { buscarAgendaDeTestes, buscarEquipe } from './prescrev.js';
import { equipeAtivada } from './encaminhamentos.js';
import { emHorario } from './horario.js';
import { agoraSP } from './aviso-sessoes.js';

const MARCA = 'acomp:agenda_testes';
export const SENT_BY_AGENDA = 'bot:agenda_testes';

/** "17:30" → "17h30"; "17:00" → "17h". */
const horaCurta = (hhmm) => {
  const [h, m] = String(hhmm).split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};

const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] ?? '';

/** Uma linha da agenda: o horário, o aluno, a duração e o link. */
function linha(m, url) {
  return `• ${horaCurta(m.hora)} · ${m.cliente_nome} (${m.duracao_min} min)\n  ${url.replace(/\/$/, '')}${m.caminho}`;
}

/**
 * PURA: o que mandar a cada professor agora, e a marca nova.
 *
 * @param {object} p
 * @param {object[]} p.marcacoes   as do dia, do Prescrev (canceladas inclusive)
 * @param {object|null} p.marca    { dia, avisados: {id: 'marcado'|'cancelado'}, comecou: {profile_id: true} }
 * @param {object[]} p.pessoas     quem ativou o EQUIPE e está no horário agora: { profile_id, phone, nome }
 * @param {string} p.dia           hoje em São Paulo
 * @param {Date} p.agora
 * @param {string} p.url           o endereço do Prescrev
 * @returns {{ envios: {profile_id: string, phone: string, nome: string, texto: string, ids: string[]}[], marca: object }}
 */
export function avisosDaAgenda({ marcacoes, marca, pessoas, dia, agora, url }) {
  const atual = marca?.dia === dia
    ? { dia, avisados: { ...(marca.avisados ?? {}) }, comecou: { ...(marca.comecou ?? {}) } }
    : { dia, avisados: {}, comecou: {} };
  const envios = [];

  for (const p of pessoas) {
    const dele = marcacoes.filter(m => m.professor_id === p.profile_id);
    const vindo = dele
      .filter(m => !m.cancelado_em && Date.parse(m.inicio) > agora.getTime())
      .sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio));
    const saiu = dele.filter(m => m.cancelado_em && atual.avisados[m.id] === 'marcado' && Date.parse(m.inicio) > agora.getTime());
    const nome = primeiroNome(p.nome);
    const partes = [];

    if (!atual.comecou[p.profile_id]) {
      // O começo do turno: a agenda do dia inteiro, quando há o que aplicar.
      if (vindo.length) {
        partes.push(`${nome}, sua agenda de testes de hoje:\n\n` +
          vindo.map(m => linha(m, url)).join('\n') +
          '\n\nO protocolo de cada um está na tela de testes do link.');
      }
    } else {
      const novos = vindo.filter(m => !atual.avisados[m.id]);
      if (novos.length) {
        partes.push(`${nome}, ${novos.length === 1 ? 'entrou um teste' : 'entraram testes'} na sua agenda de hoje:\n\n` +
          novos.map(m => linha(m, url)).join('\n'));
      }
      if (saiu.length) {
        const verbo = saiu.length === 1 ? 'saiu da sua agenda de hoje' : 'saíram da sua agenda de hoje';
        partes.push(`${partes.length ? verbo.charAt(0).toUpperCase() + verbo.slice(1) : `${nome}, ${verbo}`}: ` +
          saiu.map(m => `${horaCurta(m.hora)} · ${m.cliente_nome}`).join('; ') + '.');
      }
    }

    // A marca anda mesmo sem mensagem: o professor no turno já "viu" o dia.
    atual.comecou[p.profile_id] = true;
    for (const m of vindo) atual.avisados[m.id] = 'marcado';
    for (const m of saiu) atual.avisados[m.id] = 'cancelado';
    if (partes.length) {
      envios.push({ profile_id: p.profile_id, phone: p.phone, nome: p.nome, texto: partes.join('\n\n'), ids: [...vindo, ...saiu].map(m => m.id) });
    }
  }
  return { envios, marca: atual };
}

/** Quem ativou o EQUIPE e está no horário agora, com o nome e o horário da lista do Prescrev. */
async function pessoasNoTurno(agora) {
  const [ativados, equipe] = await Promise.all([equipeAtivada(), buscarEquipe()]);
  const daLista = new Map(equipe.map(m => [m.profile_id, m]));
  return ativados
    .map(a => ({ ...a, membro: daLista.get(a.profile_id) }))
    .filter(a => a.membro && emHorario(a.membro.horario ?? null, agora))
    .map(a => ({ profile_id: a.profile_id, phone: a.phone, nome: a.membro.nome ?? a.nome }));
}

/** O envio que falhou volta ao que a marca dizia antes: sai no próximo ciclo. PURA sobre `nova`. */
export function desfazer(nova, anterior, envio) {
  const antes = anterior?.dia === nova.dia ? anterior : { avisados: {}, comecou: {} };
  if (antes.comecou?.[envio.profile_id]) nova.comecou[envio.profile_id] = true;
  else delete nova.comecou[envio.profile_id];
  for (const id of envio.ids) {
    if (antes.avisados?.[id]) nova.avisados[id] = antes.avisados[id];
    else delete nova.avisados[id];
  }
  return nova;
}

let avisando = false;

/** Confere e manda. Chamado no ciclo dos encaminhamentos; nunca lança. Devolve quantos saíram. */
export async function avisarAgendaDeTestes(agora = new Date()) {
  if (!config.acompanhamento.agendaTestes?.habilitado || avisando) return 0;
  avisando = true;
  try {
    const pessoas = await pessoasNoTurno(agora);
    if (!pessoas.length) return 0;
    const { dia, marcacoes } = await buscarAgendaDeTestes(agoraSP(agora).dia);
    const marca = (await lerMarcador(MARCA))?.valor ?? null;
    const r = avisosDaAgenda({ marcacoes, marca, pessoas, dia, agora, url: config.acompanhamento.prescrev.url });

    let saiu = 0;
    for (const e of r.envios) {
      try {
        const contato = await getOrCreateContact(e.phone, e.nome);
        const conversa = await getOrCreateConversation(contato.id);
        const resposta = await sendText(e.phone, e.texto);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: e.texto,
          contentType: 'text', sentBy: SENT_BY_AGENDA, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { agenda_testes: dia },
        });
        saiu++;
      } catch (err) {
        logger.warn(`[agenda-testes] Aviso a ${e.nome} não saiu:`, err.message);
        desfazer(r.marca, marca, e);
      }
    }
    await carimbarMarcador(MARCA, r.marca);
    if (saiu) logger.info(`[agenda-testes] Agenda do dia enviada a ${saiu} professor(es).`);
    return saiu;
  } catch (err) {
    logger.warn('[agenda-testes] Agenda não conferida:', err.message);
    return 0;
  } finally {
    avisando = false;
  }
}
