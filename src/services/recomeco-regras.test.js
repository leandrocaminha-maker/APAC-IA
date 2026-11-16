import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODIGOS_DE_QUEDA, lerRampa, ehQuedaNova, situacaoDoRecomeco, tetoDeHoje,
} from './recomeco-regras.js';

const RAMPA = [0, 0, 0, 5, 10, 15, 20, 25];

// A restrição de 16/11/2026: caiu às 17h57 (20h57 UTC).
const QUEDA = '2026-11-16T20:57:31.000Z';

test('lê a rampa do .env; vazio ou lixo desliga', () => {
  assert.deepEqual(lerRampa('0,0,0,5,10'), [0, 0, 0, 5, 10]);
  assert.deepEqual(lerRampa(' 0 , 5.9 ,10 '), [0, 5, 10]);
  assert.deepEqual(lerRampa(''), []);
  assert.deepEqual(lerRampa(undefined), []);
  assert.deepEqual(lerRampa('abc,-3'), []);
});

test('401 e 403 são queda sem volta; queda de rede não', () => {
  assert.ok(CODIGOS_DE_QUEDA.includes(401));
  assert.ok(CODIGOS_DE_QUEDA.includes(403));
  assert.ok(!CODIGOS_DE_QUEDA.includes(428));
  assert.ok(!CODIGOS_DE_QUEDA.includes(515));
});

test('sem restrição gravada, com ela encerrada ou sem rampa, não há recomeço', () => {
  const agora = new Date('2026-11-17T12:00:00Z');
  assert.equal(situacaoDoRecomeco({ restricao: null, rampa: RAMPA, agora }).ativo, false);
  assert.equal(situacaoDoRecomeco({ restricao: { em: QUEDA }, rampa: [], agora }).ativo, false);
  assert.equal(situacaoDoRecomeco({
    restricao: { em: QUEDA, voltou_em: '2026-11-17T11:00:00Z', encerrado_em: '2026-11-17T11:30:00Z' },
    rampa: RAMPA, agora,
  }).ativo, false);
});

test('enquanto o número não volta, o teto é zero', () => {
  const s = situacaoDoRecomeco({ restricao: { em: QUEDA, voltou_em: null }, rampa: RAMPA, agora: new Date('2026-11-20T12:00:00Z') });
  assert.equal(s.ativo, true);
  assert.equal(s.teto, 0);
  assert.equal(s.dia, null);
  assert.match(s.motivo, /16\/11/);
  assert.match(s.motivo, /fora do ar/);
});

test('a rampa conta do dia da volta, em dias de São Paulo', () => {
  // Voltou terça, 17/11, às 15h (18h UTC).
  const restricao = { em: QUEDA, voltou_em: '2026-11-17T18:00:00Z' };
  const em = (iso) => situacaoDoRecomeco({ restricao, rampa: RAMPA, agora: new Date(iso) });

  assert.deepEqual([em('2026-11-17T23:00:00Z').dia, em('2026-11-17T23:00:00Z').teto], [0, 0]);
  // 23h30 de São Paulo ainda é o dia da volta, embora já seja 18/11 em UTC.
  assert.equal(em('2026-11-18T02:30:00Z').dia, 0);
  // 0h05 de São Paulo já é o dia seguinte.
  assert.equal(em('2026-11-18T03:05:00Z').dia, 1);
  assert.equal(em('2026-11-19T15:00:00Z').teto, 0);
  assert.deepEqual([em('2026-11-20T12:00:00Z').dia, em('2026-11-20T12:00:00Z').teto], [3, 5]);
  assert.equal(em('2026-11-24T12:00:00Z').teto, 25);
  assert.match(em('2026-11-20T12:00:00Z').motivo, /dia 4 de 8/);
  assert.match(em('2026-11-18T12:00:00Z').motivo, /não inicia conversa hoje/);
});

test('passado o último degrau, o recomeço acaba sozinho', () => {
  const restricao = { em: QUEDA, voltou_em: '2026-11-17T18:00:00Z' };
  const s = situacaoDoRecomeco({ restricao, rampa: RAMPA, agora: new Date('2026-11-25T12:00:00Z') });
  assert.equal(s.ativo, false);
  assert.equal(s.dia, 8);
});

test('o teto de hoje é o menor entre o regime e o degrau', () => {
  const fora = { ativo: false, dia: null, teto: null };
  assert.equal(tetoDeHoje(38, fora), 38);
  assert.equal(tetoDeHoje(0, fora), Infinity);
  assert.equal(tetoDeHoje(38, { ativo: true, dia: 3, teto: 5 }), 5);
  assert.equal(tetoDeHoje(38, { ativo: true, dia: 0, teto: 0 }), 0);
  // O degrau não passa do regime.
  assert.equal(tetoDeHoje(20, { ativo: true, dia: 7, teto: 25 }), 20);
  // Teto de regime desligado não desliga a rampa.
  assert.equal(tetoDeHoje(0, { ativo: true, dia: 3, teto: 5 }), 5);
  assert.equal(tetoDeHoje(0, { ativo: true, dia: 0, teto: 0 }), 0);
});

test('a mesma queda lida duas vezes não é queda nova', () => {
  assert.equal(ehQuedaNova(null, QUEDA), true);
  assert.equal(ehQuedaNova({}, QUEDA), true);
  // O webhook carimbou alguns segundos depois da hora que a Evolution gravou.
  assert.equal(ehQuedaNova({ em: '2026-11-16T20:57:33.000Z' }, QUEDA), false);
  assert.equal(ehQuedaNova({ em: QUEDA }, '2026-11-16T20:59:00.000Z'), false);
  // Outra restrição, dias depois.
  assert.equal(ehQuedaNova({ em: '2026-11-14T15:03:20.000Z' }, QUEDA), true);
  // Registro antigo da Evolution não desfaz uma queda mais nova.
  assert.equal(ehQuedaNova({ em: QUEDA }, '2026-11-14T15:03:20.000Z'), false);
  assert.equal(ehQuedaNova({ em: QUEDA }, 'ontem'), false);
});
