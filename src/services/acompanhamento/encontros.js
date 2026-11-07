/**
 * src/services/acompanhamento/encontros.js
 * Os encontros de meta pelo WhatsApp (06/11/2026, Prescrev 063).
 *
 * Decisões do responsável: o encontro de meta é pós-avaliação e se marca
 * aqui, sem passar pelo professor.
 *
 *   o convite     3 dias antes da semana do encontro (a programação da
 *                 trilha, no Prescrev), a Leia convida o aluno com o horário
 *                 em que ele costuma treinar, entre os livres do professor
 *                 responsável. O texto vem pronto do Prescrev
 *                 (`MENSAGENS_DO_ENCONTRO`, que passa no lint de voz de lá)
 *   a marcação    o aluno aceita ou pede outro, e a Leia marca sozinha
 *                 (`marcar_encontro`, leia.js) e reserva a sessão no EVO —
 *                 a sessão também tem treino. Desmarcar e remarcar também
 *                 são da Leia
 *   o professor   recebe os encontros do dia no começo do turno, e de novo
 *                 quando entra ou sai um — como a agenda de testes. Sem
 *                 decisão do aluno, a conduta `encontro_meta` (Prescrev)
 *                 pede que ele marque
 *   a véspera     o aluno recebe o lembrete
 *
 * A sessão do EVO se reserva com a origem 6 (`ORIGEM_RESERVA_ANTECIPADA`), a
 * única que passa da janela de 48 h do app. Cancelada pela API, o EVO a grava
 * como "Falta": o Prescrev guarda o que a Leia cancelou e não a conta.
 *
 * Tudo desligado com ACOMPANHAMENTO_ENCONTROS=false (o padrão); o envio ao
 * aluno também para com ACOMPANHAMENTO_DRY_RUN.
 */
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { carimbarMarcador, lerMarcador } from '../controle.js';
import { sendText } from '../evolution.js';
import { getOrCreateContact, getOrCreateConversation, saveMessage } from '../contacts.js';
import {
  buscarAgendaDeEncontros, buscarConvitesDeEncontro, buscarVagasDeEncontro, desmarcarEncontroNoPrescrev,
  marcarEncontroNoPrescrev, registrarSessaoDoEncontro,
} from './prescrev.js';
import { desfazer, pessoasNoTurno } from './agenda-testes.js';
import { agoraSP } from './aviso-sessoes.js';
import { supabase } from '../../lib/supabase.js';
import { dentroDaJanela } from '../followup.js';
import { estaSuprimido } from '../campanhas.js';
import { limiteEnvio } from '../limite-envio.js';
import { SENT_BY_REGUA } from './conversa.js';
import { primeiroNome } from './render.js';
import {
  ORIGEM_RESERVA_ANTECIPADA, buscarGrade, cancelarReservaEmSessao, reservarEmSessao, sessoesDaPessoa,
} from '../evo-client.js';

export const SENT_BY_ENCONTROS = 'bot:agenda_encontros';
const habilitado = () => config.acompanhamento.encontros?.habilitado === true;

export const ATIVIDADE = { musculacao: 'musculação', natacao: 'natação' };
/** As atividades do EVO de cada modalidade, quando a ficha não as traz (a semente do catálogo do Prescrev). */
const IDS_PADRAO = { musculacao: [18, 41], natacao: [54] };
const SEMANA_LONGA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "17:30" → "17h30"; "17:00" → "17h". */
export const horaCurta = (hhmm) => {
  const [h, m] = String(hhmm).split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};

/** "terça, 17/11, às 7h15, na musculação, com Rogério". PURA. */
export function encontroPorExtenso(m) {
  const semana = SEMANA_LONGA[new Date(`${m.dia}T12:00:00Z`).getUTCDay()];
  const quem = primeiroNome(m.professor_nome ?? '');
  return `${semana}, ${m.dia.slice(8, 10)}/${m.dia.slice(5, 7)}, às ${horaCurta(m.hora)}, na ${ATIVIDADE[m.modalidade] ?? m.modalidade}` +
    (quem ? `, com ${quem}` : '');
}

