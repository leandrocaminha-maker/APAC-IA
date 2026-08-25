/**
 * src/lib/logger.js
 * Logger simples com timestamp e nível.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// As chaves acima são minúsculas, e `LOG_LEVEL` costuma ser escrito em
// caixa alta (é assim que o serviço `evolution` recebe o dele no
// docker-compose). Sem o `toLowerCase()`, `LEVELS['WARN']` daria
// `undefined` — e como `0 < undefined` é `false`, o filtro pararia de
// cortar qualquer coisa: o nível pedido seria ignorado e até `debug` sairia
// em produção. O backend hoje não define a variável e roda em `info`, então
// isto é conserto de armadilha, não de sintoma em curso.
//
// Nível desconhecido cai em `info` em vez de virar "loga tudo".
const nivelPedido = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LEVEL = LEVELS[nivelPedido] ?? LEVELS.info;

function log(level, ...args) {
  if (LEVELS[level] < CURRENT_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

export const logger = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
};
