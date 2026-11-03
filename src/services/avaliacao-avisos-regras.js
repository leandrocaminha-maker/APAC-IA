/**
 * src/services/avaliacao-avisos-regras.js
 * As regras dos avisos da avaliação física — PURAS, sem banco e sem rede.
 *
 * Decisão do responsável, 03/11/2026. Três mensagens a quem comprou a
 * avaliação (o serviço "AF E CONSULTORIA" do EVO):
 *
 *   venda      na compra: o link do questionário e o preparo da bioimpedância
 *   tres_dias  3 dias antes (automação 1 do CRM do EVO): o horário e o
 *              preparo; o link só se o questionário não chegou ao Prescrev
 *   vespera    24 h antes (automação 2): o horário, o preparo e até quando se
 *              desmarca sem a taxa de não comparecimento: até 12 h antes
 *
 * ## Por que três caminhos
 *
 * O EVO não avisa o agendamento. O `ActivityEnroll` está assinado desde o
 * começo e nunca chegou (evo-sync.js), e a sessão da avaliação é avulsa
 * (`idConfiguration: 0`): não aparece na grade da API, só nas sessões da
 * pessoa. A compra chega pelo webhook da venda, sem data. A data chega com
 * as automações do CRM, que disparam em relação à data agendada — e a
 * automação sozinha não manda link nem preparo, por isso ela vem para cá
 * por webhook e a mensagem sai daqui.
 *
 * ## Os textos
 *
 * Na voz da Leia (prompts/comunicacao.md do Prescrev, §1 e §2): conjugados,
 * "tá" e "pra", uma exclamação, nada de "anamnese" — decisão do responsável:
 * para o aluno é "o questionário". O preparo é o do cartaz da academia
 * ("Preparo Bioimpedância"), escrito em ações, e muda pelo sexo do cadastro
 * do EVO: a roupa, o período menstrual e a gravidez. Sem o sexo, sai o das
 * duas roupas.
 */
import { dentroDaJanela, horarioDoLembrete } from './followup.js';

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const OFFSET_SP_MS = -3 * HORA_MS;

/** A taxa de não comparecimento (o nome desde 03/11/2026; o cartaz dizia "remarcação") e até quando se desmarca sem ela. */
export const TAXA_NAO_COMPARECIMENTO = 'R$ 30';
export const DESMARCAR_ANTES_MS = 12 * HORA_MS;

/**
 * A véspera sai até 13 h antes: chegar depois de 12 h seria avisar de um
 * prazo de desmarcar já vencido, e uma hora é o mínimo para alguém agir.
 */
export const VESPERA_ANTECEDENCIA_MS = DESMARCAR_ANTES_MS + HORA_MS;

/** Venda recebida há mais do que isto não manda aviso: é reprocessamento, e não compra. */
export const VENDA_RECENTE_MS = 2 * DIA_MS;
/** O aviso da compra que não saiu em 3 dias não sai mais. */
export const VENDA_PRAZO_MS = 3 * DIA_MS;
/** Uma compra de avaliação por pessoa a cada 30 dias recebe o aviso. */
export const VENDA_INTERVALO_MS = 30 * DIA_MS;
/** O dos 3 dias não sai a quem recebeu o da compra há menos disto: seria o mesmo texto duas vezes. */
export const TRES_DIAS_DEPOIS_DA_VENDA_MS = DIA_MS;
/** O questionário conta se chegou até 60 dias antes da avaliação. */
export const QUESTIONARIO_JANELA_MS = 60 * DIA_MS;

// ──────────────────────────────────────────────
// Reconhecer a compra e a automação
// ──────────────────────────────────────────────

/**
 * A venda tem a avaliação física? Pelo id do serviço e, de rede, pelo nome.
 * A "REMARCAÇÃO AF E CONSULTORIA" (a taxa) não conta: é a mesma avaliação.
 */
export function temAvaliacaoNaVenda(detalhe, { servicos = [83] } = {}) {
  const itens = detalhe?.saleItens ?? detalhe?.saleItems ?? [];
  if (!Array.isArray(itens)) return false;
  return itens.some(i => {
    const nome = String(i?.item ?? '');
    if (/REMARCA/i.test(nome)) return false;
    return servicos.includes(Number(i?.idService)) || /^\s*AF E CONSULTORIA\s*$/i.test(nome);
  });
}

/**
 * Qual aviso esta automação do CRM do EVO pede, ou null se ela não é da
 * avaliação. Ela é da avaliação pelo nome (`eventLabel`, que a academia dá
 * ao criar a automação), e o aviso sai do quanto antes ela dispara.
 */
export function etapaDaAutomacao(payload, { rotulo = 'avalia' } = {}) {
  const nome = String(payload?.eventLabel ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '');
  if (!rotulo || !nome.toLowerCase().includes(rotulo.toLowerCase())) return null;
  const contexto = payload?.eventContext ?? {};
  if (String(contexto.moment ?? '').toLowerCase() === 'after') return null;
  const dias = Number(contexto.daysOffset);
  if (!Number.isFinite(dias)) return null;
  if (dias >= 2) return 'tres_dias';
  if (dias === 1) return 'vespera';
  return null;
}

