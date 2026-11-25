/**
 * src/services/acompanhamento/pa.js
 * O lembrete de aferir a PA, no dia da sessão (25/11/2026; Prescrev 070).
 *
 * Decisões do responsável: a avaliação com PA no estágio 2 ou acima
 * (sistólica >= 160 ou diastólica >= 100) abre, no Prescrev, o protocolo de
 * aferir a PA nas próximas 3 sessões em que a pessoa vier. Todo aluno agenda
 * a sessão no EVO antes de passar na catraca, então a sessão do dia diz a
 * hora e quem dá a aula. Até 1 hora antes dela, sai UM lembrete:
 *
 *   quem dá a aula é do time do Prescrev,   a ele, direto
 *   ativou o EQUIPE e está no turno
 *
 *   senão                                   a um professor do Prescrev que
 *                                           esteja no turno agora e na hora
 *                                           da sessão, pedindo que avise quem
 *                                           dá a aula (o que recebeu menos
 *                                           lembretes hoje)
 *
 * Sem ninguém no turno, não sai — e a tela "PA em acompanhamento" do Prescrev
 * mostra a sessão que passou sem aferição. Um lembrete por aluno e dia: a
 * marca 'acomp:pa' guarda quem já foi avisado. Aferido no dia, o Prescrev
 * tira o aluno da lista.
 *
 * É mensagem de OPERAÇÃO para a equipe, como a agenda de testes: não passa
 * pela régua do aluno nem conta no teto do número. Nasce DESLIGADO: liga com
 * ACOMPANHAMENTO_PA=true, depois de o responsável conferir os textos.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { sessoesDaPessoa } from '../evo-client.js';
import { horarioDaSessao } from '../avaliacao-avisos-regras.js';
import { buscarEquipe, buscarProtocolosDePa } from './prescrev.js';
import { equipeAtivada } from './encaminhamentos.js';
import { emHorario } from './horario.js';
import { agoraSP } from './aviso-sessoes.js';
import { primeiroNome } from './render.js';

const MARCA = 'acomp:pa';
export const SENT_BY_PA = 'bot:pa';

/** O lembrete sai até este tanto antes da sessão. */
export const ANTECEDENCIA_MS = 60 * 60_000;
/** E ainda sai com a sessão recém-começada: a aferição cabe no começo dela. */
export const TOLERANCIA_MS = 10 * 60_000;

/** "17:30" em São Paulo de um Date → "17h30"; em ponto, "17h". */
export function horaCurtaDe(data) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(data).map(x => [x.type, x.value]));
  return `${Number(p.hour)}h${p.minute === '00' ? '' : p.minute}`;
}

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

/**
 * O instrutor da sessão do EVO ("VANESSA ROBERT", "GUSTAVO ") é esta pessoa
 * do Prescrev? Pelo nome: o primeiro bate, e o último também quando o EVO
 * traz mais de um. PURA.
 */
export function mesmoProfessor(instrutor, nomeCompleto) {
  const a = semAcento(instrutor).split(/\s+/).filter(Boolean);
  const b = semAcento(nomeCompleto).split(/\s+/).filter(Boolean);
  if (!a.length || !b.length || a[0] !== b[0]) return false;
  return a.length === 1 || b.length === 1 || a[a.length - 1] === b[b.length - 1];
}

/** A sessão do dia que pede o lembrete agora: a primeira, ainda marcada, na janela. PURA. */
export function sessaoDoLembrete(sessoes, agora) {
  return (sessoes ?? [])
    .filter(s => s?.statusID === 0 || s?.statusID === undefined || s?.statusID === null)
    .map(s => ({
      em: horarioDaSessao(s),
      instrutor: String(s.instructor ?? '').trim() || null,
      atividade: String(s.name ?? s.activityDescription ?? s.activity ?? '').trim() || null,
    }))
    .filter(x => x.em && x.em.getTime() - agora.getTime() <= ANTECEDENCIA_MS && agora.getTime() - x.em.getTime() <= TOLERANCIA_MS)
    .sort((a, b) => a.em - b.em)[0] ?? null;
}

