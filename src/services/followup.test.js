/**
 * Testes do horário da conversa pós-aula, da janela na hora do envio e da
 * rodada da régua de silêncio.
 *
 *   node --test src/services/followup.test.js
 *
 * Puros: só cálculo, sem banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horarioDoPosAula, estaNaJanela, rodadaDeSilencio, silencioEncerrado } from './followup.js';

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

// ── Janela na hora do envio ──────────────────

const sp = (s) => new Date(`${s}-03:00`);

test('a 0h07 de terça não é hora de mandar nada (a Duda recebeu o encerramento assim)', () => {
  assert.equal(estaNaJanela(sp('2026-10-27T00:07:00')), false);
});

test('dia útil das 9h às 20h30; sábado até as 13h; domingo nunca', () => {
  assert.equal(estaNaJanela(sp('2026-10-27T09:00:00')), true);
  assert.equal(estaNaJanela(sp('2026-10-27T20:30:00')), true);
  assert.equal(estaNaJanela(sp('2026-10-27T20:31:00')), false);
  assert.equal(estaNaJanela(sp('2026-10-31T12:59:00')), true);
  assert.equal(estaNaJanela(sp('2026-10-31T13:01:00')), false);
  assert.equal(estaNaJanela(sp('2026-11-01T10:00:00')), false);
});

// ── Rodada da régua de silêncio ──────────────

const enviado = (tipo, sent_at) => ({ tipo, status: 'enviado', sent_at, created_at: sent_at });

test('ninguém cutucado ainda: primeira mensagem', () => {
  assert.equal(rodadaDeSilencio([]), 'silencio_1');
});

test('não respondeu à primeira: a segunda, de encerramento', () => {
  const feitos = [enviado('silencio_1', '2026-10-26T12:13:00Z')];
  assert.equal(rodadaDeSilencio(feitos, { respondeuEm: '2026-10-22T20:07:59Z' }), 'silencio_2');
});

test('Amanda: respondeu à primeira, então o sumiço seguinte recomeça a rodada', () => {
  const feitos = [enviado('silencio_1', '2026-10-26T12:13:15Z')];
  assert.equal(rodadaDeSilencio(feitos, { respondeuEm: '2026-10-26T13:22:32Z' }), 'silencio_1');
});

test('as duas da rodada saíram sem resposta: acabou', () => {
  const feitos = [enviado('silencio_1', '2026-10-21T12:36:00Z'), enviado('silencio_2', '2026-10-27T03:07:00Z')];
  assert.equal(rodadaDeSilencio(feitos, { respondeuEm: '2026-10-19T12:21:36Z' }), null);
});

test('Duda: o encerramento saiu depois da resposta à primeira — a rodada também acabou', () => {
  const feitos = [enviado('silencio_1', '2026-10-21T12:36:00Z'), enviado('silencio_2', '2026-10-27T03:07:00Z')];
  assert.equal(rodadaDeSilencio(feitos, { respondeuEm: '2026-10-21T12:48:57Z' }), null);
});

test('respondeu depois do encerramento e sumiu de novo: rodada nova, até o teto de 4', () => {
  const duas = [enviado('silencio_1', '2026-10-12T12:54:00Z'), enviado('silencio_2', '2026-10-14T17:06:00Z')];
  assert.equal(rodadaDeSilencio(duas, { respondeuEm: '2026-10-28T09:19:45Z' }), 'silencio_1');

  const quatro = [...duas, enviado('silencio_1', '2026-10-30T12:00:00Z'), enviado('silencio_2', '2026-11-02T12:00:00Z')];
  assert.equal(silencioEncerrado(quatro), true);
  assert.equal(rodadaDeSilencio(quatro, { respondeuEm: '2026-11-03T12:00:00Z' }), null);
});

test('pendente ou régua pós-aula: a régua de silêncio não mexe', () => {
  assert.equal(rodadaDeSilencio([{ tipo: 'ae_lembrete_24h', status: 'pendente' }]), null);
  assert.equal(rodadaDeSilencio([enviado('sondagem_1', '2026-10-20T12:00:00Z')]), null);
});

test('duas falhas da primeira na rodada passam para a segunda', () => {
  const falha = { tipo: 'silencio_1', status: 'falhou', created_at: '2026-10-20T12:00:00Z' };
  assert.equal(rodadaDeSilencio([falha, falha], { respondeuEm: '2026-10-18T12:00:00Z' }), 'silencio_2');
});
