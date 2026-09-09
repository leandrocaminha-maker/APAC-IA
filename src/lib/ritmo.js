/**
 * src/lib/ritmo.js
 * Espaçamento entre envios, com folga aleatória.
 *
 * Cadência regular é o que distingue robô de pessoa para quem analisa o
 * comportamento do número — e era literalmente o que este sistema fazia:
 * `RATE_LIMIT_MS = 1_000` cravado na fila, e nenhum intervalo no worker de
 * follow-up. Dez mensagens a exatamente um segundo uma da outra não
 * acontecem por acaso.
 *
 * `distribuirHorarios`, em `campanhas.js`, já fazia isso certo para o
 * AGENDAMENTO da campanha. Este módulo é a mesma ideia no momento do
 * ENVIO, onde faltava.
 */

/** Dorme `ms` milissegundos. */
export function dormir(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

/**
 * Um intervalo em milissegundos com variação de ±`jitter` sobre a base.
 *
 * @param {number} baseSegundos - Intervalo médio desejado.
 * @param {number} [jitter] - Fração de variação (0.4 = ±40%).
 */
export function folgaMs(baseSegundos, jitter = 0.4) {
  const variacao = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.round(baseSegundos * 1000 * variacao);
}

/** Espera um intervalo com folga. Atalho de `dormir(folgaMs(...))`. */
export function esperar(baseSegundos, jitter = 0.4) {
  return dormir(folgaMs(baseSegundos, jitter));
}

export const ritmo = { dormir, folgaMs, esperar };