const ORDINAL = { 1: '1ª', 2: '2ª', 3: '3ª' };

/** O texto do lembrete. PURA. `direto` = quem recebe é quem dá a aula. */
export function textoDoLembreteDePa({ quem, protocolo, sessao, direto, total, url }) {
  const link = `${url.replace(/\/$/, '')}${protocolo.caminho}`;
  const hora = horaCurtaDe(sessao.em);
  const onde = sessao.atividade ? ` (${sessao.atividade})` : '';
  const qual = `É a ${ORDINAL[protocolo.proxima] ?? `${protocolo.proxima}ª`} de ${total} aferições do protocolo de PA: ` +
    'elas mostram se a pressão alta da avaliação se repete.';
  const instrutor = primeiroNome(sessao.instrutor ?? '');
  const abre = `${primeiroNome(quem)}, ${protocolo.cliente_nome} tem sessão às ${hora}${onde}`;
  const pedido = direto
    ? `${abre} com você. Afere a pressão antes de começar.`
    : instrutor
      ? `${abre} com ${instrutor}. Avisa ${instrutor} para aferir a pressão antes de começar.`
      : `${abre}. Avisa quem dá a aula para aferir a pressão antes de começar.`;
  return `${pedido} ${qual}\n\nRegistra aqui:\n${link}`;
}

/**
 * PURA: os lembretes que saem agora, e a marca nova.
 *
 * @param {object} p
 * @param {object[]} p.protocolos  do Prescrev: { cliente_id, cliente_nome, evo_id, proxima, caminho }
 * @param {Map<string, object[]>} p.sessoesDe  cliente_id → as sessões de hoje, do EVO
 * @param {object[]} p.pessoas     quem ativou o EQUIPE e está no turno agora: { profile_id, phone, nome, nome_completo, horario }
 * @param {object|null} p.marca    { dia, avisados: { cliente_id: profile_id } }
 * @returns {{ envios: object[], marca: object }}
 */
export function lembretesDePa({ protocolos, sessoesDe, pessoas, marca, dia, agora, url, total = 3 }) {
  const atual = marca?.dia === dia ? { dia, avisados: { ...(marca.avisados ?? {}) } } : { dia, avisados: {} };
  const envios = [];
  const recebidos = new Map();
  for (const id of Object.values(atual.avisados)) recebidos.set(id, (recebidos.get(id) ?? 0) + 1);

  for (const protocolo of protocolos ?? []) {
    if (atual.avisados[protocolo.cliente_id]) continue;
    const sessao = sessaoDoLembrete(sessoesDe.get(protocolo.cliente_id), agora);
    if (!sessao) continue;

    const daAula = sessao.instrutor ? pessoas.find(p => mesmoProfessor(sessao.instrutor, p.nome_completo ?? p.nome)) : null;
    // Quem repassa precisa estar no turno também na hora da sessão.
    const quem = daAula ?? [...pessoas]
      .filter(p => emHorario(p.horario ?? null, sessao.em))
      .sort((a, b) => (recebidos.get(a.profile_id) ?? 0) - (recebidos.get(b.profile_id) ?? 0)
        || String(a.nome).localeCompare(String(b.nome), 'pt-BR'))[0];
    if (!quem) continue; // ninguém no turno: tenta no próximo ciclo, e a tela do Prescrev mostra

    atual.avisados[protocolo.cliente_id] = quem.profile_id;
    recebidos.set(quem.profile_id, (recebidos.get(quem.profile_id) ?? 0) + 1);
    envios.push({
      cliente_id: protocolo.cliente_id, profile_id: quem.profile_id, phone: quem.phone, nome: quem.nome,
      direto: !!daAula,
      texto: textoDoLembreteDePa({ quem: quem.nome, protocolo, sessao, direto: !!daAula, total, url }),
    });
  }
  return { envios, marca: atual };
}

