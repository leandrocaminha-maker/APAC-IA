/**
 * src/workers/evo-sync-worker.js
 * Mantém o funil em dia com o EVO sem depender de alguém clicar.
 *
 * Faz duas coisas, em ciclos:
 *
 * 1. **Reprocessa webhooks que falharam.** O envelope do EVO é guardado
 *    assim que chega, mas interpretá-lo exige buscar o detalhe atrás do
 *    `ApiCallback` — e essa segunda chamada pode falhar. Sem reprocesso,
 *    uma venda registrada durante uma instabilidade do EVO ficava para
 *    sempre como evento pendente, e o lead nunca virava "ganho".
 *
 * 2. **Varre os prospects vinculados.** Esta é a parte que não tem
 *    alternativa: **o EVO não emite evento de mudança de prospect.** Não
 *    existe webhook para "o consultor mudou a etapa", "converteu na
 *    recepção" ou "marcou a aula pelo balcão". Sem este poller, tudo o
 *    que acontece dentro do EVO é invisível para o painel — e o funil
 *    passa a mentir por omissão.
 *
 * Só olha leads que já têm `evo_id_prospect` e ainda estão abertos: o
 * funil é do que a Leia e o painel tocam, não uma cópia da base de 46 mil
 * prospects da academia.
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { evoSync } from '../services/evo-sync.js';

let rodando = false;

async function ciclo() {
  // Um ciclo por vez. Se o EVO estiver lento, o intervalo pode disparar
  // de novo antes do anterior terminar, e dois pollers concorrentes
  // escrevendo no mesmo lead produzem eventos duplicados no razão.
  if (rodando) {
    logger.debug('[evo-sync-worker] Ciclo anterior ainda rodando — pulando');
    return;
  }
  rodando = true;

  try {
    const reproc = await evoSync.reprocessarPendentes(25);
    if (reproc.total) {
      logger.info(`[evo-sync-worker] Webhooks reprocessados: ${reproc.processados} ok, ${reproc.falhas} falhas`);
    }

    await evoSync.sincronizarProspects({ dias: 30 });
  } catch (err) {
    logger.error('[evo-sync-worker] Ciclo falhou:', err.message);
  } finally {
    rodando = false;
  }
}

/**
 * Liga o worker.
 *
 * Confere as tabelas antes de agendar: com a migration 002 não aplicada,
 * cada ciclo viraria um par de erros no log a cada N minutos, escondendo
 * o problema real atrás de ruído.
 */
export async function startEvoSyncWorker() {
  const minutos = config.evo.syncMinutos;

  if (!config.crm.habilitado || minutos <= 0) {
    logger.info('[evo-sync-worker] Desligado (EVO_SYNC_MINUTOS=0 ou CRM desabilitado)');
    return;
  }

  const { error } = await supabase.from('crm_leads').select('id').limit(1);
  if (error) {
    logger.warn('[evo-sync-worker] Não iniciado: as tabelas do CRM ainda não respondem. ' +
      'Rode a migration 002 e reinicie o serviço.');
    return;
  }

  logger.info(`[evo-sync-worker] Iniciado (ciclo a cada ${minutos} min)`);

  // Primeiro ciclo com folga: no boot o container ainda está subindo e o
  // EVO não é urgente.
  setTimeout(ciclo, 60_000);
  setInterval(ciclo, minutos * 60_000);
}
