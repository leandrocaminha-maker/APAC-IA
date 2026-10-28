/**
 * Testes do aviso de falha da rodada de sessões (M5 do PLANO_MODELOS, decisão 20).
 *   node --test src/services/acompanhamento/aviso-sessoes.test.js
 * Puros: não leem `.env`, banco nem Prescrev.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoraSP, avisoDasSessoes, precisaConferir } from './aviso-sessoes.js';

const domingo = (hora) => ({ dia: '2026-11-01', semana: 0, hora });
const segunda = { dia: '2026-11-02', semana: 1, hora: 9 };
const ok = { ciclo: '2026-11-01', semana_ok: true,
  rodada: { id: 'r2', origem: 'manual', status: 'ok', terminou_em: '2026-11-02T14:30:00Z', ciclo: '2026-11-01' }, ultima_tentativa: null };
const falhou = { ciclo: '2026-11-01', semana_ok: false, rodada: null,
  ultima_tentativa: { id: 'r1', origem: 'cron', status: 'error', terminou_em: '2026-11-01T05:20:00Z', ciclo: '2026-11-01', bem_sucedida: false,
    motivo: 'Cota da Evo esgotada em 3 alunos seguidos' } };
const naoRodou = { ciclo: '2026-11-01', semana_ok: false, rodada: null,
  ultima_tentativa: { id: 'r0', origem: 'cron', status: 'ok', terminou_em: '2026-10-25T05:25:00Z', ciclo: '2026-10-25', bem_sucedida: true, motivo: null } };

test('o relógio de São Paulo: dia, dia da semana e hora', () => {
  assert.deepEqual(agoraSP(new Date('2026-11-01T10:15:00Z')), { dia: '2026-11-01', semana: 0, hora: 7 });
});

test('domingo antes das 7h, nada; depois, a falha com o motivo da tentativa', () => {
  assert.equal(avisoDasSessoes({ sessoes: falhou, marca: null, agora: domingo(5) }).tipo, null);
  const r = avisoDasSessoes({ sessoes: falhou, marca: null, agora: domingo(7) });
  assert.equal(r.tipo, 'falha');
  assert.match(r.texto, /a rodada automática de 01\/11 às 02:20 falhou \(Cota da Evo esgotada em 3 alunos seguidos\)/);
  assert.match(r.texto, /A rodada manual já está liberada no AQUAP/);
  assert.ok(r.marca.falha_em && r.marca.ciclo === '2026-11-01');
});

test('sem tentativa no ciclo: "não terminou nenhuma rodada desde domingo"', () => {
  const r = avisoDasSessoes({ sessoes: naoRodou, marca: null, agora: domingo(8) });
  assert.equal(r.tipo, 'falha');
  assert.match(r.texto, /nenhuma rodada terminou desde domingo, 02h/);
});

test('a falha sai uma vez por ciclo; a recuperação, uma, depois dela', () => {
  const avisada = avisoDasSessoes({ sessoes: falhou, marca: null, agora: domingo(7) }).marca;
  assert.equal(avisoDasSessoes({ sessoes: falhou, marca: avisada, agora: domingo(9) }).tipo, null);
  const r = avisoDasSessoes({ sessoes: ok, marca: avisada, agora: segunda });
  assert.equal(r.tipo, 'recuperada');
  assert.match(r.texto, /a rodada manual terminou em 02\/11 às 11:30/);
  assert.equal(avisoDasSessoes({ sessoes: ok, marca: r.marca, agora: segunda }).tipo, null);
});

test('semana normal: nada a avisar, e o worker para de perguntar até o próximo ciclo', () => {
  const r = avisoDasSessoes({ sessoes: ok, marca: null, agora: domingo(7) });
  assert.equal(r.tipo, null);
  assert.equal(r.marca.ok_visto, true);
  assert.equal(precisaConferir({ marca: r.marca, agora: segunda }), false);
  assert.equal(precisaConferir({ marca: r.marca, agora: { dia: '2026-11-08', semana: 0, hora: 7 } }), true);
  assert.equal(precisaConferir({ marca: null, agora: domingo(6) }), false);
});