/** As sessões de hoje de cada aluno, do EVO, guardadas 20 minutos: o ciclo roda a cada poucos minutos. */
const CACHE_MS = 20 * 60_000;
const cache = new Map();
async function sessoesDeHoje(evoId, dia) {
  const chave = `${dia}|${evoId}`;
  const guardado = cache.get(chave);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return guardado.sessoes;
  const sessoes = await sessoesDaPessoa({ idMember: evoId, de: dia, ate: dia });
  for (const k of cache.keys()) if (!k.startsWith(`${dia}|`)) cache.delete(k);
  cache.set(chave, { em: Date.now(), sessoes });
  return sessoes;
}

/** Quem ativou o EQUIPE e está no horário agora, com o nome completo e o horário da lista do Prescrev. */
async function pessoasNoTurnoComHorario(agora) {
  const [ativados, equipe] = await Promise.all([equipeAtivada(), buscarEquipe()]);
  const daLista = new Map(equipe.map(m => [m.profile_id, m]));
  return ativados
    .map(a => ({ ...a, membro: daLista.get(a.profile_id) }))
    .filter(a => a.membro && emHorario(a.membro.horario ?? null, agora))
    .map(a => ({
      profile_id: a.profile_id, phone: a.phone, nome: a.membro.nome ?? a.nome,
      nome_completo: a.membro.nome_completo ?? a.membro.nome ?? a.nome, horario: a.membro.horario ?? null,
    }));
}

let lembrando = false;

/** Confere e manda. Chamado no ciclo dos encaminhamentos; nunca lança. Devolve quantos saíram. */
export async function lembrarAfericoesDePa(agora = new Date()) {
  if (!config.acompanhamento.pa?.habilitado || lembrando) return 0;
  lembrando = true;
  try {
    const { dia, protocolos, total } = await buscarProtocolosDePa();
    if (!protocolos.length || dia !== agoraSP(agora).dia) return 0;
    const marca = (await lerMarcador(MARCA))?.valor ?? null;
    const pendentes = protocolos.filter(p => !(marca?.dia === dia && marca.avisados?.[p.cliente_id]));
    if (!pendentes.length) return 0;
    const pessoas = await pessoasNoTurnoComHorario(agora);
    if (!pessoas.length) return 0;

    const sessoesDe = new Map();
    for (const p of pendentes) {
      try {
        sessoesDe.set(p.cliente_id, await sessoesDeHoje(p.evo_id, dia));
      } catch (err) {
        logger.warn(`[pa] Sessões do cliente ${p.cliente_id} não lidas no EVO:`, err.message);
      }
    }

    const r = lembretesDePa({ protocolos: pendentes, sessoesDe, pessoas, marca, dia, agora, url: config.acompanhamento.prescrev.url, total });
    let saiu = 0;
    for (const e of r.envios) {
      try {
        const contato = await getOrCreateContact(e.phone, e.nome);
        const conversa = await getOrCreateConversation(contato.id);
        const resposta = await sendText(e.phone, e.texto);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: e.texto,
          contentType: 'text', sentBy: SENT_BY_PA, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { pa: dia, cliente: e.cliente_id, direto: e.direto },
        });
        saiu++;
      } catch (err) {
        logger.warn(`[pa] Lembrete a ${e.nome} não saiu:`, err.message);
        delete r.marca.avisados[e.cliente_id]; // sai no próximo ciclo
      }
    }
    await carimbarMarcador(MARCA, r.marca);
    if (saiu) logger.info(`[pa] Lembretes de aferição: ${saiu} enviado(s).`);
    return saiu;
  } catch (err) {
    logger.warn('[pa] Lembretes de aferição não conferidos:', err.message);
    return 0;
  } finally {
    lembrando = false;
  }
}
