import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aulasDaGrade, proximosDias } from './grade-sessoes.js';

test('os próximos dias contam de hoje, em São Paulo', () => {
  // 02:00 UTC de 10/11 ainda é 09/11 em São Paulo.
  assert.deepEqual(proximosDias(new Date('2026-11-10T02:00:00Z'), 3), ['2026-11-09', '2026-11-10', '2026-11-11']);
});

test('uma aula por dia da semana e início, só das atividades pedidas e de segunda a sexta', () => {
  const aula = (idActivity, startTime, extra = {}) => ({ idActivity, startTime, endTime: '07:00', capacity: 20, instructor: 'ROGERIO ', ...extra });
  const grades = [
    { data: '2026-11-09', aulas: [aula(18, '06:00'), aula(54, '06:10'), aula(53, '07:00')] },
    { data: '2026-11-14', aulas: [aula(41, '09:00')] },
    { data: '2026-11-16', aulas: [aula(18, '06:00', { capacity: 35 }), aula(18, '21:00')] },
  ];
  assert.deepEqual(aulasDaGrade(grades, [18, 41, 54]), [
    { idActivity: 18, dia: '1', inicio: '06:00', fim: '07:00', capacidade: 20, instrutor: 'ROGERIO', data: '2026-11-09' },
    { idActivity: 54, dia: '1', inicio: '06:10', fim: '07:00', capacidade: 20, instrutor: 'ROGERIO', data: '2026-11-09' },
    { idActivity: 18, dia: '1', inicio: '21:00', fim: '07:00', capacidade: 20, instrutor: 'ROGERIO', data: '2026-11-16' },
  ]);
});