/** As atividades do EVO da modalidade, pela ficha. */
export function idsDaModalidade(ficha, modalidade) {
  const ids = (ficha?.modalidades ?? []).find(m => m.slug === modalidade)?.atividades_evo;
  return ids?.length ? ids : IDS_PADRAO[modalidade] ?? [];
}

/** A sessão da grade do encontro: a mesma atividade e o mesmo início. PURA. */
export function sessaoDaGrade(grade, { hora, idsEvo }) {
  return (grade ?? []).find(s => idsEvo.includes(s.idActivity) && String(s.startTime ?? '').slice(0, 5) === hora) ?? null;
}

/* --- a sessão do EVO --------------------------------------------------- */

/**
 * Reserva a sessão do encontro no EVO. Não reserva quando o aluno já tem a
 * sessão (ele mesmo marcou), nem com a sessão lotada. Devolve o que houve:
 * 'reservada', 'ja_tinha', 'lotada', 'sem_sessao', 'sem_cadastro', 'simulada' ou 'falhou'.
 */
export async function reservarSessaoDoEncontro({ marcacao, ficha }) {
  const idMember = ficha?.aluno?.evo_id;
  if (!idMember) return 'sem_cadastro';
  try {
    const grade = await buscarGrade({ date: marcacao.dia });
    const s = sessaoDaGrade(grade, { hora: marcacao.hora, idsEvo: idsDaModalidade(ficha, marcacao.modalidade) });
    if (!s) return 'sem_sessao';
    const dele = await sessoesDaPessoa({ idMember, de: marcacao.dia, ate: marcacao.dia });
    if (dele.some(x => x.idConfiguration === s.idConfiguration && x.statusID === 0)) return 'ja_tinha';
    if (Number.isFinite(s.capacity) && Number.isFinite(s.ocupation) && s.ocupation >= s.capacity) return 'lotada';
    const r = await reservarEmSessao({ idMember, idConfiguration: s.idConfiguration, data: marcacao.dia, origem: ORIGEM_RESERVA_ANTECIPADA });
    if (r?.dryRun) return 'simulada';
    await registrarSessaoDoEncontro({ id: marcacao.id, reservada: s.idConfiguration });
    return 'reservada';
  } catch (err) {
    logger.warn(`[encontros] Sessão do encontro ${marcacao.id} não reservada:`, err.message);
    return 'falhou';
  }
}

/** Cancela no EVO a sessão que a Leia reservou para o encontro. A que o aluno marcou sozinho fica. */
export async function cancelarSessaoDoEncontro({ marcacao, ficha }) {
  if (!marcacao.evo_reservado_em || marcacao.evo_cancelado_em || !marcacao.evo_id_configuration) return 'nada';
  const idMember = ficha?.aluno?.evo_id;
  if (!idMember) return 'sem_cadastro';
  try {
    const grade = await buscarGrade({ date: marcacao.dia });
    const s = grade.find(x => x.idConfiguration === marcacao.evo_id_configuration);
    if (!s) return 'sem_sessao';
    const r = await cancelarReservaEmSessao({
      idMember, idConfiguration: s.idConfiguration, data: marcacao.dia, idActivitySession: s.idAtividadeSessao,
    });
    if (r?.dryRun) return 'simulada';
    await registrarSessaoDoEncontro({ id: marcacao.id, cancelada: true });
    return 'cancelada';
  } catch (err) {
    logger.warn(`[encontros] Sessão do encontro ${marcacao.id} não cancelada:`, err.message);
    return 'falhou';
  }
}

