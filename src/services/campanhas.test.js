/**
 * Testes da regulagem de horário da campanha.
 *
 *   node --test src/services/campanhas.test.js
 *
 * Só o que é puro: `distribuirHorarios` e as duas regras de devolução. O
 * resto de `campanhas.js` toca banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campanhaDaAbertura, distribuirHorarios, limiarDoPatamar, perdeuAHora } from './campanhas.js';

// Terça, 14h em São Paulo: sobram 6h30 de janela (fecha 20h30).
const TERCA_14H = new Date('2026-10-13T17:00:00Z');
const MIN = 60_000;
const minutosDepois = (quando) => (quando.getTime() - TERCA_14H.getTime()) / MIN;

test('espalhado: poucas mensagens ocupam o resto do dia', () => {
  for (let i = 0; i < 50; i++) {
    const horarios = distribuirHorarios(3, { agora: TERCA_14H, intervaloMinimoMin: 4 });
    // 390 min / 3 = 130 de base, com ±40%: a primeira nunca sai antes de 78 min.
    assert.ok(horarios.length >= 1 && horarios.length <= 3);
    assert.ok(minutosDepois(horarios[0]) >= 78);
  }
});

test('compacto: as mesmas mensagens saem em seguida, com o piso entre elas', () => {
  for (let i = 0; i < 50; i++) {
    const horarios = distribuirHorarios(3, { agora: TERCA_14H, intervaloMinimoMin: 4, compacto: true });
    assert.equal(horarios.length, 3);

    const minutos = horarios.map(minutosDepois);
    assert.ok(minutos[0] >= 4 && minutos[2] <= 3 * 4 * 1.4 + 0.001, minutos.join(', '));
    for (let j = 1; j < minutos.length; j++) {
      assert.ok(minutos[j] - minutos[j - 1] >= 4 - 0.001, minutos.join(', '));
    }
  }
});

test('compacto não fura a janela: depois das 20h30 nada é agendado', () => {
  const TERCA_20H40 = new Date('2026-10-13T23:40:00Z');
  assert.deepEqual(distribuirHorarios(3, { agora: TERCA_20H40, compacto: true }), []);

  const DOMINGO_14H = new Date('2026-10-18T17:00:00Z');
  assert.deepEqual(distribuirHorarios(3, { agora: DOMINGO_14H, compacto: true }), []);
});

test('campanhaDaAbertura: só abertura de campanha, das duas pistas', () => {
  assert.deepEqual(campanhaDaAbertura('alt:campanha:satisfacao-2026'),
    { slug: 'satisfacao-2026', prefixo: 'alt:campanha:' });
  assert.deepEqual(campanhaDaAbertura('campanha:aqua-anual-2026'),
    { slug: 'aqua-anual-2026', prefixo: 'campanha:' });

  // Link por prazo e resposta fixa são conversa que já existe; apps irmãos
  // não são campanha. Nenhum deles volta para campanha nenhuma.
  for (const origem of ['alt:link:satisfacao-2026', 'alt:auto', 'cobranca', 'alt:campanha:', 'campanha:', '', null, undefined]) {
    assert.equal(campanhaDaAbertura(origem), null, String(origem));
  }
});

test('perdeuAHora: passa da tolerância, e 0 desliga', () => {
  const agora = new Date('2026-10-14T13:00:00Z');
  const minutosAntes = (m) => new Date(agora.getTime() - m * MIN).toISOString();

  assert.equal(perdeuAHora(minutosAntes(5), { agora, toleranciaMin: 20 }), false);
  assert.equal(perdeuAHora(minutosAntes(20), { agora, toleranciaMin: 20 }), false);
  assert.equal(perdeuAHora(minutosAntes(21), { agora, toleranciaMin: 20 }), true);
  // Agendada para a tarde de ontem e ainda na fila.
  assert.equal(perdeuAHora('2026-10-13T19:58:00Z', { agora, toleranciaMin: 20 }), true);
  // No futuro nunca perdeu a hora.
  assert.equal(perdeuAHora('2026-10-14T14:00:00Z', { agora, toleranciaMin: 20 }), false);

  assert.equal(perdeuAHora(minutosAntes(600), { agora, toleranciaMin: 0 }), false);
});

test('sorteio: cada intervalo sai entre o mínimo e o máximo, até a janela fechar', () => {
  const QUINTA_9H = new Date('2026-10-15T12:00:00Z');
  for (let i = 0; i < 50; i++) {
    const horarios = distribuirHorarios(150, { agora: QUINTA_9H, intervaloMinimoMin: 3, intervaloMaximoMin: 5 });
    const minutos = horarios.map(h => (h.getTime() - QUINTA_9H.getTime()) / MIN);

    // 9h–20h30 são 690 min: a 3–5 min cabem de 138 a 150 (o pedido).
    assert.ok(horarios.length >= 138 && horarios.length <= 150, String(horarios.length));
    assert.ok(minutos[0] >= 3 && minutos[0] <= 5);
    for (let j = 1; j < minutos.length; j++) {
      const passo = minutos[j] - minutos[j - 1];
      assert.ok(passo >= 3 - 0.001 && passo <= 5 + 0.001, `${j}: ${passo}`);
    }
    assert.ok(minutos.at(-1) < 690);
  }
});

test('o lote novo começa depois da última abertura que já está na fila', () => {
  const ultima = new Date(TERCA_14H.getTime() + 120 * MIN);   // 16h
  for (let i = 0; i < 50; i++) {
    const sorteado = distribuirHorarios(5, { agora: TERCA_14H, intervaloMinimoMin: 3, intervaloMaximoMin: 5, aPartirDe: ultima });
    assert.ok(minutosDepois(sorteado[0]) >= 123, String(minutosDepois(sorteado[0])));

    const espalhado = distribuirHorarios(5, { agora: TERCA_14H, intervaloMinimoMin: 4, aPartirDe: ultima });
    assert.ok(minutosDepois(espalhado[0]) > 120, String(minutosDepois(espalhado[0])));
  }

  // A última já está depois do fechamento: nada mais cabe hoje.
  const depoisDaJanela = new Date('2026-10-13T23:35:00Z');   // 20h35
  assert.deepEqual(distribuirHorarios(5, { agora: TERCA_14H, intervaloMinimoMin: 3, intervaloMaximoMin: 5, aPartirDe: depoisDaJanela }), []);

  // Uma última no passado não atrasa nada.
  const passada = new Date(TERCA_14H.getTime() - 60 * MIN);
  const h = distribuirHorarios(3, { agora: TERCA_14H, intervaloMinimoMin: 3, intervaloMaximoMin: 5, aPartirDe: passada });
  assert.ok(minutosDepois(h[0]) >= 3 && minutosDepois(h[0]) <= 5);
});

test('com o dia apertado, o intervalo não fica cravado no piso', () => {
  // Sábado 9h: 240 min de janela para 100 — o piso de 4 manda em quase todos.
  const SABADO_9H = new Date('2026-10-17T12:00:00Z');
  const horarios = distribuirHorarios(100, { agora: SABADO_9H, intervaloMinimoMin: 4 });
  const passos = horarios.slice(1).map((h, j) => Math.round((h - horarios[j]) / 1000));
  assert.ok(new Set(passos).size > passos.length / 2, `passos repetidos: ${passos.join(',')}`);
  for (const p of passos) assert.ok(p >= 240 - 1 && p <= 240 * 1.4 + 1, String(p));
});

test('guarda da pesquisa: 10% no começo, 8% a partir de 100, 5% a partir de 150', () => {
  const patamares = [{ aPartirDe: 0, limiar: 0.10 }, { aPartirDe: 100, limiar: 0.08 }, { aPartirDe: 150, limiar: 0.05 }];
  assert.equal(limiarDoPatamar(20, patamares), 0.10);
  assert.equal(limiarDoPatamar(99, patamares), 0.10);
  assert.equal(limiarDoPatamar(100, patamares), 0.08);
  assert.equal(limiarDoPatamar(149, patamares), 0.08);
  assert.equal(limiarDoPatamar(150, patamares), 0.05);
  assert.equal(limiarDoPatamar(553, patamares), 0.05);

  // Primeiro patamar acima de zero: antes dele, não avalia.
  assert.equal(limiarDoPatamar(30, [{ aPartirDe: 50, limiar: 0.10 }]), null);
  assert.equal(limiarDoPatamar(30, []), null);
});
