/**
 * src/services/acompanhamento/horario.js
 * O horário de trabalho de quem é da equipe, e quando o briefing sai. PURO.
 *
 * Decisão do responsável em 08/10/2026: mensagem à equipe só sai no horário
 * de trabalho de quem recebe. O horário é cadastrado no Prescrev (tela
 * Acompanhamento, migration 043 de lá) e vem na lista da equipe. O formato
 * atravessa os dois sistemas — mude lá junto (src/lib/acompanhamento/horario.ts):
 *
 *   { "1": [["06:00","10:00"], ["17:00","21:00"]], "6": [["08:00","12:00"]] }
 *
 * chave = dia da semana como no Date#getDay ("0" domingo … "6" sábado),
 * faixas "HH:MM" na hora de São Paulo. Dia sem chave é dia sem trabalho, e
 * sem faixa nenhuma a pessoa não recebe.
 *
 * ## O que decide
 *
 *   - no horário agora          sai agora
 *   - fora dele                 fica na fila até o começo do próximo turno
 *   - "hoje" e sem turno no
 *     resto do dia              ninguém espera amanhã por isso: vai a quem
 *                               trabalha hoje (a coordenação)
 *   - prazo de resposta         2 horas DE TRABALHO para "hoje"; para
 *                               "próximos dias", 24 horas corridas, levadas
 *                               para dentro do horário
 */

// O Brasil não tem horário de verão desde 2019: São Paulo é UTC−3 fixo (o
// mesmo que followup.js assume para a janela de contato).
const OFFSET_SP_MS = -3 * 3600_000;
const DIA_MS = 86_400_000;
const MIN_MS = 60_000;
const SEMANAS_DE_BUSCA = 3;

export const PRAZO_HOJE_MS = 2 * 3600_000;
export const PRAZO_PROXIMOS_DIAS_MS = 24 * 3600_000;

function minutosDe(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A meia-noite de São Paulo do dia em que `t` cai (ms), e o dia da semana. */
function diaSP(t) {
  const d = new Date(t + OFFSET_SP_MS);
  return { meiaNoite: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - OFFSET_SP_MS, diaSemana: d.getUTCDay() };
}

/** As faixas de trabalho a partir de `desde`, em ms, em ordem — as que ainda não acabaram. */
function* turnos(horario, desde) {
  const { meiaNoite, diaSemana } = diaSP(desde);
  for (let k = 0; k < 7 * SEMANAS_DE_BUSCA; k++) {
    const base = meiaNoite + k * DIA_MS;
    const faixas = (horario?.[String((diaSemana + k) % 7)] ?? [])
      .map(([a, b]) => [minutosDe(a), minutosDe(b)])
      .filter(([a, b]) => a !== null && b !== null && a < b)
      .sort((x, y) => x[0] - y[0]);
    for (const [a, b] of faixas) {
      const fim = base + b * MIN_MS;
      if (fim > desde) yield [base + a * MIN_MS, fim];
    }
  }
}

export function temHorario(horario) {
  return !turnos(horario, 0).next().done;
}

/** `data` cai dentro de uma faixa? */
export function emHorario(horario, data = new Date()) {
  const t = data.getTime();
  for (const [ini] of turnos(horario, t)) return ini <= t;
  return false;
}

/** O primeiro instante de trabalho a partir de `data` (ela mesma, se já no horário), ou null sem horário. */
export function proximoInicio(horario, data = new Date()) {
  const t = data.getTime();
  for (const [ini] of turnos(horario, t)) return new Date(Math.max(ini, t));
  return null;
}

/** `desde` + `ms` contados só dentro do horário. */
export function somarTrabalho(horario, desde, ms) {
  let falta = ms;
  const t = desde.getTime();
  for (const [ini, fim] of turnos(horario, t)) {
    const comeca = Math.max(ini, t);
    if (falta <= fim - comeca) return new Date(comeca + falta);
    falta -= fim - comeca;
  }
  return null;
}

export function mesmoDiaSP(a, b) {
  return diaSP(a.getTime()).meiaNoite === diaSP(b.getTime()).meiaNoite;
}

const hhmmSP = (ms) => new Date(ms + OFFSET_SP_MS).toISOString().slice(11, 16);

const DIA_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * Onde o professor está hoje, para a Leia dizer QUANDO ele fica sabendo — e
 * não prometer o que não vai acontecer ("ele te procura ainda hoje" de quem
 * já saiu). Fora do turno, quando ele volta: "amanhã" ou o dia da semana.
 * @returns {{ estado: 'agora', ate: string } | { estado: 'mais_tarde', as: string }
 *   | { estado: 'nao_hoje', volta: string, as: string } | null}  null = sem horário cadastrado
 */
export function professorHoje(horario, agora = new Date()) {
  const t = agora.getTime();
  for (const [ini, fim] of turnos(horario, t)) {
    if (ini <= t) return { estado: 'agora', ate: hhmmSP(fim) };
    if (mesmoDiaSP(new Date(ini), agora)) return { estado: 'mais_tarde', as: hhmmSP(ini) };
    const dias = Math.round((diaSP(ini).meiaNoite - diaSP(t).meiaNoite) / DIA_MS);
    return { estado: 'nao_hoje', volta: dias === 1 ? 'amanhã' : DIA_DA_SEMANA[diaSP(ini).diaSemana], as: hhmmSP(ini) };
  }
  return null;
}

/** O prazo de resposta de um briefing enviado em `enviadoEm`. */
export function prazoDaResposta(horario, urgencia, enviadoEm) {
  if (urgencia === 'hoje') return somarTrabalho(horario, enviadoEm, PRAZO_HOJE_MS);
  return proximoInicio(horario, new Date(enviadoEm.getTime() + PRAZO_PROXIMOS_DIAS_MS));
}

/**
 * Quando um briefing pode sair para quem tem este horário.
 *
 * @param {{ horario: object|null, urgencia: 'hoje'|'proximos_dias', agora: Date, exigirHoje?: boolean }} p
 *   exigirHoje — urgência "hoje" que não pode esperar amanhã (o envio de
 *   teste não exige: espera o turno de quem vai testar)
 * @returns {{ acao: 'enviar'|'fila', enviarEm: Date } | { acao: 'indisponivel', motivo: string }}
 */
export function quandoEnviar({ horario, urgencia, agora, exigirHoje = urgencia === 'hoje' }) {
  const inicio = proximoInicio(horario, agora);
  if (!inicio) return { acao: 'indisponivel', motivo: 'sem horário de trabalho cadastrado' };
  if (exigirHoje && !mesmoDiaSP(inicio, agora)) return { acao: 'indisponivel', motivo: 'fora do horário de trabalho no resto de hoje' };
  return { acao: inicio.getTime() <= agora.getTime() ? 'enviar' : 'fila', enviarEm: inicio };
}