/** A cópia da ficha aqui passa a dizer o encontro marcado até o próximo carregamento (que traz o mesmo do Prescrev). */
export async function atualizarEncontroNaFicha(clienteId, marcado) {
  const { data } = await supabase.from('acomp_fichas').select('ficha').eq('cliente_id', clienteId).maybeSingle();
  if (!data?.ficha) return;
  const ficha = data.ficha;
  ficha.encontro = { semana: null, de: null, ate: null, convite: null, ...(ficha.encontro ?? {}), marcado };
  await supabase.from('acomp_fichas').update({ ficha }).eq('cliente_id', clienteId);
}

/* --- o convite ---------------------------------------------------------- */

const MARCA_CONVITES = 'acomp:convites_encontro';
/** Quanto a marca guarda o convite enviado: a semana do encontro já passou. */
const GUARDA_CONVITE_DIAS = 30;
/** A rota de convites lê as fichas da unidade inteira: uma consulta por hora basta. */
const INTERVALO_CONVITES_MS = 60 * 60_000;

/**
 * PURA: os convites que saem agora. Um por aluno e semana do encontro; só a
 * inscrição ativa. A marca esquece o que tem mais de 30 dias.
 * @returns {{ sair: {convite: object, inscricao: object}[], marca: {enviados: Record<string, {em: string, estado: string}>} }}
 */
export function convitesQueSaem({ convites, marca, ativas, agora }) {
  const limite = agora.getTime() - GUARDA_CONVITE_DIAS * 86_400_000;
  const enviados = Object.fromEntries(Object.entries(marca?.enviados ?? {}).filter(([, v]) => Date.parse(v.em) >= limite));
  const sair = [];
  for (const c of convites ?? []) {
    if (enviados[`${c.cliente_id}|${c.semana}`]) continue;
    const inscricao = ativas.get(c.cliente_id);
    if (!inscricao) continue;
    sair.push({ convite: c, inscricao });
  }
  return { sair, marca: { enviados } };
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));
let consultadoEm = 0;
let convidando = false;

/** Manda o convite aos alunos da vez. Chamado no ciclo dos encaminhamentos; nunca lança. Devolve quantos saíram. */
export async function convidarParaEncontros(agora = new Date()) {
  if (!habilitado() || config.acompanhamento.dryRun || convidando) return 0;
  if (dentroDaJanela(agora).getTime() !== agora.getTime()) return 0;
  if (Date.now() - consultadoEm < INTERVALO_CONVITES_MS) return 0;
  convidando = true;
  consultadoEm = Date.now();
  try {
    const { convites } = await buscarConvitesDeEncontro(agoraSP(agora).dia);
    if (!convites?.length) return 0;
    const clientes = [...new Set(convites.map(c => c.cliente_id))];
    const { data: inscricoes, error } = await supabase.from('acomp_inscricoes')
      .select('cliente_id, phone, contact_id, status').eq('status', 'ativa').in('cliente_id', clientes);
    if (error) { logger.warn('[encontros] Inscrições não lidas:', error.message); return 0; }
    const ativas = new Map((inscricoes ?? []).map(i => [i.cliente_id, i]));

    const marca = (await lerMarcador(MARCA_CONVITES))?.valor ?? null;
    const r = convitesQueSaem({ convites, marca, ativas, agora });
    let saiu = 0;
    for (const { convite, inscricao } of r.sair) {
      const chave = `${convite.cliente_id}|${convite.semana}`;
      try {
        if (await estaSuprimido(inscricao.phone)) { r.marca.enviados[chave] = { em: new Date().toISOString(), estado: 'suprimido' }; continue; }
        const cota = await limiteEnvio.podeIniciarConversa();
        if (!cota.ok) { logger.info(`[encontros] Teto do número: ${cota.motivo}. O convite fica para o próximo ciclo.`); consultadoEm = 0; break; }
        if (saiu > 0) await esperar(20_000 + Math.random() * 20_000);
        const resposta = await sendText(inscricao.phone, convite.texto);
        const contato = await getOrCreateContact(inscricao.phone, null);
        const conversa = await getOrCreateConversation(contato.id);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: convite.texto,
          contentType: 'text', sentBy: SENT_BY_REGUA, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { acompanhamento: 'convite_encontro', cliente: convite.cliente_id, semana: convite.semana, sugestoes: convite.sugestoes },
        });
        r.marca.enviados[chave] = { em: new Date().toISOString(), estado: 'enviado' };
        await carimbarMarcador(MARCA_CONVITES, r.marca);
        saiu++;
        logger.info(`[encontros] Convite do encontro (semana ${convite.semana}) ao cliente ${convite.cliente_id}`);
      } catch (err) {
        logger.warn(`[encontros] Convite ao cliente ${convite.cliente_id} não saiu:`, err.message);
      }
    }
    await carimbarMarcador(MARCA_CONVITES, r.marca);
    return saiu;
  } catch (err) {
    logger.warn('[encontros] Convites não conferidos:', err.message);
    consultadoEm = 0;
    return 0;
  } finally {
    convidando = false;
  }
}

