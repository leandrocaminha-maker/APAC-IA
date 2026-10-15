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
import { campanhaDaAbertura, distribuirHorarios, perdeuAHora } from './campanhas.js';

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
