/**
 * src/workers/avaliacao-worker.js
 * Solta os avisos da avaliação física que chegaram à hora.
 *
 * Um setInterval dentro do servidor, no molde dos outros workers. Quem
 * marca os avisos é o webhook do EVO (a compra e as automações); aqui só
 * sai o que já está marcado, dentro da janela de contato. Com
 * `AVALIACAO_AVISOS_ENVIO=false` (o padrão) eles saem como 'simulado':
 * ver `services/avaliacao-avisos.js`.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { enviarAvisos } from '../services/avaliacao-avisos.js';

async function ciclo() {
  try {
    const n = await enviarAvisos();
    if (n) logger.info(`[avaliacao] ${n} aviso(s) ${config.avaliacao.envio ? 'enviado(s)' : 'simulado(s)'}`);
  } catch (err) {
    logger.error('[avaliacao] Ciclo falhou:', err.message);
  }
}

export function startAvaliacaoWorker() {
  const c = config.avaliacao;
  if (!c.habilitado || !(c.minutos > 0)) {
    logger.info('[avaliacao] Avisos da avaliação desligados');
    return;
  }
  logger.info(`[avaliacao] Avisos da avaliação a cada ${c.minutos} min — ${c.envio ? 'ENVIO REAL' : 'simulação'}`);
  setTimeout(ciclo, 30_000);
  setInterval(ciclo, c.minutos * 60_000);
}