/* --- os encontros do dia ao professor ---------------------------------- */

const MARCA_AGENDA = 'acomp:agenda_encontros';

/** Uma linha: a sessão, o aluno, a modalidade, quando começa o encontro e o link. */
function linha(m, url) {
  const encontro = m.modalidade === 'natacao'
    ? `, encontro às ${horaCurta(somarMinutos(m.hora, 35))}` : '';
  return `• ${horaCurta(m.hora)} · ${m.cliente_nome} (${ATIVIDADE[m.modalidade] ?? m.modalidade}${encontro})\n  ${url.replace(/\/$/, '')}${m.caminho}`;
}

function somarMinutos(hhmm, n) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const t = h * 60 + m + n;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * PURA: o que mandar a cada professor agora, e a marca nova — o mesmo
 * formato da agenda de testes: no começo do turno a lista do dia; depois, o
 * que entrou e o que saiu.
 */
export function avisosDosEncontros({ marcacoes, marca, pessoas, dia, agora, url }) {
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
      if (vindo.length) {
        partes.push(`${nome}, seus encontros de meta de hoje:\n\n` + vindo.map(m => linha(m, url)).join('\n') +
          '\n\nSão 10 minutos durante a sessão: o que deu certo, a meta do próximo mês e o que muda primeiro.');
      }
    } else {
      const novos = vindo.filter(m => !atual.avisados[m.id]);
      if (novos.length) {
        partes.push(`${nome}, ${novos.length === 1 ? 'entrou um encontro de meta' : 'entraram encontros de meta'} na sua agenda de hoje:\n\n` +
          novos.map(m => linha(m, url)).join('\n'));
      }
      if (saiu.length) {
        const verbo = saiu.length === 1 ? 'saiu da sua agenda de hoje' : 'saíram da sua agenda de hoje';
        partes.push(`${partes.length ? verbo.charAt(0).toUpperCase() + verbo.slice(1) : `${nome}, ${verbo}`}: ` +
          saiu.map(m => `${horaCurta(m.hora)} · ${m.cliente_nome}`).join('; ') + '.');
      }
    }
    atual.comecou[p.profile_id] = true;
    for (const m of vindo) atual.avisados[m.id] = 'marcado';
    for (const m of saiu) atual.avisados[m.id] = 'cancelado';
    if (partes.length) envios.push({ profile_id: p.profile_id, phone: p.phone, nome: p.nome, texto: partes.join('\n\n'), ids: [...vindo, ...saiu].map(m => m.id) });
  }
  return { envios, marca: atual };
}

let avisando = false;

