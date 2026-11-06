/**
 * src/services/acompanhamento/grade-sessoes.js
 * A grade de sessões do EVO para os horários de encontro de meta do Prescrev
 * (062 de lá, decisão do responsável em 06/11/2026).
 *
 * O Prescrev mostra os horários de sessão da musculação e da natação adulto,
 * de segunda a sexta, e a coordenação diz em quais pode ter encontro. A grade
 * é a da AGENDA do EVO (`/api/v1/activities/schedule`), lida dia a dia nas
 * próximas duas semanas: duas, e não uma, para que um feriado não apague os
 * horários do dia da semana dele. Cada horário sai uma vez por dia da semana,
 * com a capacidade e o instrutor da primeira data em que aparece.
 *
 * O formato atravessa os dois sistemas — mude lá junto
 * (Prescrev, src/lib/acompanhamento/encontros.ts, `AulaDaAgenda`).
 */

/** "2026-11-09" de hoje, e os seguintes, em São Paulo (UTC−3 fixo). */
export function proximosDias(agora, quantos) {
  const base = Date.parse(new Date(agora.getTime() - 3 * 3_600_000).toISOString().slice(0, 10) + 'T12:00:00Z');
  return Array.from({ length: quantos }, (_, k) => new Date(base + k * 86_400_000).toISOString().slice(0, 10));
}

/**
 * As aulas das atividades pedidas, uma por dia da semana (1 a 5) e início.
 * `grades` = [{ data: 'AAAA-MM-DD', aulas: [o que o EVO devolve] }], em ordem.
 */
export function aulasDaGrade(grades, atividades) {
  const ids = new Set(atividades);
  const vistas = new Map();
  for (const { data, aulas } of grades) {
    const dia = new Date(`${data}T12:00:00Z`).getUTCDay();
    if (dia < 1 || dia > 5) continue;
    for (const a of aulas ?? []) {
      if (!ids.has(a?.idActivity)) continue;
      const inicio = String(a.startTime ?? '').slice(0, 5);
      if (!/^\d{2}:\d{2}$/.test(inicio)) continue;
      const chave = `${a.idActivity}|${dia}|${inicio}`;
      if (vistas.has(chave)) continue;
      vistas.set(chave, {
        idActivity: a.idActivity,
        dia: String(dia),
        inicio,
        fim: String(a.endTime ?? '').slice(0, 5) || null,
        capacidade: Number.isFinite(a.capacity) ? a.capacity : null,
        instrutor: String(a.instructor ?? '').trim() || null,
        data,
      });
    }
  }
  return [...vistas.values()].sort((x, y) => x.dia.localeCompare(y.dia) || x.inicio.localeCompare(y.inicio) || x.idActivity - y.idActivity);
}
