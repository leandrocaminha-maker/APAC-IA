/**
 * Testes da regulagem de horário da campanha.
 *
 *   node --test src/services/campanhas.test.js
 *
 * Só `distribuirHorarios`, que é pura. O resto de `campanhas.js` toca banco.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribuirHorarios } from './campanhas.js';

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
