/**
 * Testes da agenda de testes do dia ao professor (Prescrev 060, 05/11/2026).
 *   node --test src/services/acompanhamento/agenda-testes.test.js
 * Puros: não leem `.env`, banco nem Prescrev.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisosDaAgenda, desfazer } from './agenda-testes.js';

const URL = 'https://prescrev.exemplo';
const dia = '2026-11-05';
const agora = new Date('2026-11-05T09:00:00Z'); // 6h em São Paulo
const ana = { profile_id: 'ana', phone: '5511900000001', nome: 'Ana Lima' };
const m = (id, hora, extra = {}) => ({
  id, hora, inicio: new Date(`${dia}T${hora}:00-03:00`).toISOString(), duracao_min: 50,
  professor_id: 'ana', cliente_id: `c-${id}`, cliente_nome: `Aluno ${id}`, caminho: `/dashboard/clientes/c-${id}/testes`,
  cancelado_em: null, ...extra,
});

test('no começo do turno: a agenda do dia inteiro, com o link de cada aluno', () => {
  const r = avisosDaAgenda({ marcacoes: [m('2', '17:30'), m('1', '07:00')], marca: null, pessoas: [ana], dia, agora, url: URL });
  assert.equal(r.envios.length, 1);
  assert.match(r.envios[0].texto, /^Ana, sua agenda de testes de hoje:/);
  assert.ok(r.envios[0].texto.indexOf('7h · Aluno 1') < r.envios[0].texto.indexOf('17h30 · Aluno 2'));
  assert.match(r.envios[0].texto, /https:\/\/prescrev\.exemplo\/dashboard\/clientes\/c-1\/testes/);
  assert.deepEqual(r.marca, { dia, avisados: { 1: 'marcado', 2: 'marcado' }, comecou: { ana: true } });
});

test('sem teste no dia, nada sai, e o turno conta como começado', () => {
  const r = avisosDaAgenda({ marcacoes: [], marca: null, pessoas: [ana], dia, agora, url: URL });
  assert.equal(r.envios.length, 0);
  assert.equal(r.marca.comecou.ana, true);
});

test('depois do começo: só o que entrou e o que saiu', () => {
  const marca = { dia, avisados: { 1: 'marcado', 2: 'marcado' }, comecou: { ana: true } };
  const marcacoes = [m('1', '07:00'), m('2', '17:30', { cancelado_em: '2026-11-05T08:00:00Z' }), m('3', '18:00')];
  const r = avisosDaAgenda({ marcacoes, marca, pessoas: [ana], dia, agora, url: URL });
  assert.equal(r.envios.length, 1);
  assert.match(r.envios[0].texto, /^Ana, entrou um teste na sua agenda de hoje:/);
  assert.match(r.envios[0].texto, /18h · Aluno 3/);
  assert.match(r.envios[0].texto, /\n\nSaiu da sua agenda de hoje: 17h30 · Aluno 2\./);
  assert.doesNotMatch(r.envios[0].texto, /Aluno 1/);
  assert.equal(r.marca.avisados[2], 'cancelado');
  // Já avisado: nada sai de novo.
  assert.equal(avisosDaAgenda({ marcacoes, marca: r.marca, pessoas: [ana], dia, agora, url: URL }).envios.length, 0);
});

test('o teste que já começou não entra, e o cancelado nunca avisado não vira "saiu"', () => {
  const tarde = new Date('2026-11-05T20:40:00Z'); // 17h40
  const r = avisosDaAgenda({
    marcacoes: [m('1', '17:30'), m('2', '18:00', { cancelado_em: '2026-11-05T10:00:00Z' })],
    marca: null, pessoas: [ana], dia, agora: tarde, url: URL,
  });
  assert.equal(r.envios.length, 0);
});

test('a marca de ontem não vale hoje', () => {
  const r = avisosDaAgenda({
    marcacoes: [m('1', '07:00')], marca: { dia: '2026-11-04', avisados: { 1: 'marcado' }, comecou: { ana: true } },
    pessoas: [ana], dia, agora, url: URL,
  });
  assert.match(r.envios[0].texto, /sua agenda de testes de hoje/);
});

test('o envio que falhou volta atrás e sai no ciclo seguinte', () => {
  const r = avisosDaAgenda({ marcacoes: [m('1', '07:00')], marca: null, pessoas: [ana], dia, agora, url: URL });
  desfazer(r.marca, null, r.envios[0]);
  assert.deepEqual(r.marca, { dia, avisados: {}, comecou: {} });
  const de_novo = avisosDaAgenda({ marcacoes: [m('1', '07:00')], marca: r.marca, pessoas: [ana], dia, agora, url: URL });
  assert.match(de_novo.envios[0].texto, /sua agenda de testes de hoje/);
});

test('cada professor vê só a agenda dele', () => {
  const bia = { profile_id: 'bia', phone: '5511900000002', nome: 'Bia' };
  const r = avisosDaAgenda({ marcacoes: [m('1', '07:00')], marca: null, pessoas: [ana, bia], dia, agora, url: URL });
  assert.deepEqual(r.envios.map(e => e.profile_id), ['ana']);
});
