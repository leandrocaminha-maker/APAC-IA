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
 * dia. Desliga com ACOMPANHAMENTO_AGENDA_TESTES=false — o aviso ao professor
 * e o lembrete ao aluno na véspera (mais abaixo), os dois.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import { buscarAgendaDeTestes, buscarEquipe, buscarAvisosDaAvaliacao } from './prescrev.js';
import { equipeAtivada } from './encaminhamentos.js';
import { emHorario } from './horario.js';
import { agoraSP } from './aviso-sessoes.js';
import { supabase } from '../../lib/supabase.js';
import { dentroDaJanela } from '../followup.js';
import { estaSuprimido } from '../campanhas.js';
import { limiteEnvio } from '../limite-envio.js';
import { SENT_BY_REGUA } from './conversa.js';
// "maria souza" → "Maria": o mesmo das mensagens da régua.
import { primeiroNome } from './render.js';

const MARCA = 'acomp:agenda_testes';
export const SENT_BY_AGENDA = 'bot:agenda_testes';

/** "17:30" → "17h30"; "17:00" → "17h". */
const horaCurta = (hhmm) => {
  const [h, m] = String(hhmm).split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};


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

/* --- o lembrete ao aluno, na véspera --------------------------------------
 *
 * Decisão do responsável em 05/11/2026: na véspera, quem ATIVOU o
 * acompanhamento recebe o lembrete da sessão de testes. A frase vem do
 * Prescrev (`mensagens.vespera`, que passa no lint de voz de lá), e o APAC
 * preenche {nome}, {hora} e {professor}. Sai como mensagem do acompanhamento
 * (`SENT_BY_REGUA`): a resposta do aluno vai à Leia, que passa o pedido de
 * remarcar a quem aplica os testes. Como o relatório em PDF: só a inscrição
 * ativa, número não suprimido, na janela de contato e com cota no teto. Um
 * lembrete por marcação: a remarcada para amanhã é outra marcação, e recebe o
 * dela. Desligado com ACOMPANHAMENTO_DRY_RUN, como o resto do envio ao aluno.
 */

const MARCA_VESPERA = 'acomp:lembrete_testes';

/** A frase do lembrete com os marcadores preenchidos. PURA. */
export function textoDoLembrete(modelo, m) {
  const nome = primeiroNome(m.cliente_nome);
  const professor = primeiroNome(m.professor_nome) || 'o professor';
  const texto = String(modelo ?? '')
    .replace(/\{hora\}/g, horaCurta(m.hora))
    .replace(/\{professor\}/g, professor);
  return nome ? texto.replace(/\{nome\}/g, nome) : texto.replace(/^\{nome\},\s*/, '').replace(/^./, c => c.toUpperCase());
}

/**
 * PURA: os lembretes que saem agora, para as marcações de amanhã.
 * @param {{ marcacoes: object[], modelo: string, marca: object|null, ativas: Map<string, object>, amanha: string }} p
 * @returns {{ sair: {marcacao: object, inscricao: object, texto: string}[], marca: {dia: string, enviados: object} }}
 */
export function lembretesDaVespera({ marcacoes, modelo, marca, ativas, amanha }) {
  const atual = marca?.dia === amanha ? { dia: amanha, enviados: { ...(marca.enviados ?? {}) } } : { dia: amanha, enviados: {} };
  const sair = [];
  if (!modelo) return { sair, marca: atual };
  for (const m of marcacoes) {
    if (m.cancelado_em || atual.enviados[m.id]) continue;
    const inscricao = ativas.get(m.cliente_id);
    if (!inscricao) continue;
    sair.push({ marcacao: m, inscricao, texto: textoDoLembrete(modelo, m) });
  }
  return { sair, marca: atual };
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));
let lembrando = false;

