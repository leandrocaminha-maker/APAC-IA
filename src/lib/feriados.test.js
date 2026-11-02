/**
 * Testes dos feriados e do efeito deles na janela de contato e nos avisos
 * da gerência.
 *
 *   node --test src/lib/feriados.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feriadoDe, ehFeriado, pascoa } from './feriados.js';
import { janelaDoDia, dentroDaJanela, estaNaJanela, horarioDoLembrete } from '../services/followup.js';
import { diaUtil } from '../services/gerencia-regras.js';

const sp = (s) => new Date(`${s}-03:00`);

test('02/11/2026 (Finados) é feriado, o dia inteiro em São Paulo', () => {
  assert.equal(feriadoDe(sp('2026-11-02T00:00:00')), 'Finados');
  assert.equal(feriadoDe(sp('2026-11-02T23:59:00')), 'Finados');
  assert.equal(feriadoDe('2026-11-02'), 'Finados');
  assert.equal(ehFeriado(sp('2026-11-03T10:00:00')), false);
  // 21h de domingo em SP já é segunda em UTC, e não é feriado ainda
  assert.equal(ehFeriado(sp('2026-11-01T22:00:00')), false);
});

test('móveis: Páscoa, Carnaval, Sexta-feira Santa e Corpus Christi', () => {
  assert.equal(pascoa(2026).toISOString().slice(0, 10), '2026-04-05');
  assert.equal(pascoa(2027).toISOString().slice(0, 10), '2027-03-28');
  assert.equal(feriadoDe('2027-02-08'), 'Carnaval');   // segunda
  assert.equal(feriadoDe('2027-02-09'), 'Carnaval');   // terça
  assert.equal(ehFeriado('2027-02-10'), false);        // quarta de cinzas abre
  assert.equal(feriadoDe('2026-04-03'), 'Sexta-feira Santa');
  assert.equal(feriadoDe('2026-06-04'), 'Corpus Christi');
});

test('recesso de 21/12/2026 a 03/01/2027, inclusive', () => {
  assert.equal(ehFeriado('2026-12-18'), false);
  assert.equal(feriadoDe('2026-12-21'), 'Recesso de fim de ano');
  assert.equal(feriadoDe('2026-12-30'), 'Recesso de fim de ano');
  assert.equal(feriadoDe('2027-01-03'), 'Recesso de fim de ano');
  assert.equal(ehFeriado('2027-01-04'), false);
  // sábado 19/12 à tarde: só reabre segunda 04/01
  assert.equal(dentroDaJanela(sp('2026-12-19T15:00:00')).toISOString(), sp('2027-01-04T09:00:00').toISOString());
  assert.equal(diaUtil(sp('2026-12-22T10:00:00')), false);
});

test('FERIADOS_EXTRA: data única e data anual', () => {
  const extra = '2026-12-24, 12-31';
  assert.ok(ehFeriado('2026-12-24', { extra }));
  assert.ok(ehFeriado('2027-12-31', { extra }));
  assert.equal(ehFeriado('2027-12-24', { extra }), false);
});

test('feriado não tem janela de contato: nada programado sai em 02/11', () => {
  assert.equal(janelaDoDia(sp('2026-11-02T10:00:00')), null);
  assert.equal(estaNaJanela(sp('2026-11-02T10:00:00')), false);
  // o que vence no domingo ou no feriado vai para a abertura de terça
  assert.equal(dentroDaJanela(sp('2026-11-01T15:00:00')).toISOString(), sp('2026-11-03T09:00:00').toISOString());
  assert.equal(dentroDaJanela(sp('2026-11-02T10:00:00')).toISOString(), sp('2026-11-03T09:00:00').toISOString());
  assert.equal(estaNaJanela(sp('2026-11-03T10:00:00')), true);
});

test('lembrete de aula de terça cedo, depois do feriado: recua para o sábado', () => {
  const l = horarioDoLembrete(sp('2026-11-03T09:00:00'));
  assert.equal(l.toISOString(), sp('2026-10-31T09:00:00').toISOString());
});

test('gerência: só dia útil — nem sábado, nem domingo, nem feriado', () => {
  assert.equal(diaUtil(sp('2026-10-30T10:00:00')), true);    // sexta
  assert.equal(diaUtil(sp('2026-10-31T10:00:00')), false);   // sábado
  assert.equal(diaUtil(sp('2026-11-01T10:00:00')), false);   // domingo
  assert.equal(diaUtil(sp('2026-11-02T10:00:00')), false);   // Finados
  assert.equal(diaUtil(sp('2026-11-03T10:00:00')), true);    // terça
});

