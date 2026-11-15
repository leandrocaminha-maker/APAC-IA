import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  instanteDaMensagem, atrasoEmMinutos, ehAtrasada, motivoParaSegurar, haQuantoTempo, contextoDoAtraso,
} from './resposta-regras.js';

test('lê o messageTimestamp nos formatos em que a Evolution entrega', () => {
  const esperado = '2026-11-13T18:20:00.000Z';
  const seg = Date.parse(esperado) / 1000;
  assert.equal(instanteDaMensagem(seg).toISOString(), esperado);
  assert.equal(instanteDaMensagem(String(seg)).toISOString(), esperado);
  assert.equal(instanteDaMensagem({ low: seg, high: 0, unsigned: true }).toISOString(), esperado);
  assert.equal(instanteDaMensagem(seg * 1000).toISOString(), esperado);
});

test('sem hora legível, devolve null (e a mensagem segue como nova)', () => {
  for (const v of [undefined, null, '', 'ontem', 0, -5, {}, NaN]) {
    assert.equal(instanteDaMensagem(v), null);
  }
  assert.equal(atrasoEmMinutos(null), 0);
});

test('atraso em minutos, sem valor negativo para relógio adiantado', () => {
  const agora = new Date('2026-11-14T14:54:00Z');
  assert.equal(atrasoEmMinutos(new Date('2026-11-14T14:53:30Z'), agora), 0.5);
  assert.equal(atrasoEmMinutos(new Date('2026-11-13T14:54:00Z'), agora), 1440);
  assert.equal(atrasoEmMinutos(new Date('2026-11-14T14:55:00Z'), agora), 0);
});

test('atrasada é acima do limiar; limiar 0 desliga', () => {
  assert.equal(ehAtrasada(0.2, 10), false);
  assert.equal(ehAtrasada(10, 10), false);
  assert.equal(ehAtrasada(10.1, 10), true);
  assert.equal(ehAtrasada(1440, 0), false);
});

test('turno atrasado é segurado, haja ou não movimento', () => {
  assert.equal(motivoParaSegurar({ atrasada: true, iniciosRecentes: [], agora: 0, rajadaMax: 6 }), 'atrasada');
});

test('turno novo sai na hora até o teto do minuto, e depois é segurado', () => {
  const agora = 100_000;
  const cinco = [60_000, 70_000, 80_000, 90_000, 95_000];
  assert.equal(motivoParaSegurar({ atrasada: false, iniciosRecentes: cinco, agora, rajadaMax: 6 }), null);
  assert.equal(motivoParaSegurar({ atrasada: false, iniciosRecentes: [...cinco, 99_000], agora, rajadaMax: 6 }), 'rajada');
  // Início de mais de um minuto atrás não conta.
  assert.equal(motivoParaSegurar({ atrasada: false, iniciosRecentes: [10_000, ...cinco], agora, rajadaMax: 6 }), null);
  // 0 desliga.
  assert.equal(motivoParaSegurar({ atrasada: false, iniciosRecentes: [...cinco, 99_000], agora, rajadaMax: 0 }), null);
});

test('o tempo de atraso em palavras', () => {
  assert.equal(haQuantoTempo(12), 'há 12 minutos');
  assert.equal(haQuantoTempo(89), 'há 89 minutos');
  assert.equal(haQuantoTempo(23.3 * 60), 'há cerca de 23 horas');
  assert.equal(haQuantoTempo(72 * 60), 'há 3 dias');
});

test('o aviso à Leia diz quando a pessoa escreveu, no horário de Brasília', () => {
  const texto = contextoDoAtraso({
    enviadaEm: new Date('2026-11-13T18:20:00Z'),
    agora: new Date('2026-11-14T14:55:00Z'),
  }).join('\n');
  assert.match(texto, /MENSAGEM QUE CHEGOU ATRASADA/);
  assert.match(texto, /há cerca de 21 horas/);
  assert.match(texto, /sexta-feira, 13\/11, às 15:20/);
  assert.match(texto, /desculpas pela demora/);
});
