/**
 * src/workers/carteira-treinos-worker.js
 * Lê no EVO o treino de musculação de cada aluno da carteira (migration 023),
 * uma vez por dia por aluno, em lotes. Só leitura: nada sai ao WhatsApp.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { atualizarCarteira } from '../services/acompanhamento/carteira-treinos.js';

async function ciclo() {
  try {
    await atualizarCarteira({ limite: config.carteiraTreinos.porCiclo });
  } catch (err) {
    logger.error('[carteira-treinos] Ciclo falhou:', err.message);
  }
}

export function startCarteiraTreinosWorker() {
  const c = config.carteiraTreinos;
  if (!(c.minutos > 0)) {
    logger.info('[carteira-treinos] Leitura da carteira de treinos desligada');
    return;
  }
  logger.info(`[carteira-treinos] Leitura dos treinos a cada ${c.minutos} min, até ${c.porCiclo} por ciclo`);
  setTimeout(ciclo, 60_000);
  setInterval(ciclo, c.minutos * 60_000);
}
