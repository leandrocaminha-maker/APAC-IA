/**
 * Testes do repasse da experimental que a Leia marcou.
 *
 *   node --test src/services/repasse-regras.test.js
 *
 * Puros. O caso de partida é a Luciana, 30/10/2026: aula marcada pela Leia,
 * nenhum consultor até 09/11.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFIXO, ehRepasseDeExperimental, quandoLegivel, textoDoRepasse, situacaoDosRepasses,
} from './repasse-regras.js';

test('a data do repasse sai como a pessoa combinou', () => {
  assert.equal(quandoLegivel('2026-11-03 15:45'), 'ter, 03/11 às 15h45');
  assert.equal(quandoLegivel('2026-11-08T09:10'), 'dom, 08/11 às 09h10');
  assert.equal(quandoLegivel('amanhã'), 'amanhã');   // fora do formato, como veio
});

test('Luciana, 30/10: o briefing diz o que falta e traz o resumo da Leia', () => {
  const t = textoDoRepasse({
    atividade: 'MUSCULAÇÃO',
    dataHora: '2026-11-03 15:45',
    resumo: 'Quer o Performa na Assinatura (R$ 239). Estética e qualidade de vida; parada desde a mudança.',
  });
  assert.ok(t.startsWith(PREFIXO));
  assert.ok(ehRepasseDeExperimental(t));
  assert.match(t, /Musculação para ter, 03\/11 às 15h45/);
  assert.match(t, /confirmar a aula com a pessoa e seguir a venda/);
  assert.match(t, /Resumo da Leia: Quer o Performa/);
  assert.doesNotMatch(t, /DRY-RUN/);
});

test('sem resumo, o briefing sai mesmo assim; dry-run avisa', () => {
  const t = textoDoRepasse({ atividade: 'NATAÇÃO ADULTO', dataHora: '2026-11-12 20:20', dryRun: true });
  assert.match(t, /Natação adulto/);
  assert.match(t, /DRY-RUN/);
  assert.doesNotMatch(t, /Resumo da Leia/);
});

test('handoff comum não é repasse de experimental', () => {
  assert.equal(ehRepasseDeExperimental('[acompanhamento] boleto'), false);
  assert.equal(ehRepasseDeExperimental('Cliente pediu atendimento humano'), false);
  assert.equal(ehRepasseDeExperimental(null), false);
});

const repasse = (id, conv, em, contato = conv) => ({ id, conversation_id: conv, contact_id: contato, created_at: em });

test('sem consultor na conversa, o repasse espera', () => {
  const { pendentes, resolver } = situacaoDosRepasses({
    repasses: [repasse(1, 1135, '2026-10-30T12:02:38Z')],
    falasHumanas: [],
    leadPorContato: new Map([[1135, { stage: 'experimental_agendada' }]]),
  });
  assert.deepEqual(pendentes.map(p => p.id), [1]);
  assert.deepEqual(resolver, []);
});

test('consultor que escreveu depois do repasse tira da fila', () => {
  const { pendentes, resolver } = situacaoDosRepasses({
    repasses: [repasse(1, 1135, '2026-10-30T12:02:38Z')],
    falasHumanas: [{ conversation_id: 1135, created_at: '2026-11-09T21:05:39Z' }],
  });
  assert.deepEqual(pendentes, []);
  assert.deepEqual(resolver, [1]);
});

test('fala de consultor ANTES do repasse não conta', () => {
  // Consultor atendeu, devolveu à Leia, e depois ela marcou a aula.
  const { pendentes } = situacaoDosRepasses({
    repasses: [repasse(1, 7, '2026-11-05T20:56:00Z')],
    falasHumanas: [{ conversation_id: 7, created_at: '2026-11-05T18:00:00Z' }],
  });
  assert.deepEqual(pendentes.map(p => p.id), [1]);
});

test('lead fechado sai da fila', () => {
  for (const stage of ['ganho', 'perdido', 'finalizado']) {
    const { pendentes, resolver } = situacaoDosRepasses({
      repasses: [repasse(1, 7, '2026-11-05T20:56:00Z')],
      leadPorContato: new Map([[7, { stage }]]),
    });
    assert.deepEqual(pendentes, [], stage);
    assert.deepEqual(resolver, [1], stage);
  }
});

test('aula remarcada: vale só o repasse mais novo da conversa', () => {
  const { pendentes, resolver } = situacaoDosRepasses({
    repasses: [repasse(1, 7, '2026-11-03T16:28:00Z'), repasse(2, 7, '2026-11-04T10:00:00Z')],
  });
  assert.deepEqual(pendentes.map(p => p.id), [2]);
  assert.deepEqual(resolver, [1]);
});

test('a fila sai do mais antigo para o mais novo, com o lead junto', () => {
  const lead = { id: 1260, stage: 'experimental_agendada' };
  const { pendentes } = situacaoDosRepasses({
    repasses: [repasse(2, 8, '2026-11-09T10:25:00Z'), repasse(1, 7, '2026-11-03T16:28:00Z')],
    leadPorContato: new Map([[7, lead]]),
  });
  assert.deepEqual(pendentes.map(p => p.id), [1, 2]);
  assert.equal(pendentes[0].lead, lead);
  assert.equal(pendentes[1].lead, null);
});
