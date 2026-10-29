/**
 * Testes das regras da aula marcada no balcão.
 *
 *   node --test src/services/aula-regras.test.js
 *
 * As sessões têm o formato de `/api/v2/activities/member/sessions`, e os
 * casos são os das conversas analisadas em 29/10/2026.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataHoraDaSessao, escolherSessao, vinculoDoProspect, proximoPassoDaAulaVendida,
  instanteDaVenda, diaSP,
} from './aula-regras.js';

const sessao = (dia, hora, nome = 'Natação Bebê 1 e 2') => ({
  date: `${dia}T00:00:00`, startTime: hora, activitieName: nome,
});
// Hora de São Paulo, como o EVO escreve.
const sp = (s) => new Date(`${s}-03:00`);

test('a sessão vira a data e hora da academia', () => {
  assert.equal(dataHoraDaSessao(sessao('2026-10-24', '10:30')), '2026-10-24 10:30');
  assert.equal(dataHoraDaSessao({ date: 'lixo' }), null);
});

test('Duda: a reserva de sábado aparece depois da venda e é a aula escolhida', () => {
  const r = escolherSessao([sessao('2026-10-24', '10:30')], {
    desde: sp('2026-10-19T09:18:27'), agora: sp('2026-10-21T10:00:00'),
  });
  assert.equal(r.dataHora, '2026-10-24 10:30');
  assert.equal(r.futura, true);
});

test('Luara: a venda de 27/10 não é das aulas de 10/10 e 24/10', () => {
  const r = escolherSessao([sessao('2026-10-24', '10:00'), sessao('2026-10-10', '10:00')], {
    desde: sp('2026-10-27T16:14:53'), agora: sp('2026-10-27T17:00:00'),
  });
  assert.equal(r, null);
});

test('com aula por vir, a mais próxima; a que começou há meia hora ainda vale', () => {
  const lista = [sessao('2026-10-30', '19:40'), sessao('2026-10-28', '19:40'), sessao('2026-11-04', '19:40')];
  const r = escolherSessao(lista, { desde: sp('2026-10-27T20:00:00'), agora: sp('2026-10-28T20:10:00') });
  assert.equal(r.dataHora, '2026-10-28 19:40');
  assert.equal(r.futura, true);
});

test('sem aula por vir, a mais recente desde a venda (a pessoa já fez a aula)', () => {
  const lista = [sessao('2026-10-21', '15:40'), sessao('2026-10-17', '11:00')];
  const r = escolherSessao(lista, { desde: sp('2026-10-19T16:00:00'), agora: sp('2026-10-27T17:00:00') });
  assert.equal(r.dataHora, '2026-10-21 15:40');
  assert.equal(r.futura, false);
});

test('o corte é pelo dia de São Paulo: venda às 22h conta a aula da manhã seguinte', () => {
  const r = escolherSessao([sessao('2026-10-23', '07:00', 'HIDROGINÁSTICA')], {
    desde: sp('2026-10-22T22:30:00'), agora: sp('2026-10-22T22:31:00'),
  });
  assert.equal(r.dataHora, '2026-10-23 07:00');
  assert.equal(diaSP(sp('2026-10-22T22:30:00')), '2026-10-22');
});

test('vínculo: sem cadastro liga, mesmo cadastro mantém, outro cadastro não troca', () => {
  assert.equal(vinculoDoProspect({ evo_id_prospect: null }, 47307), 'ligar');
  assert.equal(vinculoDoProspect({ evo_id_prospect: -1154 }, 47307), 'ligar');   // vínculo de ensaio
  assert.equal(vinculoDoProspect({ evo_id_prospect: 47307 }, 47307), 'manter');
  assert.equal(vinculoDoProspect({ evo_id_prospect: 37694 }, 47307), 'outro');   // a mãe, e a aula é da filha
});

test('aula vendida sem reserva: procura, avisa depois de 3h uma vez, desiste em 7 dias', () => {
  const vendida = sp('2026-10-19T09:18:27');
  const marcador = { vendida_em: vendida.toISOString() };
  const depois = (h) => new Date(vendida.getTime() + h * 3600e3);

  assert.equal(proximoPassoDaAulaVendida(marcador, depois(1)), 'procurar');
  assert.equal(proximoPassoDaAulaVendida(marcador, depois(3)), 'avisar');
  assert.equal(proximoPassoDaAulaVendida({ ...marcador, avisado_em: depois(3).toISOString() }, depois(30)), 'procurar');
  assert.equal(proximoPassoDaAulaVendida(marcador, depois(7 * 24)), 'desistir');
  assert.equal(proximoPassoDaAulaVendida({}, depois(1)), 'desistir');
});

test('a venda acontece no saleDate (hora de São Paulo), ou na chegada do webhook', () => {
  assert.equal(instanteDaVenda({ saleDate: '2026-10-27T16:14:53' }, {}).toISOString(), '2026-10-27T19:14:53.000Z');
  assert.equal(
    instanteDaVenda({}, { created_at: '2026-10-27T19:14:57+00:00' }).toISOString(),
    '2026-10-27T19:14:57.000Z',
  );
});
