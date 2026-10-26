/**
 * Testes do horário da conversa pós-aula.
 *
 *   node --test src/services/followup.test.js
 *
 * Puros: só o cálculo de horário, sem banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horarioDoPosAula } from './followup.js';

// Horário de São Paulo é UTC-3: 10h em SP são 13h UTC.

test('aula de terça à noite: conversa na quarta às 10h', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-27T22:00:00Z')).toISOString(), '2026-10-28T13:00:00.000Z');
});

test('aula de manhã: conversa na manhã SEGUINTE, depois do aviso do EVO', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-27T11:15:00Z')).toISOString(), '2026-10-28T13:00:00.000Z');
});

test('aula de sábado: domingo não tem contato, vai para a abertura de segunda', () => {
  assert.equal(horarioDoPosAula(new Date('2026-10-31T12:00:00Z')).toISOString(), '2026-11-02T12:00:00.000Z');
});

test('aula no último dia do mês vira o mês', () => {
  assert.equal(horarioDoPosAula(new Date('2026-09-30T20:00:00Z')).toISOString(), '2026-10-01T13:00:00.000Z');
});
