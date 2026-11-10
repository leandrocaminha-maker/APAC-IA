/**
 * src/services/repasse-regras.js
 * O repasse da aula experimental que a Leia marcou.
 *
 * Pura: monta o texto do repasse e decide, a partir do que o banco
 * devolveu, quais repasses ainda esperam um consultor. Quem lê e grava é
 * `atendimento.js`.
 *
 * ## Por que existe (10/11/2026)
 *
 * Decisão do responsável: todo agendamento da Leia passa a um consultor,
 * que confirma a aula e segue a venda. A Leia fica na cobertura.
 *
 * Até aqui ela marcava e não repassava — o prompt dizia "não transfere". De
 * 10/09 a 10/11, 41 pessoas tiveram experimental marcada por ela; em 23
 * nenhum consultor falou antes da aula, e 13 nunca ouviram uma pessoa. A
 * Luciana (30/10) disse "vou ficar com o plano de 239,00", ganhou a aula de
 * terça, não veio, e a primeira mensagem de gente chegou dez dias depois.
 *
 * ## Por que não é um handoff comum
 *
 * `transferir_para_humano` cala a Leia (`status = human`), e conversa calada
 * perde a régua da aula — o lembrete da véspera e a conversa depois da
 * aula. E a fila "Aguardando consultor" é pela etapa, que nunca volta de
 * "Experimental agendada". O repasse é uma linha em `wa_human_handoffs`
 * com a conversa ainda ativa: o consultor vê no painel, a Leia segue
 * respondendo até alguém da equipe falar na conversa.
 *
 * ## Quando sai da fila
 *
 *   - um consultor escreveu na conversa depois do repasse (painel ou aparelho);
 *   - o lead fechou (ganho, perdido, finalizado);
 *   - a Leia marcou outra aula para a mesma pessoa: vale o repasse novo;
 *   - o consultor marcou como feito no painel (confirmou por outro canal).
 */

/** Marca o repasse de experimental entre os handoffs. */
export const PREFIXO = '[experimental]';

/** Etapas em que não há mais venda a seguir. */
const ETAPAS_FECHADAS = new Set(['ganho', 'perdido', 'finalizado']);

const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function ehRepasseDeExperimental(reason) {
  return String(reason || '').startsWith(PREFIXO);
}

/**
 * "2026-11-03 15:45" → "ter, 03/11 às 15h45". Sem fuso: o texto é o que a
 * Leia combinou com a pessoa, na hora de São Paulo.
 */
export function quandoLegivel(dataHora) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(dataHora || '').trim());
  if (!m) return String(dataHora || '').trim();
  const [, a, mes, d, h, min] = m;
  const dia = DIAS_SEMANA[new Date(Date.UTC(+a, +mes - 1, +d)).getUTCDay()];
  return `${dia}, ${d}/${mes} às ${h}h${min}`;
}

/** "MUSCULAÇÃO" → "Musculação"; "NATAÇÃO ADULTO" → "Natação adulto". */
function atividadeLegivel(atividade) {
  const t = String(atividade || '').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : 'atividade';
}

/**
 * O briefing que o consultor lê no painel, no fio da conversa.
 *
 * @param {object} p
 * @param {string} p.atividade
 * @param {string} p.dataHora   AAAA-MM-DD HH:mm
 * @param {string} [p.resumo]   o que a Leia apurou na conversa
 * @param {boolean} [p.dryRun]
 */
export function textoDoRepasse({ atividade, dataHora, resumo = '', dryRun = false }) {
  const partes = [
    `${PREFIXO} A Leia marcou a aula experimental de ${atividadeLegivel(atividade)} para ${quandoLegivel(dataHora)}.` +
      (dryRun ? ' (DRY-RUN: a aula não foi gravada no EVO.)' : ''),
    'Falta um consultor: confirmar a aula com a pessoa e seguir a venda. ' +
      'A Leia continua respondendo até alguém da equipe falar na conversa.',
  ];
  const r = String(resumo || '').trim();
  if (r) partes.push(`Resumo da Leia: ${r}`);
  return partes.join('\n');
}

/**
 * Quais repasses ainda esperam um consultor, e quais já podem ser dados
 * por resolvidos.
 *
 * @param {object} p
 * @param {{ id, conversation_id, contact_id, created_at }[]} p.repasses   abertos
 * @param {{ conversation_id, created_at }[]} p.falasHumanas   mensagens de consultor
 * @param {Map<number, { stage: string }>} p.leadPorContato
 * @returns {{ pendentes: object[], resolver: number[] }}
 *          `pendentes` do mais antigo para o mais novo.
 */
export function situacaoDosRepasses({ repasses = [], falasHumanas = [], leadPorContato = new Map() }) {
  // A fala de consultor mais recente de cada conversa basta: se ela é
  // anterior ao repasse, nenhuma outra é posterior.
  const ultimaFala = new Map();
  for (const f of falasHumanas) {
    const t = new Date(f.created_at).getTime();
    if (t > (ultimaFala.get(f.conversation_id) ?? -Infinity)) ultimaFala.set(f.conversation_id, t);
  }

  // Só o repasse mais novo de cada conversa vale: a aula remarcada substitui
  // a anterior.
  const maisNovo = new Map();
  for (const r of repasses) {
    const atual = maisNovo.get(r.conversation_id);
    if (!atual || new Date(r.created_at) > new Date(atual.created_at)) maisNovo.set(r.conversation_id, r);
  }

  const pendentes = [];
  const resolver = [];
  for (const r of repasses) {
    if (maisNovo.get(r.conversation_id) !== r) { resolver.push(r.id); continue; }

    const fala = ultimaFala.get(r.conversation_id);
    if (fala != null && fala > new Date(r.created_at).getTime()) { resolver.push(r.id); continue; }

    const lead = leadPorContato.get(r.contact_id);
    if (lead && ETAPAS_FECHADAS.has(lead.stage)) { resolver.push(r.id); continue; }

    pendentes.push({ ...r, lead: lead || null });
  }

  pendentes.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return { pendentes, resolver };
}

export const repasseRegras = {
  PREFIXO, ehRepasseDeExperimental, quandoLegivel, textoDoRepasse, situacaoDosRepasses,
};