/** Confere e manda a agenda dos encontros. Chamado no ciclo dos encaminhamentos; nunca lança. */
export async function avisarAgendaDeEncontros(agora = new Date()) {
  if (!habilitado() || avisando) return 0;
  avisando = true;
  try {
    const pessoas = await pessoasNoTurno(agora);
    if (!pessoas.length) return 0;
    const { dia, marcacoes } = await buscarAgendaDeEncontros(agoraSP(agora).dia);
    const marca = (await lerMarcador(MARCA_AGENDA))?.valor ?? null;
    const r = avisosDosEncontros({ marcacoes, marca, pessoas, dia, agora, url: config.acompanhamento.prescrev.url });
    let saiu = 0;
    for (const e of r.envios) {
      try {
        const contato = await getOrCreateContact(e.phone, e.nome);
        const conversa = await getOrCreateConversation(contato.id);
        const resposta = await sendText(e.phone, e.texto);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: e.texto,
          contentType: 'text', sentBy: SENT_BY_ENCONTROS, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { agenda_encontros: dia },
        });
        saiu++;
      } catch (err) {
        logger.warn(`[encontros] Agenda a ${e.nome} não saiu:`, err.message);
        desfazer(r.marca, marca, e);
      }
    }
    await carimbarMarcador(MARCA_AGENDA, r.marca);
    if (saiu) logger.info(`[encontros] Agenda de encontros enviada a ${saiu} professor(es).`);
    return saiu;
  } catch (err) {
    logger.warn('[encontros] Agenda não conferida:', err.message);
    return 0;
  } finally {
    avisando = false;
  }
}

/* --- o lembrete da véspera ---------------------------------------------- */

const MARCA_VESPERA = 'acomp:lembrete_encontros';

/** A frase do lembrete com os marcadores. PURA. */
export function textoDoLembreteDoEncontro(modelo, m) {
  const nome = primeiroNome(m.cliente_nome);
  const semana = SEMANA_LONGA[new Date(`${m.dia}T12:00:00Z`).getUTCDay()];
  const texto = String(modelo ?? '')
    .replace(/\{hora\}/g, horaCurta(m.hora))
    .replace(/\{professor\}/g, primeiroNome(m.professor_nome) || 'o professor')
    .replace(/\{atividade\}/g, ATIVIDADE[m.modalidade] ?? m.modalidade)
    .replace(/\{dia\}/g, `${semana}, ${m.dia.slice(8, 10)}/${m.dia.slice(5, 7)}`);
  return nome ? texto.replace(/\{nome\}/g, nome) : texto.replace(/^\{nome\},\s*/, '').replace(/^./, c => c.toUpperCase());
}

/** PURA: os lembretes que saem agora, um por marcação de amanhã. */
export function lembretesDosEncontros({ marcacoes, modelo, marca, ativas, amanha }) {
  const atual = marca?.dia === amanha ? { dia: amanha, enviados: { ...(marca.enviados ?? {}) } } : { dia: amanha, enviados: {} };
  const sair = [];
  if (!modelo) return { sair, marca: atual };
  for (const m of marcacoes) {
    if (m.cancelado_em || atual.enviados[m.id]) continue;
    const inscricao = ativas.get(m.cliente_id);
    if (!inscricao) continue;
    sair.push({ marcacao: m, inscricao, texto: textoDoLembreteDoEncontro(modelo, m) });
  }
  return { sair, marca: atual };
}

let lembrando = false;

