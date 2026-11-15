import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarFilaEspacada } from './fila-espacada.js';

/** Fila com relógio de mentira: `dormir` só adianta o relógio e cede a vez. */
function filaDeTeste(opcoes = {}) {
  let t = 0;
  const saidas = [];
  const fila = criarFilaEspacada({
    espacamentoSeg: () => 60,
    sortear: (seg) => seg * 1000,
    dormir: async (ms) => { t += ms; await new Promise(r => setImmediate(r)); },
    ...opcoes,
  });
  const tarefa = (nome, enviou = true) => async () => { saidas.push({ nome, em: t }); return enviou; };
  return { fila, tarefa, saidas };
}

const assentar = () => new Promise(r => setTimeout(r, 20));

test('23 turnos atrasados saem um por minuto, e não juntos', async () => {
  const { fila, tarefa, saidas } = filaDeTeste();
  for (let i = 0; i < 23; i++) fila.entrar(`c${i}`, tarefa(`c${i}`));
  await assentar();

  assert.equal(saidas.length, 23);
  assert.deepEqual(saidas.slice(0, 3).map(s => s.em), [0, 60_000, 120_000]);
  assert.equal(saidas[22].em, 22 * 60_000);
});

test('a mesma conversa não entra duas vezes', async () => {
  const { fila, tarefa, saidas } = filaDeTeste();
  assert.equal(fila.entrar('a', tarefa('a')), true);
  assert.equal(fila.entrar('b', tarefa('b')), true);
  assert.equal(fila.entrar('b', tarefa('b de novo')), false);
  await assentar();
  assert.deepEqual(saidas.map(s => s.nome), ['a', 'b']);
});

test('quem sai da fila não roda', async () => {
  const { fila, tarefa, saidas } = filaDeTeste();
  fila.entrar('a', tarefa('a'));
  fila.entrar('b', tarefa('b'));
  fila.entrar('c', tarefa('c'));
  assert.equal(fila.tem('b'), true);
  fila.sair('b');
  await assentar();
  assert.deepEqual(saidas.map(s => s.nome), ['a', 'c']);
});

test('turno que não enviou nada não cobra intervalo do próximo', async () => {
  const { fila, tarefa, saidas } = filaDeTeste();
  fila.entrar('humano', tarefa('humano', false));
  fila.entrar('b', tarefa('b'));
  fila.entrar('c', tarefa('c'));
  await assentar();
  assert.deepEqual(saidas.map(s => s.em), [0, 0, 60_000]);
});

test('com a sessão fora do ar a fila espera, e anda quando volta', async () => {
  let conectado = false;
  let sondagens = 0;
  const { fila, tarefa, saidas } = filaDeTeste({
    podeRodar: () => { sondagens++; if (sondagens > 3) conectado = true; return conectado; },
  });
  fila.entrar('a', tarefa('a'));
  await assentar();
  assert.equal(saidas.length, 1);
  assert.equal(saidas[0].em, 3 * 30_000);
});

test('tarefa que falha não trava a fila', async () => {
  const falhas = [];
  const { fila, tarefa, saidas } = filaDeTeste({ aoFalhar: (chave, err) => falhas.push([chave, err.message]) });
  fila.entrar('a', async () => { throw new Error('boom'); });
  fila.entrar('b', tarefa('b'));
  await assentar();
  assert.deepEqual(falhas, [['a', 'boom']]);
  assert.deepEqual(saidas.map(s => s.nome), ['b']);
  assert.equal(saidas[0].em, 60_000);
});