// ──────────────────────────────────────────────
// A sessão da agenda
// ──────────────────────────────────────────────

/** "2026-11-03T00:00:00" + "17:00" → o Date do horário de São Paulo. */
export function horarioDaSessao(sessao) {
  const dia = String(sessao?.date ?? sessao?.activityDate ?? '').slice(0, 10);
  const [h, m] = String(sessao?.startTime ?? '').split(':').map(Number);
  const [ano, mes, d] = dia.split('-').map(Number);
  if (![ano, mes, d, h].every(Number.isFinite)) return null;
  return new Date(Date.UTC(ano, mes - 1, d, h, m || 0) - OFFSET_SP_MS);
}

/** O dia de São Paulo (AAAA-MM-DD) de um Date. */
export function diaSP(data) {
  return new Date(data.getTime() + OFFSET_SP_MS).toISOString().slice(0, 10);
}

/**
 * A sessão de avaliação que a automação anuncia: a das atividades da
 * avaliação, ainda por vir, no dia que a automação diz; sem ela, a próxima.
 */
export function sessaoDaAvaliacao(sessoes, { atividades = [9], diaAlvo = null, agora = new Date() } = {}) {
  const futuras = (sessoes ?? [])
    .filter(s => atividades.includes(Number(s?.idActivitie ?? s?.idActivity)))
    .map(s => ({ sessao: s, em: horarioDaSessao(s) }))
    .filter(x => x.em && x.em.getTime() > agora.getTime())
    .sort((a, b) => a.em - b.em);
  return futuras.find(x => diaAlvo && diaSP(x.em) === diaAlvo) ?? futuras[0] ?? null;
}

/** "VANESSA ROBERT" → "Vanessa"; "GUSTAVO " → "Gustavo". */
export function primeiroNome(nome) {
  const p = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : null;
}

/** "Female"/"female"/"F" → "F". */
export function generoDe(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.startsWith('f')) return 'F';
  if (s.startsWith('m')) return 'M';
  return null;
}

// ──────────────────────────────────────────────
// Quando cada aviso sai
// ──────────────────────────────────────────────

/** Agora, ou a próxima abertura da janela de contato, espalhada em até 45 min. */
export function horarioDeAgora(agora = new Date(), sorteio = Math.random) {
  const alvo = dentroDaJanela(agora);
  if (alvo.getTime() === agora.getTime()) return alvo;
  return new Date(alvo.getTime() + Math.floor(sorteio() * 45 * 60_000));
}

/**
 * Quando sai cada aviso, e até quando ainda pode sair. PURO.
 *
 * A véspera é o lembrete de 24 h da aula experimental (`horarioDoLembrete`),
 * com 13 h de antecedência em vez de 6: a do domingo recua para o sábado. Se
 * a hora dela já passou (a automação chegou tarde), sai agora — se ainda der.
 */
export function agendaDoAviso(etapa, { agora = new Date(), sessaoEm = null, sorteio = Math.random } = {}) {
  if (etapa === 'venda') {
    return { previsto: horarioDeAgora(agora, sorteio), prazo: new Date(agora.getTime() + VENDA_PRAZO_MS) };
  }
  if (!sessaoEm) return null;
  if (etapa === 'tres_dias') {
    return { previsto: horarioDeAgora(agora, sorteio), prazo: new Date(sessaoEm.getTime() - DIA_MS) };
  }
  if (etapa === 'vespera') {
    const ideal = horarioDoLembrete(sessaoEm, { antecedenciaMinMs: VESPERA_ANTECEDENCIA_MS });
    const previsto = ideal.getTime() > agora.getTime() ? ideal : horarioDeAgora(agora, sorteio);
    return { previsto, prazo: new Date(sessaoEm.getTime() - VESPERA_ANTECEDENCIA_MS) };
  }
  return null;
}

// ──────────────────────────────────────────────
// Os textos
// ──────────────────────────────────────────────

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function partes(data) {
  const d = new Date(data.getTime() + OFFSET_SP_MS);
  return { dia: d.getUTCDate(), mes: d.getUTCMonth() + 1, semana: d.getUTCDay(), hora: d.getUTCHours(), minuto: d.getUTCMinutes() };
}

/** 17:00 → "17h"; 08:15 → "8h15". */
export function hora(data) {
  const p = partes(data);
  return `${p.hora}h${p.minuto ? String(p.minuto).padStart(2, '0') : ''}`;
}

/** Quantos dias de calendário (de São Paulo) há entre `agora` e `data`. */
function diasAte(data, agora) {
  return Math.round((Date.parse(diaSP(data)) - Date.parse(diaSP(agora))) / DIA_MS);
}