/** Confere e manda os lembretes de amanhã. Chamado no ciclo dos encaminhamentos; nunca lança. Devolve quantos saíram. */
export async function lembrarVesperaDosTestes(agora = new Date()) {
  if (!config.acompanhamento.agendaTestes?.habilitado || config.acompanhamento.dryRun || lembrando) return 0;
  if (dentroDaJanela(agora).getTime() !== agora.getTime()) return 0;
  lembrando = true;
  try {
    const amanha = new Date(Date.parse(`${agoraSP(agora).dia}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const { marcacoes, mensagens } = await buscarAgendaDeTestes(amanha);
    const vivas = marcacoes.filter(m => !m.cancelado_em);
    if (!vivas.length) return 0;

    const clientes = [...new Set(vivas.map(m => m.cliente_id))];
    const { data: inscricoes, error } = await supabase.from('acomp_inscricoes')
      .select('cliente_id, phone, contact_id, status').eq('status', 'ativa').in('cliente_id', clientes);
    if (error) { logger.warn('[agenda-testes] Inscrições não lidas:', error.message); return 0; }
    const ativas = new Map((inscricoes ?? []).map(i => [i.cliente_id, i]));

    const marca = (await lerMarcador(MARCA_VESPERA))?.valor ?? null;
    const r = lembretesDaVespera({ marcacoes: vivas, modelo: mensagens?.vespera, marca, ativas, amanha });
    let saiu = 0;
    for (const { marcacao, inscricao, texto } of r.sair) {
      try {
        if (await estaSuprimido(inscricao.phone)) { r.marca.enviados[marcacao.id] = 'suprimido'; continue; }
        const cota = await limiteEnvio.podeIniciarConversa();
        if (!cota.ok) { logger.info(`[agenda-testes] Teto do número: ${cota.motivo}. O lembrete fica para o próximo ciclo.`); break; }
        // Número Baileys não manda rajada.
        if (saiu > 0) await esperar(20_000 + Math.random() * 20_000);
        const resposta = await sendText(inscricao.phone, texto);
        const contato = await getOrCreateContact(inscricao.phone, null);
        const conversa = await getOrCreateConversation(contato.id);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: texto,
          contentType: 'text', sentBy: SENT_BY_REGUA, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { acompanhamento: 'lembrete_testes', marcacao: marcacao.id, inicio: marcacao.inicio },
        });
        r.marca.enviados[marcacao.id] = 'enviado';
        // A marca a cada envio: um reinício no meio não manda o mesmo lembrete duas vezes.
        await carimbarMarcador(MARCA_VESPERA, r.marca);
        saiu++;
        logger.info(`[agenda-testes] Lembrete da véspera ao cliente ${marcacao.cliente_id}`);
      } catch (err) {
        logger.warn(`[agenda-testes] Lembrete ao cliente ${marcacao.cliente_id} não saiu:`, err.message);
      }
    }
    await carimbarMarcador(MARCA_VESPERA, r.marca);
    return saiu;
  } catch (err) {
    logger.warn('[agenda-testes] Lembretes da véspera não conferidos:', err.message);
    return 0;
  } finally {
    lembrando = false;
  }
}

/* --- os avisos da avaliação à equipe -------------------------------------
 *
 * Decisões do responsável em 05/11/2026 (Prescrev 061):
 *
 *   testes finalizados   ao fechar a avaliação, o AVALIADOR — quem fez a
 *                        consulta — é avisado quando não foi ele quem fechou:
 *                        é ele quem faz a conferência final e os ajustes do
 *                        radar no relatório completo
 *   relatório final      quando o avaliador designou OUTRO profissional como
 *                        responsável pelo acompanhamento, esse profissional é
 *                        avisado assim que o relatório completo é gerado, com
 *                        o link para ele no Prescrev
 *
 * Quem recebe e a chave de cada aviso, o Prescrev diz
 * (`/api/acompanhamento/avisos-avaliacao`); refeito depois de reaberto, é
 * outra chave. Sai no horário de trabalho de quem recebe, se ativou o
 * EQUIPE; fora dele, espera o próximo ciclo. A marca guarda o que saiu por 7
 * dias.
 */

const MARCA_AVISOS = 'acomp:avisos_avaliacao';
const GUARDA_MS = 7 * 86_400_000;

/** "06/11, às 17h40", em São Paulo. */
function quandoSP(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.day}/${p.month}, às ${horaCurta(`${p.hour}:${p.minute}`)}`;
}

/** O texto de cada aviso. PURA. */
export function textoDoAviso(tipo, a, nomeDeQuemRecebe, url) {
  const link = `${url.replace(/\/$/, '')}${a.caminho}`;
  const quem = primeiroNome(nomeDeQuemRecebe);
  if (tipo === 'finalizado') {
    return `${quem}, ${primeiroNome(a.por_nome)} finalizou os testes de ${a.cliente_nome} em ${quandoSP(a.em)}. ` +
      `Agora é com você: a conferência final e o ajuste do radar no relatório completo.\n\n${link}`;
  }
  const avaliador = primeiroNome(a.avaliador_nome ?? '');
  return `${quem}, o relatório completo de ${a.cliente_nome} está pronto. Você é responsável pelo acompanhamento` +
    `${avaliador ? `, por designação de ${avaliador}` : ''}: o relatório traz os resultados e as metas que vocês vão ` +
    `acompanhar.\n\n${link}`;
}

/**
 * PURA: os avisos que saem agora, e a marca nova.
 * @param {{ finalizados: object[], relatorios: object[], marca: object|null, pessoas: object[], agora: Date, url: string }} p
 *   pessoas — quem ativou o EQUIPE e está no horário agora: { profile_id, phone, nome }
 */
export function avisosDaAvaliacao({ finalizados, relatorios, marca, pessoas, agora, url }) {
  const limite = agora.getTime() - GUARDA_MS;
  const avisados = Object.fromEntries(Object.entries(marca?.avisados ?? {}).filter(([, em]) => Date.parse(em) >= limite));
  const noTurno = new Map(pessoas.map(p => [p.profile_id, p]));
  const envios = [];
  for (const [tipo, lista] of [['finalizado', finalizados], ['relatorio', relatorios]]) {
    for (const a of lista ?? []) {
      if (avisados[a.chave]) continue;
      const p = noTurno.get(a.para_id);
      if (!p) continue; // fora do turno ou sem EQUIPE: espera o próximo ciclo
      envios.push({ chave: a.chave, tipo, profile_id: p.profile_id, phone: p.phone, nome: p.nome, texto: textoDoAviso(tipo, a, p.nome, url) });
    }
  }
  return { envios, marca: { avisados } };
}

let avisandoAvaliacao = false;

/** Confere e manda. Chamado no ciclo dos encaminhamentos; nunca lança. Devolve quantos saíram. */
export async function avisarDaAvaliacao(agora = new Date()) {
  if (!config.acompanhamento.agendaTestes?.habilitado || avisandoAvaliacao) return 0;
  avisandoAvaliacao = true;
  try {
    const { finalizados, relatorios } = await buscarAvisosDaAvaliacao();
    if (!finalizados.length && !relatorios.length) return 0;
    const pessoas = await pessoasNoTurno(agora);
    const marca = (await lerMarcador(MARCA_AVISOS))?.valor ?? null;
    const r = avisosDaAvaliacao({ finalizados, relatorios, marca, pessoas, agora, url: config.acompanhamento.prescrev.url });
    let saiu = 0;
    for (const e of r.envios) {
      try {
        const contato = await getOrCreateContact(e.phone, e.nome);
        const conversa = await getOrCreateConversation(contato.id);
        const resposta = await sendText(e.phone, e.texto);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: e.texto,
          contentType: 'text', sentBy: SENT_BY_AGENDA, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { aviso_avaliacao: e.chave },
        });
        r.marca.avisados[e.chave] = new Date().toISOString();
        saiu++;
      } catch (err) {
        logger.warn(`[agenda-testes] Aviso da avaliação a ${e.nome} não saiu:`, err.message);
      }
    }
    await carimbarMarcador(MARCA_AVISOS, r.marca);
    if (saiu) logger.info(`[agenda-testes] Avisos da avaliação: ${saiu} enviado(s).`);
    return saiu;
  } catch (err) {
    logger.warn('[agenda-testes] Avisos da avaliação não conferidos:', err.message);
    return 0;
  } finally {
    avisandoAvaliacao = false;
  }
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
