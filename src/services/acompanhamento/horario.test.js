/**
 * Testes do horário de trabalho da equipe. Puros, sem `.env`.
 * 08/10/2026 é quinta-feira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emHorario, prazoDaResposta, proximoInicio, quandoEnviar, somarTrabalho, temHorario } from './horario.js';

const sp = (s) => new Date(`${s}-03:00`);
const iso = (d) => d?.toISOString() ?? null;
const PARTIDO = [['06:00', '10:00'], ['17:00', '21:00']];
const H = { 1: PARTIDO, 2: PARTIDO, 3: PARTIDO, 4: PARTIDO, 5: PARTIDO, 6: [['08:00', '12:00']] };

test('no horário: o fim da faixa já é fora, e domingo não tem turno', () => {
  assert.deepEqual(
    ['2026-10-08T09:30', '2026-10-08T10:00', '2026-10-08T12:00', '2026-10-08T17:00', '2026-10-11T09:00']
      .map(s => emHorario(H, sp(s))),
    [true, false, false, true, false]);
  assert.equal(emHorario({ 4: [['18:00', '24:00']] }, sp('2026-10-08T23:59')), true);
});

test('o próximo começo de turno', () => {
  assert.deepEqual(
    ['2026-10-08T09:30', '2026-10-08T12:00', '2026-10-08T22:00', '2026-10-10T13:00'].map(s => iso(proximoInicio(H, sp(s)))),
    [iso(sp('2026-10-08T09:30')), iso(sp('2026-10-08T17:00')), iso(sp('2026-10-09T06:00')), iso(sp('2026-10-12T06:00'))]);
  assert.equal(proximoInicio(null, sp('2026-10-08T09:30')), null);
  assert.equal(proximoInicio({ 1: [] }, sp('2026-10-08T09:30')), null);
  assert.deepEqual([temHorario(H), temHorario({}), temHorario(null)], [true, false, false]);
});

test('duas horas de trabalho atravessam o intervalo do turno e o fim de semana', () => {
  // 30 min de manhã + 1h30 à tarde
  assert.equal(iso(somarTrabalho(H, sp('2026-10-08T09:30'), 2 * 3600_000)), iso(sp('2026-10-08T18:30')));
  // sexta 20h: 1h na sexta + 1h no sábado
  assert.equal(iso(somarTrabalho(H, sp('2026-10-09T20:00'), 2 * 3600_000)), iso(sp('2026-10-10T09:00')));
});

test('o prazo de resposta: 2h de trabalho para hoje, 24h corridas levadas ao horário para os próximos dias', () => {
  assert.equal(iso(prazoDaResposta(H, 'hoje', sp('2026-10-08T09:30'))), iso(sp('2026-10-08T18:30')));
  assert.equal(iso(prazoDaResposta(H, 'proximos_dias', sp('2026-10-08T09:30'))), iso(sp('2026-10-09T09:30')));
  // sábado 9h + 24h = domingo 9h, sem turno: segunda 6h
  assert.equal(iso(prazoDaResposta(H, 'proximos_dias', sp('2026-10-10T09:00'))), iso(sp('2026-10-12T06:00')));
});

test('quando o briefing sai', () => {
  const q = (s, urgencia, extra = {}) => {
    const r = quandoEnviar({ horario: H, urgencia, agora: sp(s), ...extra });
    return r.acao === 'indisponivel' ? r : { acao: r.acao, enviarEm: iso(r.enviarEm) };
  };
  assert.deepEqual(q('2026-10-08T09:30', 'hoje'), { acao: 'enviar', enviarEm: iso(sp('2026-10-08T09:30')) });
  assert.deepEqual(q('2026-10-08T12:00', 'hoje'), { acao: 'fila', enviarEm: iso(sp('2026-10-08T17:00')) });
  // "hoje" às 22h: o turno seguinte é amanhã — não serve
  assert.deepEqual(q('2026-10-08T22:00', 'hoje'), { acao: 'indisponivel', motivo: 'fora do horário de trabalho no resto de hoje' });
  assert.deepEqual(q('2026-10-08T22:00', 'proximos_dias'), { acao: 'fila', enviarEm: iso(sp('2026-10-09T06:00')) });
  // o teste não exige hoje: espera o turno de quem vai testar
  assert.deepEqual(q('2026-10-08T22:00', 'hoje', { exigirHoje: false }), { acao: 'fila', enviarEm: iso(sp('2026-10-09T06:00')) });
  assert.deepEqual(quandoEnviar({ horario: null, urgencia: 'proximos_dias', agora: sp('2026-10-08T09:30') }),
    { acao: 'indisponivel', motivo: 'sem horário de trabalho cadastrado' });
});