/** O dia, com a preposição, como se fala de quem está em `agora`: "hoje", "amanhã", "na quinta, 05/11", "no sábado, 07/11". */
export function quando(data, agora = new Date()) {
  const n = diasAte(data, agora);
  if (n === 0) return 'hoje';
  if (n === 1) return 'amanhã';
  const p = partes(data);
  const nome = DIAS_DA_SEMANA[p.semana];
  const prep = p.semana === 0 || p.semana === 6 ? 'no' : 'na';
  return `${prep} ${nome}, ${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}`;
}

/** Até quando se desmarca sem taxa: "hoje às 20h15", "amanhã às 5h", "segunda às 5h". */
export function prazoDeDesmarcar(sessaoEm, agora = new Date()) {
  const limite = new Date(sessaoEm.getTime() - DESMARCAR_ANTES_MS);
  const n = diasAte(limite, agora);
  const dia = n === 0 ? 'hoje' : n === 1 ? 'amanhã' : DIAS_DA_SEMANA[partes(limite).semana];
  return `${dia} às ${hora(limite)}`;
}

/** O preparo da bioimpedância, do cartaz da academia, em ações. */
export function preparo(genero, { comPeriodo = true } = {}) {
  const roupa = genero === 'F' ? 'vem de top e bermuda, ou de maiô'
    : genero === 'M' ? 'vem de bermuda leve ou de sunga'
    : 'vem de top e bermuda ou maiô (mulheres), ou de bermuda leve ou sunga (homens)';
  const linhas = [
    roupa,
    'nas 2 horas antes, fica sem comer, sem tomar banho e sem sauna',
    'nas 12 horas antes, fica sem treinar',
    'não passa creme nem óleo nas mãos e nos pés',
    'vai ao banheiro até 30 minutos antes',
  ];
  if (comPeriodo && genero !== 'M') linhas.push('se der, evita o período menstrual');
  const restricao = genero === 'M'
    ? 'Se você usa marcapasso, avisa a gente antes: nesse caso a bioimpedância não é feita.'
    : 'Se você está grávida ou usa marcapasso, avisa a gente antes: nesses casos a bioimpedância não é feita.';
  return `Pra bioimpedância sair certinha:\n${linhas.map(l => `• ${l}`).join('\n')}\n${restricao}`;
}

function oi(nome) {
  return nome ? `Oi, ${nome}!` : 'Oi!';
}

function comQuem(professor) {
  return professor ? `, com ${professor}` : '';
}

const AJUDA = 'Se precisar de ajuda pra responder, chama um professor na academia.';

/**
 * O texto de cada aviso. PURO.
 *
 * @param {'venda'|'tres_dias'|'vespera'} etapa
 * @param {object} p
 * @param {string|null} p.nome          primeiro nome
 * @param {'F'|'M'|null} p.genero
 * @param {string} p.link              o questionário
 * @param {Date} [p.sessaoEm]          tres_dias e vespera
 * @param {string|null} [p.professor]  primeiro nome
 * @param {boolean|null} [p.questionario]  já chegou ao Prescrev? null = não se sabe (vai o link)
 * @param {Date} [p.agora]             a hora do envio: "amanhã", "hoje"
 */
export function textoDoAviso(etapa, { nome, genero, link, sessaoEm, professor, questionario = null, agora = new Date() }) {
  if (etapa === 'venda') {
    return [
      `${oi(nome)} Aqui é a Leia, da AP. Sua avaliação física tá garantida.`,
      `Antes dela, responde este questionário: ${link}\n` +
        'É com ele que o professor prepara a sua avaliação, então ele precisa chegar antes do dia. ' + AJUDA,
      preparo(genero),
    ].join('\n\n');
  }

  const horario = `${quando(sessaoEm, agora)}, às ${hora(sessaoEm)}${comQuem(professor)}`;
  const semQuestionario =
    `O questionário ainda não chegou, e ele precisa chegar antes da avaliação: ${link}\n${AJUDA}`;

  if (etapa === 'tres_dias') {
    return [
      `${oi(nome)} Sua avaliação física na AP é ${horario}.` +
        (questionario === true ? ' Seu questionário já chegou, valeu.' : ''),
      ...(questionario === true ? [] : [semQuestionario]),
      preparo(genero),
    ].join('\n\n');
  }

  if (etapa === 'vespera') {
    return [
      `${oi(nome)} Sua avaliação física é ${horario}.`,
      `Se precisar desmarcar, me avisa por aqui até ${prazoDeDesmarcar(sessaoEm, agora)}: assim você não paga ` +
        `a taxa de não comparecimento, de ${TAXA_NAO_COMPARECIMENTO}. E chega no horário, porque a tolerância é de 5 minutos.`,
      ...(questionario === true ? [] : [semQuestionario]),
      preparo(genero, { comPeriodo: false }),
    ].join('\n\n');
  }
  throw new Error(`Aviso desconhecido: ${etapa}`);
}