/** Confere e manda os lembretes de amanhã. Chamado no ciclo dos encaminhamentos; nunca lança. */
export async function lembrarVesperaDosEncontros(agora = new Date()) {
  if (!habilitado() || config.acompanhamento.dryRun || lembrando) return 0;
  if (dentroDaJanela(agora).getTime() !== agora.getTime()) return 0;
  lembrando = true;
  try {
    const amanha = new Date(Date.parse(`${agoraSP(agora).dia}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const { marcacoes, mensagens } = await buscarAgendaDeEncontros(amanha);
    const vivas = marcacoes.filter(m => !m.cancelado_em);
    if (!vivas.length) return 0;
    const { data: inscricoes, error } = await supabase.from('acomp_inscricoes')
      .select('cliente_id, phone, contact_id, status').eq('status', 'ativa').in('cliente_id', [...new Set(vivas.map(m => m.cliente_id))]);
    if (error) { logger.warn('[encontros] Inscrições não lidas:', error.message); return 0; }
    const ativas = new Map((inscricoes ?? []).map(i => [i.cliente_id, i]));
    const marca = (await lerMarcador(MARCA_VESPERA))?.valor ?? null;
    const r = lembretesDosEncontros({ marcacoes: vivas, modelo: mensagens?.vespera, marca, ativas, amanha });
    let saiu = 0;
    for (const { marcacao, inscricao, texto } of r.sair) {
      try {
        if (await estaSuprimido(inscricao.phone)) { r.marca.enviados[marcacao.id] = 'suprimido'; continue; }
        const cota = await limiteEnvio.podeIniciarConversa();
        if (!cota.ok) { logger.info(`[encontros] Teto do número: ${cota.motivo}. O lembrete fica para o próximo ciclo.`); break; }
        if (saiu > 0) await esperar(20_000 + Math.random() * 20_000);
        const resposta = await sendText(inscricao.phone, texto);
        const contato = await getOrCreateContact(inscricao.phone, null);
        const conversa = await getOrCreateConversation(contato.id);
        await saveMessage({
          conversationId: conversa.id, contactId: contato.id, direction: 'outbound', content: texto,
          contentType: 'text', sentBy: SENT_BY_REGUA, evolutionMsgId: resposta?.key?.id || null, status: 'sent',
          metadata: { acompanhamento: 'lembrete_encontro', marcacao: marcacao.id, inicio: marcacao.inicio },
        });
        r.marca.enviados[marcacao.id] = 'enviado';
        await carimbarMarcador(MARCA_VESPERA, r.marca);
        saiu++;
      } catch (err) {
        logger.warn(`[encontros] Lembrete ao cliente ${marcacao.cliente_id} não saiu:`, err.message);
      }
    }
    await carimbarMarcador(MARCA_VESPERA, r.marca);
    return saiu;
  } catch (err) {
    logger.warn('[encontros] Lembretes da véspera não conferidos:', err.message);
    return 0;
  } finally {
    lembrando = false;
  }
}

/* --- as ferramentas da Leia --------------------------------------------- */

export const FERRAMENTAS_DO_ENCONTRO = ['horarios_do_encontro', 'marcar_encontro', 'desmarcar_encontro'];

const ddmm = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

/** O que dizer da sessão do EVO, para a Leia contar ao aluno. PURA. */
export function textoDaSessao(estado) {
  if (estado === 'reservada') return 'A sessão ficou reservada no app: diga que já está tudo marcado, encontro e treino.';
  if (estado === 'ja_tinha') return 'Ele já tinha essa sessão marcada no app: diga que o encontro ficou nela.';
  if (estado === 'lotada') return 'A sessão está lotada no app: o encontro está marcado; diga que ele pode vir só para a conversa ou agendar o treino em outro horário.';
  return 'Não deu para reservar a sessão no app agora: peça que ele agende a sessão pelo app, porque também vai ter treino.';
}

/** A marcação como a ficha a guarda (`encontro.marcado`). */
const marcadoNaFicha = (m) => ({
  id: m.id, inicio: m.inicio, dia: m.dia, hora: m.hora, modalidade: m.modalidade,
  professor_id: m.professor_id, professor_nome: m.professor_nome,
});

/**
 * Executa uma ferramenta do encontro para a Leia. Nunca lança: devolve
 * `{ success, ... }` com o que ela precisa para responder ao aluno.
 * `deps` existe para o teste trocar o Prescrev e o EVO.
 */
export async function ferramentaDoEncontro(nome, args, { ficha, clienteId, turno }, deps = {}) {
  const d = {
    habilitado, buscarVagas: buscarVagasDeEncontro, marcar: marcarEncontroNoPrescrev, desmarcar: desmarcarEncontroNoPrescrev,
    reservar: reservarSessaoDoEncontro, cancelar: cancelarSessaoDoEncontro, atualizarFicha: atualizarEncontroNaFicha,
    ...deps,
  };
  if (!d.habilitado()) {
    return { success: false, mensagem: 'A marcação do encontro pelo WhatsApp ainda não está ligada. Diga que o professor combina o horário com ele.' };
  }
  try {
    if (nome === 'horarios_do_encontro') {
      const r = await d.buscarVagas(clienteId);
      const professor = r.professor?.nome ?? null;
      const comProfessor = (v) => ({ dia: v.dia, hora: v.hora, modalidade: v.modalidade, texto: encontroPorExtenso(v) });
      const chaves = new Set((r.sugestoes ?? []).map(v => `${v.modalidade}|${v.inicio}`));
      return {
        success: true,
        professor: professor ? primeiroNome(professor) : null,
        marcado: r.marcado ? encontroPorExtenso({ ...r.marcado, professor_nome: professor }) : null,
        periodo: `${ddmm(r.de)} a ${ddmm(r.ate)}`,
        na_semana_do_encontro: !!r.na_semana,
        sugestoes: (r.sugestoes ?? []).map(comProfessor),
        outros_horarios: (r.vagas ?? []).filter(v => !chaves.has(`${v.modalidade}|${v.inicio}`)).slice(0, 12).map(comProfessor),
        mensagem: !professor ? 'O aluno não tem professor responsável: não marque; diga que a equipe combina com ele.'
          : !(r.vagas ?? []).length ? 'Sem horário livre com o professor no período: não marque; diga que o professor combina o horário com ele.' : null,
      };
    }

    if (nome === 'marcar_encontro') {
      const { dia, hora, modalidade } = args ?? {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia)) || !/^\d{2}:\d{2}$/.test(String(hora)) || !ATIVIDADE[modalidade]) {
        return { success: false, mensagem: 'Faltam o dia (AAAA-MM-DD), a hora (HH:MM) ou a modalidade (musculacao ou natacao) de um horário de horarios_do_encontro.' };
      }
      const r = await d.marcar({ cliente: clienteId, dia, hora, modalidade });
      for (const a of r.anteriores ?? []) await d.cancelar({ marcacao: a, ficha });
      const sessao = await d.reservar({ marcacao: r.marcacao, ficha });
      await d.atualizarFicha(clienteId, marcadoNaFicha(r.marcacao)).catch(() => {});
      const marcado = encontroPorExtenso(r.marcacao);
      turno?.encontros?.push({ acao: 'marcar', marcado, sessao, remarcado: (r.anteriores ?? []).length > 0 });
      return { success: true, marcado, sessao, mensagem: textoDaSessao(sessao) };
    }

    if (nome === 'desmarcar_encontro') {
      const r = await d.desmarcar(clienteId);
      for (const c of r.canceladas ?? []) await d.cancelar({ marcacao: c, ficha });
      await d.atualizarFicha(clienteId, null).catch(() => {});
      const desmarcados = (r.canceladas ?? []).map(encontroPorExtenso);
      turno?.encontros?.push({ acao: 'desmarcar', desmarcados });
      return {
        success: true, desmarcados,
        mensagem: desmarcados.length
          ? 'Desmarcado, e a sessão reservada saiu do app. Ofereça outro horário com horarios_do_encontro, se ele quiser.'
          : 'Não havia encontro marcado.',
      };
    }
    return { success: false, mensagem: `Ferramenta "${nome}" não existe.` };
  } catch (err) {
    logger.warn(`[encontros] ${nome} falhou:`, err.message);
    if (/HTTP 409/.test(err.message)) {
      return { success: false, mensagem: 'Esse horário não está mais livre. Chame horarios_do_encontro e ofereça outro.' };
    }
    return { success: false, mensagem: 'Não consegui mexer na agenda agora. Diga que o professor confirma o horário com ele.' };
  }
}
