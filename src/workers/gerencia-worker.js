/**
 * src/workers/gerencia-worker.js
 * Os avisos do painel gerencial por WhatsApp, de tempos em tempos.
 *
 * Cada ciclo pergunta a `gerencia.avisar()` o que é novo — situação que
 * pede o gerente, aula experimental que casa uma regra da coordenação — e
 * manda uma mensagem por pessoa. Quem decide se avisa, a quem e em que
 * horário é a configuração do painel; com ela desligada (o padrão), o
 * ciclo não faz nada além de ler a configuração.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { gerencia } from '../services/gerencia.js';

let rodando = false;

async function ciclo() {
  if (rodando) return;
  rodando = true;
  try {
    const r = await gerencia.avisar();
    if (r.enviados) logger.info(`[gerencia-worker] Ciclo: ${r.enviados} aviso(s)`);
  } catch (err) {
    logger.error('[gerencia-worker] Ciclo falhou:', err.message);
  } finally {
    rodando = false;
  }
}

export function startGerenciaWorker() {
  const minutos = parseInt(process.env.GERENCIA_MINUTOS || '10', 10);
  if (!config.crm.habilitado || minutos <= 0) {
    logger.info('[gerencia-worker] Desligado (GERENCIA_MINUTOS=0 ou CRM desabilitado)');
    return;
  }
  logger.info(`[gerencia-worker] Iniciado (ciclo a cada ${minutos} min; os avisos ligam e desligam no painel)`);
  setTimeout(ciclo, 120_000);
  setInterval(ciclo, minutos * 60_000);
}
