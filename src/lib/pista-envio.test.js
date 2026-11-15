import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarPista, esperaMs } from './pista-envio.js';

test('sem envio anterior, sai na hora', () => {
  assert.equal(esperaMs({ agora: 1000, ultimoFim: null, intervaloMs: 4000, saidas: [], maxPorMinuto: 6 }), 0);
});

test('respeita o piso desde o fim do envio anterior', () => {
  assert.equal(esperaMs({ agora: 10_000, ultimoFim: 9_000, intervaloMs: 4000, saidas: [9_000], maxPorMinuto: 6 }), 3000);
  assert.equal(esperaMs({ agora: 20_000, ultimoFim: 9_000, intervaloMs: 4000, saidas: [9_000], maxPorMinuto: 6 }), 0);
});

test('com o minuto cheio, espera o mais antigo sair da janela', () => {
  const saidas = [0, 5_000, 10_000, 15_000, 20_000, 25_000];
  // O 7º só cabe quando o de t=0 fizer um minuto.
  assert.equal(esperaMs({ agora: 30_000, ultimoFim: 25_000, intervaloMs: 4000, saidas, maxPorMinuto: 6 }), 30_000);
  // Com 7 no minuto, quem libera é o segundo mais antigo.
  assert.equal(
    esperaMs({ agora: 31_000, ultimoFim: 30_000, intervaloMs: 0, saidas: [...saidas, 30_000], maxPorMinuto: 6 }),
    34_000,
  );
});

test('teto 0 desliga o limite por minuto', () => {
  const saidas = Array.from({ length: 30 }, (_, i) => i * 1000);
  assert.equal(esperaMs({ agora: 30_000, ultimoFim: 29_000, intervaloMs: 0, saidas, maxPorMinuto: 0 }), 0);
});

/** Pista com relógio de mentira: `dormir` só adianta o relógio. */
function pistaDeTeste({ intervalo = 4, max = 6, duracaoMs = 0 } = {}) {
  let t = 0;
  const pista = criarPista({
    intervaloSeg: () => intervalo,
    maxPorMinuto: () => max,
    agora: () => t,
    dormir: async (ms) => { t += ms; },
    sortear: (seg) => seg * 1000,
  });
  const saidas = [];
  const enviar = (nome, opts) => pista.passar(async () => {
    saidas.push({ nome, em: t });
    t += duracaoMs;
    return nome;
  }, opts);
  return { pista, enviar, saidas, relogio: () => t };
}

test('a rajada de 14/11: 23 respostas de uma vez não saem em 36 segundos', async () => {
  const { enviar, saidas } = pistaDeTeste({ duracaoMs: 8000 });
  await Promise.all(Array.from({ length: 23 }, (_, i) => enviar(`r${i}`)));

  assert.equal(saidas.length, 23);
  // Um de cada vez: 8 s digitando + 4 s de piso entre um e outro.
  for (let i = 1; i < saidas.length; i++) {
    assert.ok(saidas[i].em - saidas[i - 1].em >= 12_000, `envio ${i} saiu cedo demais`);
  }
  // E nunca mais de 6 terminando dentro de um mesmo minuto.
  const fins = saidas.map(s => s.em + 8000);
  for (let i = 6; i < fins.length; i++) {
    assert.ok(fins[i] - fins[i - 6] >= 60_000 - 8000, 'mais de 6 envios num minuto');
  }
});

test('mensagem curta também obedece o teto por minuto', async () => {
  const { enviar, saidas } = pistaDeTeste({ intervalo: 1, duracaoMs: 0 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => enviar(`m${i}`)));
  // 6 no primeiro minuto, a 1 s; o 7º só depois de o primeiro fazer um minuto.
  assert.equal(saidas[5].em, 5000);
  assert.equal(saidas[6].em, 60_000);
  assert.equal(saidas[7].em, 61_000);
});

test('prioridade alta passa na frente de quem está esperando', async () => {
  const { enviar, saidas } = pistaDeTeste({ duracaoMs: 1000 });
  const todos = [enviar('a'), enviar('b'), enviar('c'), enviar('consultor', { prioridade: 'alta' })];
  await Promise.all(todos);
  // 'a' já estava saindo quando o consultor entrou; ele passa 'b' e 'c'.
  assert.deepEqual(saidas.map(s => s.nome), ['a', 'consultor', 'b', 'c']);
});

test('falha de um envio não trava a pista, e conta no intervalo', async () => {
  const { pista, enviar, saidas } = pistaDeTeste();
  const falha = pista.passar(async () => { throw new Error('Connection Closed'); });
  const depois = enviar('depois');
  await assert.rejects(falha, /Connection Closed/);
  assert.equal(await depois, 'depois');
  assert.equal(saidas[0].em, 4000);
});

test('quem envia fica sabendo quanto esperou', async () => {
  let t = 0;
  const pista = criarPista({
    intervaloSeg: () => 10, maxPorMinuto: () => 0,
    agora: () => t, dormir: async (ms) => { t += ms; }, sortear: (s) => s * 1000,
  });
  await pista.passar(async () => {});
  const info = await pista.passar(async (i) => i);
  assert.equal(info.esperouMs, 10_000);
});
